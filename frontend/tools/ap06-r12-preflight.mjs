import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { R12_CONDITIONS } from './ap06-r12-contract.mjs';
import { configureR12Page,initializeR12Page,r12PageScript,validateR12Functional } from './ap06-r12-probe.mjs';
import { newIntegrationCounters,validateIntegrationCleanup } from './ap06-r7-instrumentation.mjs';
import { sampleRenderer } from './ap06-r10-memory.mjs';
import { sampleOwnedProcesses } from './ap06-process-sample.mjs';
import { AUTOPLAY_ARGS } from './ap06-integration-probe.mjs';
import { writeJsonAtomic } from './browser-memory-probe.mjs';
import { networkGuardSnapshot,validateCleanNetwork,cleanupContext } from './ap06-preflight.mjs';
import {launchAttestedBrowser,closeBrowserWithIdentity,registerBrowserProcesses,usesRetainedProcessAudit} from './ap06-browser-identity.mjs';

export async function runHttpPreflight({conditions,cancellationCondition,configure,initialize,pageScript,validateFunctional,counterName,browserType=chromium,identityResolver}){
const output=process.env.AP06_R7_UNIT_OUTPUT;if(!output)throw new Error('R12_OUTPUT_REQUIRED');
const fixtures=JSON.parse(readFileSync(process.env.AP06_R5_FIXTURE_MANIFEST,'utf8'));
const paths=JSON.parse(process.env.AP06_R7_ALLOWED_PATHS),origin=process.env.AP06_R5_MEDIA_ORIGIN;
const hash=value=>createHash('sha256').update(value).digest('hex');
const result={status:'FAIL',unitBrowserLaunchAttempts:0,unitBrowserLaunches:0,browserClosed:false,cases:[],rangeNetworks:{},
  transportProofs:{},boundaryCounters:{},scalarCounters:{},rendererMemory:{},appProducts:JSON.parse(process.env.AP06_R7_APP_PRODUCTS),
  pageScriptSha256:hash(pageScript()),multiplexedContract:{fixtureHash:hash(readFileSync(process.env.AP06_R5_FIXTURE_MANIFEST)),
    workerHashes:{crypto:process.env.AP06_R5_CRYPTO_WORKER_SHA256,transmux:process.env.AP06_R5_TRANSMUX_WORKER_SHA256},initDataPerFixture:[1,1,1],initDataId:0}};
const save=()=>writeJsonAtomic(output,result),pids=new Set();let browser,browserCdp;
async function remember(){if(browserCdp){const processes=(await browserCdp.send('SystemInfo.getProcessInfo')).processInfo;
  if(usesRetainedProcessAudit())await registerBrowserProcesses(browser,processes);for(const p of processes)pids.add(p.id);}
  result.ownedPids=[...pids];save();}
try{
  result.unitBrowserLaunchAttempts++;save();browser=await launchAttestedBrowser(browserType,{args:AUTOPLAY_ARGS},result,()=>{result.unitBrowserLaunches++;save();},identityResolver);
  assert.equal(browser.version(),process.env.AP06_R5_CHROMIUM_VERSION);browserCdp=await browser.newBrowserCDPSession();await remember();
  for(const condition of [...conditions,'cancel-'+cancellationCondition]){
    const cancellation=condition.startsWith('cancel-'),selected=cancellation?cancellationCondition:condition;
    const context=await browser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block'});
    let page,observer,cdp,primary;const raw={},record={condition,status:'FAIL'};result.cases.push(record);save();
    try{
      page=await context.newPage();observer=await configure(page,context,raw,origin,paths,selected);
      await page.addInitScript({content:pageScript()});await page.goto(origin);
      await page.evaluate(counters=>{window.r5Counters=counters;},newIntegrationCounters());
      const proof=await initialize(page,fixtures);
      if(cancellation){
        record.cancellation=await page.evaluate(async ({fixture,counterName})=>{
          const pending=window.r7Run(fixture);window.r7CancelSession();
          try{await pending;return {rejected:false};}catch{return {rejected:true,active:window.r7SessionActive,pending:window[counterName+'Counters'].pendingOperations,references:window[counterName+'Counters'].activeReferences};}
        },{fixture:fixtures[0],counterName});
        assert.deepEqual(record.cancellation,{rejected:true,active:false,pending:0,references:0});
      }else{
        result.transportProofs[condition]=proof;
        record.processSamples=[{phase:'baseline',cycle:0,processMemory:await sampleOwnedProcesses(browserCdp,undefined,processes=>registerBrowserProcesses(browser,processes))}];
        for(const fixture of fixtures)await page.evaluate(f=>window.r7Run(f),fixture);
        const state=await page.evaluate(()=>({counters:window.r5Counters,media:document.querySelectorAll('video,audio').length}));
        validateFunctional(condition,state.counters,state.media);assert.equal(state.counters[counterName].sessionsCompleted,3);
        result.boundaryCounters[condition]=state.counters.observed;result.scalarCounters[condition]=state.counters[counterName];
        if(state.counters.routing){result.routingCounters??={};result.routingCounters[condition]=state.counters.routing;}
        record.processSamples.push({phase:'cycle-1-close',cycle:1,processMemory:await sampleOwnedProcesses(browserCdp,undefined,processes=>registerBrowserProcesses(browser,processes))});save();
        record.processValidation=JSON.parse(execFileSync(process.env.WAVE1_PYTHON,[process.env.AP06_R9_PUBLISHER,'--validate-processes',output,'--condition',condition],{encoding:'utf8',windowsHide:true}));
        cdp=await context.newCDPSession(page);result.rendererMemory[condition]=await sampleRenderer(cdp);
        record.guards=networkGuardSnapshot(raw);validateCleanNetwork(raw,condition);
      }
      record.status='PASS';
    }catch(error){primary=error;throw error;}finally{
      const errors=[],closed={};
      if(page)try{const state=await page.evaluate(()=>({counters:window.r5Counters,media:document.querySelectorAll('video,audio').length}));validateIntegrationCleanup(state.counters,state.media);}catch(error){errors.push(error);}
      try{await remember();}catch(error){errors.push(error);}
      try{await context.unrouteAll({behavior:'wait'});}catch(error){errors.push(error);}
      errors.push(...await cleanupContext({routes:[],observer,cdp,context},closed));
      result.rangeNetworks[condition]={cdp:raw.rangeNetwork,backend:raw.backendTraffic};
      record.contextClosed=closed.closed===true;
      if(errors.length){record.cleanupFailureClass='AP06_CONTEXT_CLEANUP_FAILED';result.cleanupFailureClass??=record.cleanupFailureClass;result.status='FAIL';process.exitCode=1;}
      save();
      if(errors.length&&!primary)throw new Error(record.cleanupFailureClass);
    }
  }
  if(!result.failureClass)result.status='PASS';
}catch(error){result.failureClass??=/^[A-Z0-9_]+$/.test(error.message)?error.message:'R12_PREFLIGHT_FAILED';
  result.failureStage??=result.browserIdentity?.failureStage;process.exitCode=1;}
finally{
  try{await remember();}catch(error){result.status='FAIL';result.failureClass??=/^[A-Z0-9_]+$/.test(error.message)?error.message:'AP06_BROWSER_CDP_PROCESS_QUERY_FAILED';process.exitCode=1;}
  if(browser){
    const lifecycle=await closeBrowserWithIdentity(browser,result);
    if(lifecycle.status!=='PASS'){result.status='FAIL';result.cleanupFailureClass??=lifecycle.failureClass??'AP06_BROWSER_PROCESS_EXIT_AUDIT_FAILED';process.exitCode=1;}
    if(result.failureClass){result.status='FAIL';process.exitCode=1;}
  }
  else if(result.browserIdentity?.browserClosed){result.browserClosed=true;result.processExitAudit??=result.browserIdentity.processExitAudit??result.browserIdentity.failureCleanupAudit;}
  if(pids.size&&!usesRetainedProcessAudit())try{result.processExitAudit=JSON.parse(execFileSync(process.env.WAVE1_PYTHON,[process.env.AP06_R8_PID_AUDITOR,'--closed-pids',[...pids].join(',')],{encoding:'utf8',windowsHide:true}));if(result.processExitAudit.status!=='PASS'){result.status='FAIL';process.exitCode=1;}}catch{result.status='FAIL';result.cleanupFailureClass??='AP06_BROWSER_PROCESS_EXIT_AUDIT_FAILED';process.exitCode=1;}
  if(result.cleanupFailureClass)result.cleanupStatus='FAIL';
  save();
}

}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])await runHttpPreflight({
 conditions:Object.keys(R12_CONDITIONS),cancellationCondition:'r12.4',configure:configureR12Page,initialize:initializeR12Page,
 pageScript:r12PageScript,validateFunctional:validateR12Functional,counterName:'r12',
});
