import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { R11_CONDITIONS } from './ap06-r11-contract.mjs';
import { configureR11Page, initializeR11Page, r11PageScript, validateR11Functional } from './ap06-r11-probe.mjs';
import { newIntegrationCounters, validateIntegrationCleanup } from './ap06-r7-instrumentation.mjs';
import { sampleRenderer } from './ap06-r10-memory.mjs';
import { AUTOPLAY_ARGS } from './ap06-integration-probe.mjs';
import { writeJsonAtomic } from './browser-memory-probe.mjs';
import { networkGuardSnapshot, validateCleanNetwork } from './ap06-preflight.mjs';

const output=process.env.AP06_R7_UNIT_OUTPUT;
if(!output)throw new Error('R11_OUTPUT_REQUIRED');
const fixtures=JSON.parse(readFileSync(process.env.AP06_R5_FIXTURE_MANIFEST,'utf8'));
const paths=JSON.parse(process.env.AP06_R7_ALLOWED_PATHS),origin=process.env.AP06_R5_MEDIA_ORIGIN;
const hash=value=>createHash('sha256').update(value).digest('hex');
const result={status:'FAIL',unitBrowserLaunchAttempts:0,unitBrowserLaunches:0,browserClosed:false,cases:[],
  rangeNetworks:{},transportProofs:{},boundaryCounters:{},scalarCounters:{},rendererMemory:{},
  appProducts:JSON.parse(process.env.AP06_R7_APP_PRODUCTS),pageScriptSha256:hash(r11PageScript()),
  multiplexedContract:{fixtureHash:hash(readFileSync(process.env.AP06_R5_FIXTURE_MANIFEST)),
    workerHashes:{crypto:process.env.AP06_R5_CRYPTO_WORKER_SHA256,transmux:process.env.AP06_R5_TRANSMUX_WORKER_SHA256},initDataPerFixture:[1,1,1],initDataId:0}};
const save=()=>writeJsonAtomic(output,result);
let browser,browserCdp;
const pids=new Set();
async function remember(){if(browserCdp){for(const p of (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo)pids.add(p.id);result.ownedPids=[...pids];save();}}
try {
  result.unitBrowserLaunchAttempts++;save();
  browser=await chromium.launch({args:AUTOPLAY_ARGS});result.unitBrowserLaunches++;save();
  assert.equal(browser.version(),process.env.AP06_R5_CHROMIUM_VERSION);
  browserCdp=await browser.newBrowserCDPSession();await remember();
  for(const condition of Object.keys(R11_CONDITIONS)) {
    let context,page,observer,cdp;const raw={},record={condition,status:'FAIL'};result.cases.push(record);save();
    try {
      context=await browser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block'});
      page=await context.newPage();observer=await configureR11Page(page,context,raw,origin,paths,condition);
      await page.addInitScript({content:r11PageScript()});await page.goto(origin);
      await page.evaluate(({counters,crypto,transmux})=>{
        window.r5Counters=counters;window.r5CryptoWorkerSource=crypto;window.r5TransmuxWorkerSource=transmux;
      },{counters:newIntegrationCounters(),crypto:readFileSync(process.env.AP06_R5_CRYPTO_WORKER,'utf8'),transmux:readFileSync(process.env.AP06_R5_TRANSMUX_WORKER,'utf8')});
      result.transportProofs[condition]=await initializeR11Page(page,fixtures);
      record.sessions=[];
      for(const fixture of fixtures){
        const before=await page.evaluate(()=>({...window.r5Counters.observed}));
        await page.evaluate(f=>window.r7Run(f),fixture);
        const after=await page.evaluate(()=>({...window.r5Counters.observed}));
        const full=R11_CONDITIONS[condition].terminal==='mse';
        assert.equal(after.sourceBuffersCreated-before.sourceBuffersCreated,full?1:0);
        assert.equal(after.workersCreated-before.workersCreated,condition==='r11.2'?0:2);
        record.sessions.push({fixture:fixture.id,sourceBuffers:after.sourceBuffersCreated-before.sourceBuffersCreated,
          workers:after.workersCreated-before.workersCreated});
      }
      const state=await page.evaluate(()=>({counters:window.r5Counters,media:document.querySelectorAll('video,audio').length}));
      validateR11Functional(condition,state.counters,state.media);
      assert.equal(state.counters.r11.sessionsCompleted,3);
      result.boundaryCounters[condition]=state.counters.observed;result.scalarCounters[condition]=state.counters.r11;
      cdp=await context.newCDPSession(page);result.rendererMemory[condition]=await sampleRenderer(cdp);
      record.guards=networkGuardSnapshot(raw);validateCleanNetwork(raw,condition);record.status='PASS';
    } catch(error){record.failureClass=/^[A-Z_0-9]+$/.test(error.message)?error.message:error.name;throw error;}
    finally {
      if(page){const state=await page.evaluate(()=>({counters:window.r5Counters,media:document.querySelectorAll('video,audio').length}));validateIntegrationCleanup(state.counters,state.media);}
      await remember();if(observer)await observer();if(cdp)await cdp.detach();
      result.rangeNetworks[condition]={cdp:raw.rangeNetwork,backend:raw.backendTraffic};
      if(context){await context.unrouteAll({behavior:'wait'});await context.close();record.contextClosed=true;}
      save();
    }
  }
  result.status='PASS';
} catch(error){result.failureClass=/^[A-Z_0-9]+$/.test(error.message)?error.message:error.name;process.exitCode=1;}
finally {
  await remember();if(browser){await browser.close();result.browserClosed=true;}
  if(pids.size){result.processExitAudit=JSON.parse(execFileSync(process.env.WAVE1_PYTHON,[process.env.AP06_R8_PID_AUDITOR,'--closed-pids',[...pids].join(',')],{encoding:'utf8',windowsHide:true}));
    if(result.processExitAudit.status!=='PASS'){result.status='FAIL';process.exitCode=1;}}
  save();
}
