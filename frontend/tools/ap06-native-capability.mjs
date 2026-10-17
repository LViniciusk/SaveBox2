import {chromium} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {AUTOPLAY_ARGS} from './ap06-integration-probe.mjs';
import {NativeTrace,NATIVE_ARGS} from './ap06-native-trace.mjs';
import {sampleOwnedProcesses} from './ap06-process-sample.mjs';
import {writeJsonAtomic} from './browser-memory-probe.mjs';
import {launchAttestedBrowser,closeBrowserWithIdentity,registerBrowserProcesses,usesRetainedProcessAudit} from './ap06-browser-identity.mjs';
const output=process.env.AP06_NATIVE_RECEIPT;
if(!output||!process.env.AP06_NATIVE_TRACE)throw new Error('NATIVE_OWNED_PATH_REQUIRED');
const record={launchAttempts:1,browserLaunches:0,retries:0,browserClosed:false,status:'FAIL'},pids=new Set();
let browser,trace,browserCdp;
const save=()=>writeJsonAtomic(output,{...record,trace:trace?.receipt});
save();
try{
  browser=await launchAttestedBrowser(chromium,{args:[...AUTOPLAY_ARGS,...NATIVE_ARGS]},record,()=>{record.browserLaunches++;save();});
  if(browser.version()!==process.env.AP06_R5_CHROMIUM_VERSION)throw new Error('NATIVE_VERSION_CHANGED');
  browserCdp=await browser.newBrowserCDPSession();trace=new NativeTrace(process.env.AP06_NATIVE_TRACE);await trace.start(browser);
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  await page.route('**/*',route=>route.abort());await page.setContent('<!doctype html><title>Owned native profiling capability</title>');
  const sample=async phase=>{const processes=await sampleOwnedProcesses(browserCdp,undefined,rows=>registerBrowserProcesses(browser,rows));
    for(const p of processes.processes)pids.add(p.pid);record.processSamples??=[];
    record.processSamples.push({phase,processes:processes.processes.map(({pid,type})=>({pid,type}))});await trace.dump(phase,processes);save();};
  await page.waitForTimeout(1000);await sample('baseline');
  await page.evaluate(()=>{window.nativeCapabilityAllocation=new Uint8Array(8*1024*1024);window.nativeCapabilityAllocation.fill(31);});await sample('cycle-6-close');
  await page.evaluate(()=>{window.nativeCapabilityAllocation=null;});await page.waitForTimeout(120000);await sample('idle-120s');
  const cdp=await context.newCDPSession(page);await cdp.send('HeapProfiler.collectGarbage');await sample('forced-GC-final');
  record.status='CAPTURED';
}catch(error){record.failureClass=/^[A-Z0-9_]+$/.test(error.message)?error.message:'NATIVE_CAPABILITY_CAPTURE_FAILED';
  record.failureStage??=record.browserIdentity?.failureStage??'native-capability';}
finally{
  if(trace)try{await trace.stop();}catch(error){record.traceFailure=/^[A-Z0-9_]+$/.test(error.message)?error.message:'NATIVE_TRACE_STOP_FAILED';}
  if(browserCdp)try{const processes=(await browserCdp.send('SystemInfo.getProcessInfo')).processInfo;
    if(usesRetainedProcessAudit())await registerBrowserProcesses(browser,processes);for(const p of processes)pids.add(p.id);}catch{}
  if(browser){
    const lifecycle=await closeBrowserWithIdentity(browser,record);
    if(lifecycle.status!=='PASS'){record.status='STOP';record.cleanupFailureClass??=lifecycle.failureClass;}
  }
  else if(record.browserIdentity?.browserClosed){record.browserClosed=true;record.processExitAudit??=record.browserIdentity.processExitAudit??record.browserIdentity.failureCleanupAudit;}
  if(pids.size&&!usesRetainedProcessAudit())try{record.processExitAudit=JSON.parse(execFileSync(process.env.WAVE1_PYTHON,[process.env.AP06_R8_PID_AUDITOR,'--closed-pids',[...pids].join(',')],{encoding:'utf8',windowsHide:true}));}catch{record.status='STOP';record.cleanupFailureClass??='AP06_BROWSER_PROCESS_EXIT_AUDIT_FAILED';}
  save();
}
