import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from '@playwright/test';
import {frozenLaunchOptions,validateResolution,resolveBrowserIdentity,AUTOPLAY_ARGS,NATIVE_ARGS,launchWithIdentityLease,finishBrowserIdentity,getAttestedBrowserProof,launchAttestedBrowser,closeBrowserIdentity,closeBrowserWithIdentity,parseExactFiletime,createRendererIdentityProof} from './ap06-browser-identity.mjs';
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
  const reordered=Object.fromEntries(Object.entries({...expected,installationFiles:{'C:/two': '2','C:/one':'1'},launchProtocol:{
    suffixArgs:['--pipe'],fixedArgs:['--no-startup-window'],profileRoot:'C:/profile',profileArgPrefix:'--user-data-dir=',
    profileNamePrefix:'playwright_chromiumdev_profile-',allowedExperimentalArgs:expected.launchProtocol.allowedExperimentalArgs}}).reverse());
  validateResolution({...expected,installationFiles:{'C:/one':'1','C:/two':'2'},launchProtocol:{
    fixedArgs:['--no-startup-window'],suffixArgs:['--pipe'],profileRoot:'C:/profile',profileArgPrefix:'--user-data-dir=',
    profileNamePrefix:'playwright_chromiumdev_profile-',allowedExperimentalArgs:expected.launchProtocol.allowedExperimentalArgs}},reordered);
  let error;try{validateResolution(expected,{...expected,installationFiles:{'C:/private/user/node_modules/playwright-core/package.json':'changed'}});}catch(value){error=value;}
  assert.equal(error.message,'AP06_BROWSER_IDENTITY_MISMATCH');assert.deepEqual(error.changedFields,['installationFiles']);
  assert.doesNotMatch(error.message,/private|node_modules|changed/);
  for(const [actual,field] of [[{...expected,executableSha256:'c'.repeat(64)},'executableSha256'],
    [{...expected,executablePath:'C:/private/browser.exe'},'executablePath'],
    [{...expected,playwrightVersion:'1.62.2'},'playwrightVersion'],[{...expected,chromiumVersion:'152.0.0.0'},'chromiumVersion'],
    [{...expected,launchProtocol:{...expected.launchProtocol,fixedArgs:['changed']}},'launchProtocol.fixedArgs'],
    [{...expected,launchProtocol:{...expected.launchProtocol,profileRoot:'C:/other'}},'launchProtocol.profileRoot'],
    [{...expected,launchProtocol:{...expected.launchProtocol,allowedExperimentalArgs:[[...NATIVE_ARGS,...AUTOPLAY_ARGS]]}},'launchProtocol.allowedExperimentalArgs'],
    [{...expected,playwrightVersion:undefined},'playwrightVersion'],[{...expected,unexpectedField:'x'},'identitySchema']]){
    let mismatch;try{validateResolution(expected,actual);}catch(value){mismatch=value;}
    assert.equal(mismatch.message,'AP06_BROWSER_IDENTITY_MISMATCH');assert.deepEqual(mismatch.changedFields,[field]);
    assert.doesNotMatch(JSON.stringify({message:mismatch.message,changedFields:mismatch.changedFields}),/private|browser\.exe|other/);
  }
});
test('real Playwright resolver CLI matches a property-reordered manifest without launching Chromium',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ap06-real-identity-preflight-'));
  const keys=['TEMP','TMP','AP06_BROWSER_TEMP_ROOT','AP06_IDENTITY_PYTHON','WAVE1_PYTHON','AP06_BROWSER_IDENTITY','AP06_R12R10_HEAD'];
  const old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try{
    process.env.TEMP=root;process.env.TMP=root;process.env.AP06_BROWSER_TEMP_ROOT=root;
    process.env.AP06_IDENTITY_PYTHON=process.env.WAVE1_PYTHON||execFileSync('py',['-3','-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
    const actual=await resolveBrowserIdentity(),reverse=value=>Array.isArray(value)?value.map(reverse):
      value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reverse(item)])):value;
    const manifest=join(root,'identity.json');writeFileSync(manifest,JSON.stringify(reverse(actual)));
    const frontend=fileURLToPath(new URL('../',import.meta.url));
    process.env.AP06_BROWSER_IDENTITY=manifest;
    process.env.AP06_R12R10_HEAD=execFileSync('git',['rev-parse','HEAD'],{cwd:frontend,encoding:'utf8'}).trim();
    const cli=join(frontend,'tools/ap06-r12-identity-preflight.mjs'),invoke=()=>execFileSync(process.execPath,[cli],
      {cwd:frontend,env:process.env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
    const pass=JSON.parse(invoke());assert.equal(pass.status,'PASS');assert.equal(pass.scientificChromium,0);
    assert.equal(pass.reservationCreated,false);assert.equal(pass.launchAttempts,0);assert.equal(pass.retries,0);
    assert.equal(pass.playwrightVersion,actual.playwrightVersion);assert.equal(pass.chromiumVersion,actual.chromiumVersion);
    assert.doesNotMatch(readFileSync(cli,'utf8'),/\.launch\s*\(/);
    writeFileSync(manifest,JSON.stringify({...actual,executableSha256:'0'.repeat(64)}));
    let failure;try{invoke();}catch(error){failure=JSON.parse(error.stdout.toString('utf8'));}
    assert.equal(failure.status,'STOP');assert.equal(failure.failureClass,'AP06_BROWSER_IDENTITY_MISMATCH');
    assert.deepEqual(failure.changedFields,['executableSha256']);assert.equal(failure.scientificChromium,0);
    assert.doesNotMatch(JSON.stringify(failure),/C:\\|node_modules|executablePath|0{64}/);
  }finally{
    for(const key of keys){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}
    rmSync(root,{recursive:true,force:true});
  }
});
test('unknown real resolver errors are classified without exposing their message',async()=>{
  const root=mkdtempSync(join(tmpdir(),'ap06-resolution-failure-')),manifest=join(root,'identity.json');writeFileSync(manifest,JSON.stringify(identity));
  const keys=['AP06_BROWSER_IDENTITY','AP06_IDENTITY_PYTHON','WAVE1_PYTHON'],old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{AP06_BROWSER_IDENTITY:manifest,AP06_IDENTITY_PYTHON:'python.exe'});
  const record={};let launches=0;
  try{
    await assert.rejects(launchAttestedBrowser({launch:async()=>{launches++;}},{args:AUTOPLAY_ARGS},record,()=>{launches++;},async()=>{
      throw new Error('private path C:\\users\\secret\\browser.exe bearer=not-for-output');
    }),/AP06_BROWSER_IDENTITY_RESOLUTION_FAILED/);
    assert.equal(launches,0);assert.equal(record.browserIdentity.failureStage,'identity-resolution');
    assert.equal(record.browserIdentity.failureClass,'AP06_BROWSER_IDENTITY_RESOLUTION_FAILED');
    assert.doesNotMatch(JSON.stringify(record),/users|secret|bearer|browser\.exe/);
  }finally{
    for(const key of keys){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}
    rmSync(root,{recursive:true,force:true});
  }
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
    assert.match(code,/launchAttestedBrowser\((?:chromium|browserType)/); assert.doesNotMatch(code,/chromium\.launch\(/);
    assert.match(code,/closeBrowserWithIdentity/);
  }
  const gate=readFileSync(new URL('ap06-browser-identity.mjs',import.meta.url),'utf8');
  assert.ok(gate.indexOf('onBrowserLaunched(browser);')<gate.lastIndexOf('const attested=await attestBrowserProcess(browser'));
  for(const name of ['ap06-browser-identity.mjs','ap06-native-trace.mjs'])
    assert.doesNotMatch(readFileSync(new URL(name,import.meta.url),'utf8'),/Browser\.getBrowserCommandLine/);
});
test('R3 through R7 cannot launch without their pre-registered identity manifest',async()=>{
  const old=process.env.AP06_EXPERIMENT_ROOT,manifest=process.env.AP06_BROWSER_IDENTITY;
  for(const root of ['.quality/readiness-wave12-r3-factorial','.quality/readiness-wave12-r4-factorial','.quality/readiness-wave12-r5-factorial','.quality/readiness-wave12-r6-factorial','.quality/readiness-wave12-r7-factorial']){
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
test('R12-R7 attests before and after workload, then audits and releases the disposable process',
  {skip:process.platform!=='win32'},async()=>{
    const root=mkdtempSync(join(tmpdir(),'ap06-identity-integration-')),profileRoot=join(root,'profiles');mkdirSync(profileRoot);
    const keys=['TEMP','TMP','AP06_BROWSER_TEMP_ROOT','AP06_BROWSER_IDENTITY','AP06_IDENTITY_PYTHON','WAVE1_PYTHON','AP06_R5_PROCESS_HANDLE_AUDIT'],old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
    const shell=join(root,'chrome-headless-shell.exe'),script='setInterval(()=>{},1000)';
    copyFileSync(process.execPath,shell);
    const configuredPython=process.env.AP06_IDENTITY_PYTHON||process.env.WAVE1_PYTHON;
    const python=configuredPython||execFileSync('py',['-3','-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
    const pyPrefix=python.toLowerCase().endsWith('py.exe')?['-3']:[];
    process.env.AP06_R5_PROCESS_HANDLE_AUDIT='1';
    process.env.TEMP=profileRoot;process.env.TMP=profileRoot;process.env.AP06_BROWSER_TEMP_ROOT=profileRoot;
    process.env.AP06_IDENTITY_PYTHON=python;
    const helper=fileURLToPath(new URL('../../tools/quality/ap06_browser_identity.py',import.meta.url));
    const observed=JSON.parse(execFileSync(python,[...pyPrefix,helper,'--inspect',shell],{encoding:'utf8',windowsHide:true}));
    const fixedArgs=['-e',script,'--'],suffixArgs=['--remote-debugging-pipe','--no-startup-window'];
    const launchProtocol={fixedArgs,suffixArgs,profileRoot,profileArgPrefix:'--user-data-dir=',profileNamePrefix:'playwright_chromiumdev_profile-',
      allowedExperimentalArgs:[[...AUTOPLAY_ARGS],[...AUTOPLAY_ARGS,...NATIVE_ARGS]]};
    const expected={...observed,mode:'headless-shell',chromiumVersion:observed.productVersion??'test-version',installationDirectory:root,
      installationFiles:{},launchProtocol};
    const manifest=join(root,'identity.json');writeFileSync(manifest,JSON.stringify(expected));process.env.AP06_BROWSER_IDENTITY=manifest;
    const foreign=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    const children=[],browsers=[],records=[],calls=[];let browser;
    try{
      await once(foreign,'spawn');
      const cdp={send:async(method)=>{
        calls.push(method);
        if(method==='SystemInfo.getProcessInfo')return {processInfo:[{type:'browser',id:children.at(-1).pid}]};
        if(method==='Browser.getVersion')return {product:`HeadlessShell/${expected.chromiumVersion}`};
        if(method==='Tracing.getCategories')return {categories:['disabled-by-default-memory-infra']};
        if(method==='Tracing.start')return {};
        throw new Error('UNEXPECTED_CDP_METHOD');
      }};
      const chromium={launch:async options=>{
        const profile=join(profileRoot,`playwright_chromiumdev_profile-${children.length+1}`);mkdirSync(profile);
        const child=spawn(shell,[...fixedArgs,...options.args,`--user-data-dir=${profile}`,...suffixArgs],{stdio:'ignore',windowsHide:true});children.push(child);
        await once(child,'spawn');
        const value={newBrowserCDPSession:async()=>cdp,version:()=>expected.chromiumVersion,close:async()=>{
          if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}
          rmSync(profile,{recursive:true,force:true});
        }};browsers.push(value);return value;
      }};
      const makeRecord=()=>({launchAttempts:1,browserLaunches:0,browserIdentity:{status:'PENDING',attemptReserved:true,readLease:false,browserLaunchSucceeded:false}});
      const record=makeRecord();records.push(record);
      browser=await launchAttestedBrowser(chromium,{args:[...AUTOPLAY_ARGS,...NATIVE_ARGS]},record,()=>{record.browserLaunches++;},async()=>expected);
      assert.equal(record.browserLaunches,1);assert.equal(record.browserIdentity.browserLaunchSucceeded,true);
      assert.equal(record.browserIdentity.before.status,'PASS');assert.equal(record.browserIdentity.before.browserMode,'headless-shell');
      assert.equal(record.browserIdentity.before.nativeFlagsValidated,true);assert.equal(record.browserIdentity.ownedPids[0],children[0].pid);
      const proof=getAttestedBrowserProof(browser);assert.equal(proof.nativeFlagsValidated,true);
      assert.throws(()=>{proof.nativeFlagsValidated=false;});assert.equal(getAttestedBrowserProof(browser).nativeFlagsValidated,true);
      const trace=new NativeTrace('unused');await trace.start(browser);
      assert.equal(trace.receipt.activatedBeforeWorkload,true);assert.ok(!calls.includes('Browser.getBrowserCommandLine'));
      await finishBrowserIdentity(browser);
      assert.equal(record.browserIdentity.after.identityBeforeWorkload,false);
      assert.equal(record.browserIdentity.after.browserPid,record.browserIdentity.before.browserPid);
      assert.equal(record.browserIdentity.after.processCreationTime,record.browserIdentity.before.processCreationTime);
      await browser.close();
      const closed=await closeBrowserIdentity(browser);
      assert.equal(closed.status,'PASS');assert.equal(record.processExitAudit.method,'retained-win32-process-handles');
      assert.equal(record.processExitAudit.closedHashVerified,true);assert.deepEqual(record.processExitAudit.processes[0].roles,['browser']);
      assert.equal(record.processExitAudit.processes[0].pid,children[0].pid);assert.equal(record.processExitAudit.timedOutProcessCount,0);
      assert.equal(record.handleRelease.status,'PASS');assert.equal(record.handleRelease.processHandles.releasedProcessHandles,1);
      assert.equal(record.handleRelease.processHandles.closeFailures,0);assert.equal(record.handleRelease.executableHandles.closeFailures,0);
      assert.equal(record.browserIdentity.auditHelperExitCode,0);
      const secondRecord=makeRecord();records.push(secondRecord);
      const secondBrowser=await launchAttestedBrowser(chromium,{args:[...AUTOPLAY_ARGS]},secondRecord,()=>{secondRecord.browserLaunches++;},async()=>expected);
      const lifecycle=await closeBrowserWithIdentity(secondBrowser,secondRecord);
      assert.equal(lifecycle.status,'PASS');assert.equal(secondRecord.browserIdentity.after.identityBeforeWorkload,false);
      assert.equal(secondRecord.processExitAudit.processes[0].pid,children[1].pid);
      assert.equal(secondRecord.handleRelease.status,'PASS');assert.equal(secondRecord.browserIdentity.auditHelperExitCode,0);
      assert.equal(foreign.exitCode,null);assert.equal(foreign.signalCode,null);
    }finally{
      for(let index=0;index<browsers.length;index++){
        try{await closeBrowserWithIdentity(browsers[index],records[index]);}catch{}
        const child=children[index];
        if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill();await done;}
      }
      const foreignDone=foreign.exitCode!==null||foreign.signalCode!==null?Promise.resolve():once(foreign,'exit');
      if(foreign.exitCode===null&&foreign.signalCode===null)foreign.kill();await foreignDone;
      for(const key of keys){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}
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
test('shared browser cleanup keeps the primary functional failure and records cleanup separately',async()=>{
  const record={failureClass:'AP06_FUNCTIONAL_FAILURE'};let closed=false;
  const result=await closeBrowserWithIdentity({close:async()=>{closed=true;}},record);
  assert.equal(closed,true);assert.equal(result.status,'PASS');assert.equal(record.failureClass,'AP06_FUNCTIONAL_FAILURE');
  assert.equal(record.cleanupStatus,'PASS');
});
test('post-workload STOP stays primary while close audit and release continue once',async()=>{
  const old=process.env.AP06_R5_PROCESS_HANDLE_AUDIT;process.env.AP06_R5_PROCESS_HANDLE_AUDIT='1';
  const record={browserIdentity:{status:'PENDING',attemptReserved:true,readLease:true,browserLaunchSucceeded:false}};
  const actions=[],version='151.0.7922.34',receipt={status:'PASS',closedHashVerified:true};let closes=0,attestations=0;
  const lease={child:{stdin:{end(){}},kill(){},exitCode:0,signalCode:null},request:async value=>{
    actions.push(value.action);
    if(value.action==='attest'){
      attestations++;if(attestations===2)throw new Error('AP06_BROWSER_ATTESTATION_ORDER_INVALID');
      return {status:'PASS',browserPid:44,processCreationTime:1234,identityBeforeWorkload:true};
    }
    if(value.action==='audit-closed')return {status:'PASS',receipt};
    if(value.action==='release')return {status:'PASS',processHandles:{releasedProcessHandles:1,closeFailures:0},executableHandles:{releasedExecutableHandles:1,closeFailures:0}};
    return {status:'PASS'};
  }};
  const browser={newBrowserCDPSession:async()=>({send:async method=>method==='SystemInfo.getProcessInfo'?
    {processInfo:[{type:'browser',id:44}]}:{product:'HeadlessShell/'+version}}),version:()=>version,close:async()=>{closes++;}};
  try{
    const launched=await launchWithIdentityLease({launch:async()=>browser},{args:[...AUTOPLAY_ARGS]},record,
      {chromiumVersion:version},lease);
    const result=await closeBrowserWithIdentity(launched,record);
    assert.deepEqual(actions,['attest','register-processes','attest','audit-closed','release']);
    assert.equal(record.failureStage,'post-workload-os-attestation');
    assert.equal(record.failureClass,'AP06_BROWSER_POST_ATTESTATION_FAILED');
    assert.equal(record.browserIdentity.postWorkloadFailureClass,'AP06_BROWSER_ATTESTATION_ORDER_INVALID');
    assert.equal(record.cleanupStatus,'PASS');assert.equal(result.status,'PASS');assert.equal(closes,1);
    assert.equal(record.processExitAudit,receipt);assert.equal(record.handleRelease.status,'PASS');
    assert.equal(record.browserIdentity.auditHelperExitCode,0);
  }finally{if(old===undefined)delete process.env.AP06_R5_PROCESS_HANDLE_AUDIT;else process.env.AP06_R5_PROCESS_HANDLE_AUDIT=old;}
});
test('a dead identity helper records cleanup failure without replacing the attestation failure',async()=>{
  const old=process.env.AP06_R5_PROCESS_HANDLE_AUDIT;process.env.AP06_R5_PROCESS_HANDLE_AUDIT='1';
  const record={launchAttempts:1,browserLaunches:0,browserIdentity:{status:'PENDING',attemptReserved:true,readLease:true,browserLaunchSucceeded:false}};
  let requests=0;const lease={child:{stdin:{end(){}},kill(){},exitCode:1,signalCode:null},request:async()=>{
    requests++;throw new Error(requests===1?'AP06_BROWSER_ATTESTATION_ORDER_INVALID':'AP06_BROWSER_AUDIT_HELPER_FAILED');}};
  let closed=false;const browser={newBrowserCDPSession:async()=>({send:async method=>method==='SystemInfo.getProcessInfo'?
    {processInfo:[{type:'browser',id:22}]}:{product:'HeadlessShell/151.0.7922.34'}}),version:()=> '151.0.7922.34',close:async()=>{closed=true;}};
  try{
    await assert.rejects(launchWithIdentityLease({launch:async()=>browser},{args:[...AUTOPLAY_ARGS]},record,
      {chromiumVersion:'151.0.7922.34'},lease),/AP06_BROWSER_ATTESTATION_ORDER_INVALID/);
    assert.equal(closed,true);assert.equal(record.browserIdentity.failureClass,'AP06_BROWSER_ATTESTATION_ORDER_INVALID');
    assert.equal(record.browserIdentity.cleanupStatus,'FAIL');assert.equal(record.browserIdentity.cleanupFailureClass,'AP06_BROWSER_AUDIT_HELPER_FAILED');
  }finally{if(old===undefined)delete process.env.AP06_R5_PROCESS_HANDLE_AUDIT;else process.env.AP06_R5_PROCESS_HANDLE_AUDIT=old;}
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
test('parseExactFiletime parses exact 64-bit uint64 FILETIME strings and rejects non-canonical values',()=>{
  assert.equal(parseExactFiletime('134368223588270130'), 134368223588270130n);
  assert.equal(parseExactFiletime('18446744073709551615'), 18446744073709551615n);
  assert.equal(parseExactFiletime('1'), 1n);

  for(const bad of ['0', '-1', '0134368223588270130', '134368223588270130.0', '1e17', 'NaN', '18446744073709551616', null, undefined, 123, 134368223588270130n, '']){
    assert.throws(()=>parseExactFiletime(bad), /NATIVE_FILETIME_INVALID/);
  }
});
test('createRendererIdentityProof accepts exact 64-bit FILETIME strings above Number.MAX_SAFE_INTEGER',()=>{
  const phases = ['baseline', 'cycle-6-close', 'idle-120s', 'forced-GC-final'];
  const baseRecord = {
    processExitAudit: {
      status: 'PASS',
      method: 'retained-win32-process-handles',
      processes: [{pid: 27900, creationTimeExact: '134368223588270130', roles: ['renderer']}]
    },
    processSamples: phases.map(phase => ({phase, processes: [{pid: 27900, type: 'renderer'}]})),
    handleRelease: {status: 'PASS'}
  };
  const proof = createRendererIdentityProof(baseRecord);
  assert.ok(proof);
  assert.equal(proof.status, 'PASS');
  assert.equal(proof.rendererPid, 27900);
  assert.equal(proof.creationTimeExact, '134368223588270130');

  // Rejects invalid string
  const badRecord = {
    ...baseRecord,
    processExitAudit: {
      ...baseRecord.processExitAudit,
      processes: [{pid: 27900, creationTimeExact: '134368223588270130.5', roles: ['renderer']}]
    }
  };
  assert.equal(createRendererIdentityProof(badRecord), null);
});
test('createRendererIdentityProof requires creationTimeExact and never falls back to Number or BigInt',()=>{
  const phases = ['baseline', 'cycle-6-close', 'idle-120s', 'forced-GC-final'];
  const makeRecord = audited => ({
    processExitAudit: {
      status: 'PASS',
      method: 'retained-win32-process-handles',
      processes: [{pid: 27900, roles: ['renderer'], ...audited}]
    },
    processSamples: phases.map(phase => ({phase, processes: [{pid: 27900, type: 'renderer'}]})),
    handleRelease: {status: 'PASS'}
  });

  assert.equal(createRendererIdentityProof(makeRecord({creationTime: 134368223588270130})), null);
  assert.equal(createRendererIdentityProof(makeRecord({creationTime: '134368223588270130'})), null);
  assert.equal(createRendererIdentityProof(makeRecord({creationTime: 123456})), null);

  const exact = makeRecord({creationTimeExact: '134368223588270130'});
  assert.equal(createRendererIdentityProof(makeRecord({
    creationTimeExact: '134368223588270130', creationTime: 123456
  })), null);

  const safe = createRendererIdentityProof(makeRecord({
    creationTimeExact: '123456', creationTime: 123456
  }));
  assert.ok(safe);
  assert.equal(safe.creationTimeExact, '123456');
  assert.equal(safe.creationTime, 123456);
  assert.equal(JSON.parse(JSON.stringify(safe)).creationTimeExact, '123456');

  // A rounded JavaScript Number is ignored because the canonical string is authoritative.
  const rounded = createRendererIdentityProof(makeRecord({
    creationTimeExact: '134368223588270130', creationTime: 134368223588270128
  }));
  assert.ok(rounded);
  assert.equal(rounded.creationTimeExact, '134368223588270130');
  assert.equal(rounded.creationTime, undefined);

  const roundTrip = createRendererIdentityProof(JSON.parse(JSON.stringify(exact)));
  assert.ok(roundTrip);
  assert.equal(roundTrip.creationTimeExact, '134368223588270130');
});

