import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {chromium} from '@playwright/test';
import {frozenLaunchOptions,validateResolution,resolveBrowserIdentity,AUTOPLAY_ARGS,NATIVE_ARGS,launchWithIdentityLease,getAttestedBrowserProof,launchAttestedBrowser} from './ap06-browser-identity.mjs';
import {NativeTrace} from './ap06-native-trace.mjs';

const identity={mode:'headless-shell',executablePath:'C:/owned/chrome-headless-shell.exe',executableSha256:'a'.repeat(64),
  launchProtocol:{allowedExperimentalArgs:[[...AUTOPLAY_ARGS],[...AUTOPLAY_ARGS,...NATIVE_ARGS]]}};
test('Playwright selects the frozen shell path without assuming --headless',()=>{
  assert.deepEqual(frozenLaunchOptions(identity,AUTOPLAY_ARGS),{executablePath:identity.executablePath,headless:false,args:[...AUTOPLAY_ARGS]});
  for(const bad of [null,{}, {...identity,mode:'chromium'}, {...identity,executableSha256:'bad'}])assert.throws(()=>frozenLaunchOptions(bad,AUTOPLAY_ARGS));
  assert.throws(()=>frozenLaunchOptions(identity,['--memlog=all']));
});
test('installation, version, protocol and executable substitution reject before launch',()=>{
  const expected={...identity,playwrightVersion:'1.62.1',registryDirectory:'C:/cache',installationDirectory:'C:/cache/shell',playwrightPackageSha256:'b'.repeat(64)};
  validateResolution(expected,expected);
  for(const key of Object.keys(expected))assert.throws(()=>validateResolution(expected,{...expected,[key]:'changed'}));
});
test('frozen launch arguments match the installed Playwright defaults without starting a browser',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ap06-launch-protocol-'));
  const keys=['TEMP','TMP','AP06_BROWSER_TEMP_ROOT','AP06_IDENTITY_PYTHON','WAVE1_PYTHON'],old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try{
    process.env.TEMP=root;process.env.TMP=root;process.env.AP06_BROWSER_TEMP_ROOT=root;
    const py=process.env.AP06_IDENTITY_PYTHON||process.env.WAVE1_PYTHON||execFileSync('py',['-3','-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
    process.env.AP06_IDENTITY_PYTHON=py;
    const identity=await resolveBrowserIdentity(),impl=chromium._connection.toImpl(chromium),placeholder=join(root,'playwright_chromiumdev_profile-AP06_PROTOCOL');
    const defaults=await impl.defaultArgs({headless:false,args:[]},false,placeholder),profileArg=`--user-data-dir=${placeholder}`,index=defaults.indexOf(profileArg);
    assert.ok(index>0);assert.deepEqual(identity.launchProtocol.fixedArgs,defaults.slice(0,index));
    assert.deepEqual(identity.launchProtocol.suffixArgs,defaults.slice(index+1));
    assert.ok(!identity.launchProtocol.fixedArgs.some(arg=>arg==='--headless'));
  }finally{
    for(const key of keys){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}
    rmSync(root,{recursive:true,force:true});
  }
});
test('every campaign caller uses one shared identity gate and persists launch after launch returns',()=>{
  for(const name of ['ap06-transmux-probe.mjs','ap06-r12-preflight.mjs','ap06-native-capability.mjs']){
    const code=readFileSync(new URL(name,import.meta.url),'utf8');
    assert.match(code,/launchAttestedBrowser\(chromium/); assert.doesNotMatch(code,/chromium\.launch\(/);
    assert.match(code,/finishBrowserIdentity/);
  }
  const gate=readFileSync(new URL('ap06-browser-identity.mjs',import.meta.url),'utf8');
  assert.ok(gate.indexOf('onBrowserLaunched(browser);')<gate.lastIndexOf('const attested=await attestBrowserProcess(browser'));
  for(const name of ['ap06-browser-identity.mjs','ap06-native-trace.mjs'])
    assert.doesNotMatch(readFileSync(new URL(name,import.meta.url),'utf8'),/Browser\.getBrowserCommandLine/);
});
test('R3 and R4 cannot launch without their pre-registered identity manifest',async()=>{
  const old=process.env.AP06_EXPERIMENT_ROOT,manifest=process.env.AP06_BROWSER_IDENTITY;
  for(const root of ['.quality/readiness-wave12-r3-factorial','.quality/readiness-wave12-r4-factorial']){
    process.env.AP06_EXPERIMENT_ROOT=root;delete process.env.AP06_BROWSER_IDENTITY;let launched=false;
    try{await assert.rejects(launchAttestedBrowser({launch:()=>{launched=true;}},{args:AUTOPLAY_ARGS},{}));assert.equal(launched,false);}
    finally{if(manifest!==undefined)process.env.AP06_BROWSER_IDENTITY=manifest;else delete process.env.AP06_BROWSER_IDENTITY;}
  }
  if(old===undefined)delete process.env.AP06_EXPERIMENT_ROOT;else process.env.AP06_EXPERIMENT_ROOT=old;
  const probe=readFileSync(new URL('ap06-transmux-probe.mjs',import.meta.url),'utf8');
  assert.ok(probe.indexOf('await launchAttestedBrowser')<probe.indexOf('await page.goto(origin)'));
  const preflight=readFileSync(new URL('ap06-r12-preflight.mjs',import.meta.url),'utf8');
  assert.ok(preflight.indexOf('await launchAttestedBrowser')<preflight.indexOf('await page.goto(origin)'));
});
test('Windows CDP simulation attests a disposable real process and starts native trace only with OS-proved flags',
  {skip:process.platform!=='win32'},async()=>{
    const root=mkdtempSync(join(tmpdir(),'ap06-identity-integration-')),profileRoot=join(root,'profiles');mkdirSync(profileRoot);
    const shell=join(root,'chrome-headless-shell.exe'),script='setInterval(()=>{},1000)',profile=join(profileRoot,'playwright_chromiumdev_profile-test1234');
    copyFileSync(process.execPath,shell);
    const configuredPython=process.env.AP06_IDENTITY_PYTHON||process.env.WAVE1_PYTHON;
    const python=configuredPython||execFileSync('py',['-3','-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
    const pyPrefix=python.toLowerCase().endsWith('py.exe')?['-3']:[];
    const helper=fileURLToPath(new URL('../../tools/quality/ap06_browser_identity.py',import.meta.url));
    const observed=JSON.parse(execFileSync(python,[...pyPrefix,helper,'--inspect',shell],{encoding:'utf8',windowsHide:true}));
    const fixedArgs=['-e',script,'--'],suffixArgs=['--remote-debugging-pipe','--no-startup-window'];
    const launchProtocol={fixedArgs,suffixArgs,profileRoot,profileArgPrefix:'--user-data-dir=',profileNamePrefix:'playwright_chromiumdev_profile-',
      allowedExperimentalArgs:[[...AUTOPLAY_ARGS],[...AUTOPLAY_ARGS,...NATIVE_ARGS]]};
    const expected={...observed,mode:'headless-shell',chromiumVersion:observed.productVersion??'test-version',installationDirectory:root,
      installationFiles:{},launchProtocol};
    writeFileSync(join(root,'identity.json'),JSON.stringify(expected));
    const leaseChild=spawn(python,[...pyPrefix,'-u',helper,'--session',join(root,'identity.json')],{stdio:['pipe','pipe','ignore'],windowsHide:true});
    const lineIterator=createInterface({input:leaseChild.stdout})[Symbol.asyncIterator]();
    const receive=async()=>{const item=await lineIterator.next();assert.equal(item.done,false);return JSON.parse(item.value);};
    const ready=await receive();assert.equal(ready.status,'READY');
    const lease={request:async query=>{leaseChild.stdin.write(JSON.stringify(query)+'\n');const result=await receive();if(result.status==='STOP')throw new Error(result.reason);return result;}};
    const launchStartedMs=Date.now()-200;mkdirSync(profile);
    const child=spawn(shell,[...fixedArgs,...AUTOPLAY_ARGS,...NATIVE_ARGS,`--user-data-dir=${profile}`,...suffixArgs],{stdio:'ignore',windowsHide:true});
    try{
      await once(child,'spawn');
      const calls=[],cdp={send:async(method)=>{
        calls.push(method);
        if(method==='SystemInfo.getProcessInfo')return {processInfo:[{type:'browser',id:child.pid}]};
        if(method==='Browser.getVersion')return {product:`HeadlessShell/${expected.chromiumVersion}`};
        if(method==='Tracing.getCategories')return {categories:['disabled-by-default-memory-infra']};
        if(method==='Tracing.start')return {};
        throw new Error('UNEXPECTED_CDP_METHOD');
      }};
      const browser={newBrowserCDPSession:async()=>cdp,version:()=>expected.chromiumVersion,close:async()=>{}};
      const record={launchAttempts:1,browserLaunches:0,browserIdentity:{status:'PENDING',attemptReserved:true,readLease:true,browserLaunchSucceeded:false}};
      const launched=await launchWithIdentityLease({launch:async()=>browser},{args:[...AUTOPLAY_ARGS,...NATIVE_ARGS]},record,expected,lease,()=>{record.browserLaunches++;});
      assert.equal(launched,browser);assert.equal(record.browserLaunches,1);assert.equal(record.browserIdentity.browserLaunchSucceeded,true);
      assert.equal(record.browserIdentity.before.status,'PASS');assert.equal(record.browserIdentity.before.browserMode,'headless-shell');
      assert.equal(record.browserIdentity.before.nativeFlagsValidated,true);assert.equal(record.browserIdentity.ownedPids[0],child.pid);
      assert.equal(getAttestedBrowserProof(browser).nativeFlagsValidated,true);
      const trace=new NativeTrace('unused');await trace.start(browser);
      assert.equal(trace.receipt.activatedBeforeWorkload,true);assert.ok(!calls.includes('Browser.getBrowserCommandLine'));
      assert.equal((await lease.request({action:'closed'})).closedHashVerified,true);
    }finally{
      const childDone=child.exitCode!==null||child.signalCode!==null?Promise.resolve():once(child,'exit');
      if(child.exitCode===null&&child.signalCode===null)child.kill();await childDone;
      leaseChild.stdin.end();
      const leaseDone=leaseChild.exitCode!==null||leaseChild.signalCode!==null?Promise.resolve():once(leaseChild,'exit');
      if(leaseChild.exitCode===null&&leaseChild.signalCode===null){const exited=await Promise.race([leaseDone.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),3000))]);if(!exited){leaseChild.kill();await leaseDone;}}
      rmSync(root,{recursive:true,force:true});
    }
  });
test('a failed attestation after launch still counts the browser and closes its handle',async()=>{
  const record={launchAttempts:1,browserLaunches:0,browserIdentity:{status:'PENDING',attemptReserved:true,readLease:true,browserLaunchSucceeded:false}};
  const lease={child:{stdin:{end(){}},kill(){}},request:async()=>{throw new Error('unexpected');}};
  let closed=false;const browser={close:async()=>{closed=true;},newBrowserCDPSession:async()=>({send:async()=>{throw new Error('cdp failure');}})};
  await assert.rejects(launchWithIdentityLease({launch:async()=>browser},{args:[...AUTOPLAY_ARGS]},record,
    {chromiumVersion:'151.0.7922.34'},lease,()=>{record.browserLaunches++;}),/AP06_BROWSER_CDP_PROCESS_QUERY_FAILED/);
  assert.equal(record.browserLaunches,1);assert.equal(record.browserIdentity.browserLaunchSucceeded,true);
  assert.equal(record.browserIdentity.status,'STOP');assert.equal(record.browserIdentity.failureStage,'cdp-process-query');assert.equal(closed,true);
});
test('a failure after PID discovery closes and audits the owned process', {skip:process.platform!=='win32'},async()=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});await once(child,'spawn');
  const keys=['AP06_IDENTITY_PYTHON','AP06_R8_PID_AUDITOR'],old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try{
    process.env.AP06_IDENTITY_PYTHON=execFileSync('py',['-3','-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
    process.env.AP06_R8_PID_AUDITOR=fileURLToPath(new URL('../../tools/quality/run_ap06_integration_probe.py',import.meta.url));
    const cdp={send:async method=>method==='SystemInfo.getProcessInfo'?{processInfo:[{type:'browser',id:child.pid}]}:
      method==='Browser.getVersion'?{product:'HeadlessShell/151.0.7922.34'}:Promise.reject(new Error('unexpected CDP method'))};
    const browser={newBrowserCDPSession:async()=>cdp,version:()=> '151.0.7922.34',close:async()=>{const done=once(child,'exit');child.kill();await done;}};
    const record={launchAttempts:1,browserLaunches:0,browserIdentity:{status:'PENDING',attemptReserved:true,readLease:true,browserLaunchSucceeded:false}};
    const lease={child:{stdin:{end(){}},kill(){}},request:async()=>{throw new Error('AP06_BROWSER_OS_QUERY_FAILED');}};
    await assert.rejects(launchWithIdentityLease({launch:async()=>browser},{args:[...AUTOPLAY_ARGS]},record,
      {chromiumVersion:'151.0.7922.34'},lease,()=>{record.browserLaunches++;}),/AP06_BROWSER_OS_QUERY_FAILED/);
    assert.deepEqual(record.browserIdentity.ownedPids,[child.pid]);
    assert.equal(record.browserIdentity.failureCleanupAudit.status,'PASS');assert.equal(record.browserIdentity.cleanupStatus,'PASS');
  }finally{
    if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}
    for(const key of keys){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}
  }
});
test('native profiler rejects missing proof before creating CDP session',async()=>{
  let cdpRequested=false;const trace=new NativeTrace('unused');
  await assert.rejects(trace.start({newBrowserCDPSession:async()=>{cdpRequested=true;throw new Error('unexpected');}}),/AP06_BROWSER_NOT_ATTESTED/);
  assert.equal(cdpRequested,false);
});
