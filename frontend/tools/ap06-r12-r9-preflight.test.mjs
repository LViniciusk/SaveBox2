import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {newIntegrationCounters} from './ap06-r7-instrumentation.mjs';
import {runHttpPreflight} from './ap06-r12-preflight.mjs';
import {validateFunctional,pageScript} from './ap06-r12-r2-probe.mjs';
import {AUTOPLAY_ARGS,NATIVE_ARGS} from './ap06-browser-identity.mjs';

test('R9 complete preflight uses real Windows handles and Python receipt consumers',
  {skip:process.platform!=='win32'||!process.env.AP06_R9_SIMULATION},async()=>{
    const data=JSON.parse(readFileSync(process.env.AP06_R9_SIMULATION,'utf8'));
    const root=mkdtempSync(join(tmpdir(),'ap06-r9-simulation-')),profiles=join(root,'profiles');mkdirSync(profiles);
    const old={...process.env},children=[];
    const python=process.env.WAVE1_PYTHON,helper=fileURLToPath(new URL('../../tools/quality/ap06_browser_identity.py',import.meta.url));
    const shell=join(root,'chrome-headless-shell.exe');copyFileSync(process.execPath,shell);
    const observed=JSON.parse(execFileSync(python,[helper,'--inspect',shell],{encoding:'utf8',windowsHide:true}));
    const fixedArgs=['-e','setInterval(()=>{},1000)','--'],suffixArgs=['--remote-debugging-pipe','--no-startup-window'];
    const identity={...observed,mode:'headless-shell',chromiumVersion:observed.productVersion??'test-version',installationDirectory:root,
      installationFiles:{},launchProtocol:{fixedArgs,suffixArgs,profileRoot:profiles,profileArgPrefix:'--user-data-dir=',
        profileNamePrefix:'playwright_chromiumdev_profile-',allowedExperimentalArgs:[[...AUTOPLAY_ARGS],[...AUTOPLAY_ARGS,...NATIVE_ARGS]]}};
    const manifest=join(root,'identity.json');writeFileSync(manifest,JSON.stringify(identity));
    Object.assign(process.env,{AP06_BROWSER_IDENTITY:manifest,AP06_IDENTITY_PYTHON:python,AP06_R5_PROCESS_HANDLE_AUDIT:'1',
      TEMP:profiles,TMP:profiles,AP06_BROWSER_TEMP_ROOT:profiles,AP06_R5_CHROMIUM_VERSION:identity.chromiumVersion});
    const calls=[],roles=['browser','renderer','GPU','network.mojom.NetworkService'];let current,injectedFailure=false;
    async function stop(child){if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}}
    const cdp={send:async method=>{
      calls.push(method);
      if(method==='SystemInfo.getProcessInfo')return {processInfo:children.map((child,i)=>({type:roles[i],id:child.pid}))};
      if(method==='Browser.getVersion')return {product:'HeadlessShell/'+identity.chromiumVersion};
      if(method==='Runtime.getHeapUsage')return {usedSize:1,totalSize:2,embedderHeapUsedSize:0,backingStorageSize:0};
      if(method==='Memory.getDOMCounters')return {documents:1,nodes:1,jsEventListeners:0};
      throw new Error('UNEXPECTED_CDP_METHOD');
    },detach:async()=>{}};
    const browserType={launch:async options=>{
      const profile=join(profiles,'playwright_chromiumdev_profile-simulation');mkdirSync(profile);
      for(let i=0;i<roles.length;i++){
        const child=spawn(shell,[...fixedArgs,...options.args,`--user-data-dir=${profile}`,...suffixArgs],{stdio:'ignore',windowsHide:true});
        children.push(child);await once(child,'spawn');
      }
      return {version:()=>identity.chromiumVersion,newBrowserCDPSession:async()=>cdp,
        newContext:async()=>({newPage:async()=>({addInitScript:async()=>{},goto:async()=>{},evaluate:async(fn,arg)=>{
          if(injectedFailure&&arg?.id!==undefined)throw new Error('R12R9_TEST_FUNCTIONAL_FAILURE');
          if(arg?.counterName)return {rejected:true,active:false,pending:0,references:0};
          if(String(fn).includes('counters:window.r5Counters'))return {counters:current.counters,media:0};
        }}),newCDPSession:async()=>cdp,unrouteAll:async()=>{},close:async()=>{if(injectedFailure)throw new Error('R12R9_TEST_CONTEXT_CLOSE_FAILED');}}),
        close:async()=>{await Promise.all(children.map(stop));rmSync(profile,{recursive:true,force:true});}};
    }};
    try{
      const options={conditions:Object.keys(data.conditions),cancellationCondition:'r12r2.3',counterName:'r12r2',
        browserType,identityResolver:async()=>identity,pageScript,validateFunctional,
        configure:async(page,context,raw,origin,paths,condition)=>{
          current=data.conditions[condition];const defaults=newIntegrationCounters();
          current={...current,counters:{...defaults,...current.counters,observed:{...defaults.observed,...current.counters.observed}}};Object.assign(raw,{pageErrors:0,recoveryWarnings:0,network:{rejectedRequests:0,
            externalRequests:0,unexpectedRequests:0},rangeNetwork:current.network,backendTraffic:current.backend});
          return async()=>{};
        },initialize:async()=>data.proof};
      await runHttpPreflight(options);
      const result=JSON.parse(readFileSync(process.env.AP06_R7_UNIT_OUTPUT,'utf8'));
      assert.equal(result.status,'PASS');assert.equal(result.cases.length,5);
      assert.equal(result.processExitAudit.registeredProcessCount,4);assert.equal(result.handleRelease.status,'PASS');
      assert.equal(result.browserIdentity.before.identityBeforeWorkload,true);assert.equal(result.browserIdentity.after.identityBeforeWorkload,false);
      assert.ok(!calls.includes('Browser.getBrowserCommandLine'));
      writeFileSync(data.identityOutput,JSON.stringify(identity));
      children.length=0;injectedFailure=true;
      const failureOutput=process.env.AP06_R7_UNIT_OUTPUT.replace(/raw\.json$/,'raw-negative.json');
      process.env.AP06_R7_UNIT_OUTPUT=failureOutput;await runHttpPreflight(options);
      const failed=JSON.parse(readFileSync(failureOutput,'utf8'));
      assert.equal(failed.failureClass,'R12R9_TEST_FUNCTIONAL_FAILURE');
      assert.equal(failed.cleanupFailureClass,'AP06_CONTEXT_CLEANUP_FAILED');
      assert.equal(failed.browserClosed,true);assert.equal(failed.processExitAudit.status,'PASS');
      assert.equal(failed.handleRelease.status,'PASS');process.exitCode=0;
    }finally{
      await Promise.all(children.map(stop));
      for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];
      Object.assign(process.env,old);rmSync(root,{recursive:true,force:true});
    }
  });
