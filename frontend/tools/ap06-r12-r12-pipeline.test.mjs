import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,rmSync,statSync,realpathSync} from 'node:fs';
import {join,dirname,resolve,sep} from 'node:path';
import {spawn} from 'node:child_process';
import {EventEmitter,once} from 'node:events';
import {runFactorialProbe} from './ap06-r12-r2-probe.mjs';
import {newR12Counters} from './ap06-r12-contract.mjs';
import {transportCounts} from './ap06-r12-r2-contract.mjs';
import {AUTOPLAY_ARGS,NATIVE_ARGS,launchAttestedBrowser} from './ap06-browser-identity.mjs';
import {writeJsonAtomic} from './browser-memory-probe.mjs';

// The real producer and Win32 lease run; only browser/CDP/page execution and its clock are simulated.
test('R12 real measurement producer reaches complete Python consumers',
  {skip:process.platform!=='win32'||!process.env.AP06_R12_SIMULATION},async t=>{
    const data=JSON.parse(readFileSync(process.env.AP06_R12_SIMULATION,'utf8'));
    const identity=JSON.parse(readFileSync(data.identity,'utf8')),original={...process.env};
    const roles=['browser','renderer','GPU','network.mojom.NetworkService'];
    const runtime=JSON.parse(readFileSync(process.env.AP06_R8_PRIVATE_CONFIG,'utf8'));
    const mapping=JSON.parse(process.env.AP06_R8_FILE_MAPPING),base='http://127.0.0.1:42187';
    const results=[];
    Object.assign(process.env,{AP06_BROWSER_IDENTITY:data.identity,AP06_R5_CHROMIUM_VERSION:identity.chromiumVersion,
      TEMP:identity.launchProtocol.profileRoot,TMP:identity.launchProtocol.profileRoot,
      AP06_BROWSER_TEMP_ROOT:identity.launchProtocol.profileRoot,AP06_R5_PROCESS_HANDLE_AUDIT:'1'});
    try{
      for(const scenario of data.scenarios){
        const children=[];let counters,context,network,request=0,token;
        const directory=join(data.output,scenario.name);mkdirSync(directory);
        process.env.AP06_R5_ARTIFACT_DIR=directory;process.env.AP06_R5_STAGE=scenario.stage;
        process.env.AP06_R6_CONDITION=scenario.condition;process.env.AP06_R12R2_ATTEMPT=scenario.runId;
        const selected=data.conditions[scenario.condition];
        const stop=async child=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}};
        const cdp=()=>{
          const session=new EventEmitter();session.detach=async()=>{};
          session.send=async method=>{
            if(method==='SystemInfo.getProcessInfo')return {processInfo:children.map((child,i)=>({id:child.pid,type:roles[i]}))};
            if(method==='Browser.getVersion')return {product:'HeadlessShell/'+identity.chromiumVersion};
            if(method==='Runtime.getHeapUsage')return {usedSize:1,totalSize:2,embedderHeapUsedSize:0,backingStorageSize:0};
            if(method==='Memory.getDOMCounters')return {documents:1,nodes:1,jsEventListeners:0};
            if(method==='Performance.getMetrics')return {metrics:[{name:'JSHeapUsedSize',value:1},{name:'JSHeapTotalSize',value:2},{name:'LayoutObjects',value:1}]};
            if(['Performance.enable','Network.enable','HeapProfiler.collectGarbage'].includes(method))return {};
            throw new Error('R12_TEST_UNEXPECTED_CDP_METHOD');
          };return session;
        };
        const http=async(url,method='GET',body=null,range=null,type='XHR')=>{
          assert.ok(!context.blocker.test(url));context.emit('request',{url:()=>url});
          const requestId=String(++request),headers={...(range?{Range:range}:{}),...(token?{Authorization:'Bearer '+token}:{}),
            ...(body?{'Content-Type':'application/json'}:{})};
          network.emit('Network.requestWillBeSent',{requestId,request:{url,method,headers:range?{Range:range}:{}},type});
          const response=await fetch(url,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
          const responseHeaders=Object.fromEntries(response.headers);
          network.emit('Network.responseReceived',{requestId,type,response:{status:response.status,headers:responseHeaders,fromDiskCache:false,fromServiceWorker:false}});
          let bytes=0,text='';
          for await(const chunk of response.body){bytes+=chunk.length;if(body)text+=Buffer.from(chunk).toString('utf8');}
          network.emit('Network.loadingFinished',{requestId,encodedDataLength:bytes});
          assert.equal(response.status,range?206:200);
          if(range){
            assert.equal(bytes,Number(responseHeaders['content-length']));
            const observed=counters.observed;observed.rangeRequestsStarted++;observed.rangeRequestsCompleted++;
            observed.rangeBytesReceived+=bytes;observed.http206Validated++;observed.jwtRangesValidated++;
          }
          return body?JSON.parse(text):null;
        };
        const page=new EventEmitter();page.addInitScript=async()=>{};page.goto=async url=>{const r=await fetch(url);assert.equal(r.status,200);await r.body.cancel();};
        page.waitForTimeout=async ms=>{t.mock.timers.tick(ms);};
        page.evaluate=async(fn,arg)=>{
          if(arg?.counters){counters=arg.counters;counters.r12r2=newR12Counters();counters.routing=transportCounts(scenario.condition,0);return;}
          if(Array.isArray(arg))return arg.map(codec=>({codec,supported:true}));
          if(arg?.fixture){
            const id=arg.fixture.id;
            for(const [fixture,range] of data.ranges.filter(([fixture])=>fixture===id)){
              await http(`${base}/files/${mapping[fixture].fileId}/download`,'GET',null,range,
                selected[range==='bytes=0-131071'?'metadata':'payload']==='xhr'?'XHR':'Fetch');
            }
            const c=counters.r12r2;c.sessionsStarted++;c.sessionsCompleted++;c.metadataCompleted++;c.metadataBytes+=131072;
            c.payloadBlobCount+=2;c.payloadBlobBytes+=8388640;c.completedOperations+=3;
            counters.observed.metadataRequests++;counters.routing=transportCounts(scenario.condition,c.sessionsCompleted);return;
          }
          if(String(fn).includes('counters:'))return {counters:structuredClone(counters),mediaNodes:0};
        };
        const browserType={launch:async options=>{
          const profile=join(identity.launchProtocol.profileRoot,'playwright_chromiumdev_profile-measurement');mkdirSync(profile);
          for(const role of roles){
            const child=spawn(identity.executablePath,[...identity.launchProtocol.fixedArgs,...options.args,
              '--user-data-dir='+profile,...identity.launchProtocol.suffixArgs],{windowsHide:true,stdio:'ignore'});
            children.push(child);await once(child,'spawn');
          }
          context=new EventEmitter();context.route=async pattern=>{context.blocker=pattern;};
          context.newPage=async()=>page;context.newCDPSession=async()=>{const s=cdp();network??=s;return s;};
          return {version:()=>identity.chromiumVersion,newContext:async()=>context,newBrowserCDPSession:async()=>cdp(),
            close:async()=>{
              await Promise.all(children.map(stop));
              assert.ok(realpathSync(profile).startsWith(realpathSync(resolve(import.meta.dirname,'../..'))+sep));
              assert.equal(dirname(realpathSync(profile)),realpathSync(identity.launchProtocol.profileRoot));
              rmSync(profile,{recursive:true,force:true});}};
        }};
        t.mock.timers.enable({apis:['Date'],now:Date.now()});
        try{
          await runFactorialProbe({browserType,identityResolver:async()=>identity,
            launchOptions:{args:[...AUTOPLAY_ARGS,...(scenario.native?NATIVE_ARGS:[])]},
            initialize:async()=>{
              token=(await http(base+'/login','POST',{username:runtime.username,password:runtime.password})).token;
              assert.ok(token);await http(base+'/tree?file_limit=100&file_offset=0');await http(base+'/pending-uploads');return data.proof;
            },beforeRun:async()=>{},afterRun:async(raw,path)=>{raw.syntheticContractFixture=true;writeJsonAtomic(path,raw);}});
          const path=join(directory,'crypto-transmux-mse.raw.json'),raw=JSON.parse(readFileSync(path,'utf8'));
          assert.equal(raw.runs[0].functionalStatus,'PASS');assert.equal(raw.runs[0].cleanupStatus,'PASS');
          assert.equal(raw.runs[0].samples.length,11);assert.equal(raw.runs[0].processExitAudit.closedProcessCount,4);
          assert.equal(raw.runs[0].handleRelease.status,'PASS');assert.equal(raw.launchAttempts,1);assert.equal(raw.browserLaunches,1);
          results.push({name:scenario.name,path,bytes:statSync(path).size});
        }finally{t.mock.timers.reset();await Promise.all(children.map(stop));token=null;}
      }
      writeFileSync(data.result,JSON.stringify({status:'PASS',producer:'runFactorialProbe/runTransmuxProbe',
        scenarios:results,realWindowsHandles:true,realAuthenticatedBackendRanges:true,simulatedBrowserCdp:true,scientificChromium:0}));
    }finally{
      runtime.username='';runtime.password='';
      for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);
    }
  });

test('R12 requires an identity manifest before any browser launch',async()=>{
  const old=process.env.AP06_BROWSER_IDENTITY,root=process.env.AP06_EXPERIMENT_ROOT;let calls=0;
  try{
    delete process.env.AP06_BROWSER_IDENTITY;
    for(const number of [3,10,11,12]){
      process.env.AP06_EXPERIMENT_ROOT=`.quality/readiness-wave12-r${number}-factorial`;
      await assert.rejects(launchAttestedBrowser({launch:async()=>{calls++;}}, {args:[]},{}),/AP06_BROWSER_IDENTITY_MISMATCH/);
    }
    assert.equal(calls,0);
  }finally{
    if(old===undefined)delete process.env.AP06_BROWSER_IDENTITY;else process.env.AP06_BROWSER_IDENTITY=old;
    if(root===undefined)delete process.env.AP06_EXPERIMENT_ROOT;else process.env.AP06_EXPERIMENT_ROOT=root;
  }
});
