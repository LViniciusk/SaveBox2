import assert from 'node:assert/strict';
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
import { networkGuardSnapshot,validateCleanNetwork } from './ap06-preflight.mjs';

const output=process.env.AP06_R7_UNIT_OUTPUT;if(!output)throw new Error('R12_OUTPUT_REQUIRED');
const fixtures=JSON.parse(readFileSync(process.env.AP06_R5_FIXTURE_MANIFEST,'utf8'));
const paths=JSON.parse(process.env.AP06_R7_ALLOWED_PATHS),origin=process.env.AP06_R5_MEDIA_ORIGIN;
const hash=value=>createHash('sha256').update(value).digest('hex');
const result={status:'FAIL',unitBrowserLaunchAttempts:0,unitBrowserLaunches:0,browserClosed:false,cases:[],rangeNetworks:{},
  transportProofs:{},boundaryCounters:{},scalarCounters:{},rendererMemory:{},appProducts:JSON.parse(process.env.AP06_R7_APP_PRODUCTS),
  pageScriptSha256:hash(r12PageScript()),multiplexedContract:{fixtureHash:hash(readFileSync(process.env.AP06_R5_FIXTURE_MANIFEST)),
    workerHashes:{crypto:process.env.AP06_R5_CRYPTO_WORKER_SHA256,transmux:process.env.AP06_R5_TRANSMUX_WORKER_SHA256},initDataPerFixture:[1,1,1],initDataId:0}};
const save=()=>writeJsonAtomic(output,result),pids=new Set();let browser,browserCdp;
async function remember(){if(browserCdp)for(const p of(await browserCdp.send('SystemInfo.getProcessInfo')).processInfo)pids.add(p.id);result.ownedPids=[...pids];save();}
try{
  result.unitBrowserLaunchAttempts++;save();browser=await chromium.launch({args:AUTOPLAY_ARGS});result.unitBrowserLaunches++;save();
  assert.equal(browser.version(),process.env.AP06_R5_CHROMIUM_VERSION);browserCdp=await browser.newBrowserCDPSession();await remember();
  for(const condition of [...Object.keys(R12_CONDITIONS),'cancel-r12.4']){
    const cancellation=condition.startsWith('cancel-'),selected=cancellation?'r12.4':condition;
    const context=await browser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block'});
    let page,observer,cdp;const raw={},record={condition,status:'FAIL'};result.cases.push(record);save();
    try{
      page=await context.newPage();observer=await configureR12Page(page,context,raw,origin,paths,selected);
      await page.addInitScript({content:r12PageScript()});await page.goto(origin);
      await page.evaluate(counters=>{window.r5Counters=counters;},newIntegrationCounters());
      const proof=await initializeR12Page(page,fixtures);
      if(cancellation){
        record.cancellation=await page.evaluate(async fixture=>{
          const pending=window.r7Run(fixture);window.r7CancelSession();
          try{await pending;return {rejected:false};}catch{return {rejected:true,active:window.r7SessionActive,pending:window.r12Counters.pendingOperations,references:window.r12Counters.activeReferences};}
        },fixtures[0]);
        assert.deepEqual(record.cancellation,{rejected:true,active:false,pending:0,references:0});
      }else{
        result.transportProofs[condition]=proof;
        record.processSamples=[{phase:'baseline',cycle:0,processMemory:await sampleOwnedProcesses(browserCdp)}];
        for(const fixture of fixtures)await page.evaluate(f=>window.r7Run(f),fixture);
        const state=await page.evaluate(()=>({counters:window.r5Counters,media:document.querySelectorAll('video,audio').length}));
        validateR12Functional(condition,state.counters,state.media);assert.equal(state.counters.r12.sessionsCompleted,3);
        result.boundaryCounters[condition]=state.counters.observed;result.scalarCounters[condition]=state.counters.r12;
        record.processSamples.push({phase:'cycle-1-close',cycle:1,processMemory:await sampleOwnedProcesses(browserCdp)});save();
        record.processValidation=JSON.parse(execFileSync(process.env.WAVE1_PYTHON,[process.env.AP06_R9_PUBLISHER,'--validate-processes',output,'--condition',condition],{encoding:'utf8',windowsHide:true}));
        cdp=await context.newCDPSession(page);result.rendererMemory[condition]=await sampleRenderer(cdp);
        record.guards=networkGuardSnapshot(raw);validateCleanNetwork(raw,condition);
      }
      record.status='PASS';
    }finally{
      if(page){const state=await page.evaluate(()=>({counters:window.r5Counters,media:document.querySelectorAll('video,audio').length}));validateIntegrationCleanup(state.counters,state.media);}
      await remember();if(observer)await observer();if(cdp)await cdp.detach();
      result.rangeNetworks[condition]={cdp:raw.rangeNetwork,backend:raw.backendTraffic};
      await context.unrouteAll({behavior:'wait'});await context.close();record.contextClosed=true;save();
    }
  }
  result.status='PASS';
}catch(error){result.failureClass=/^[A-Z0-9_]+$/.test(error.message)?error.message:'R12_PREFLIGHT_FAILED';process.exitCode=1;}
finally{
  await remember();if(browser){await browser.close();result.browserClosed=true;}
  if(pids.size){result.processExitAudit=JSON.parse(execFileSync(process.env.WAVE1_PYTHON,[process.env.AP06_R8_PID_AUDITOR,'--closed-pids',[...pids].join(',')],{encoding:'utf8',windowsHide:true}));if(result.processExitAudit.status!=='PASS'){result.status='FAIL';process.exitCode=1;}}
  save();
}
