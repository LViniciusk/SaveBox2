import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { integrationPageScript, configureIntegrationPage, initializeIntegrationPage, AUTOPLAY_ARGS } from './ap06-integration-probe.mjs';
import { newIntegrationCounters, integrationSnapshot, validateIntegrationCleanup, validateIntegrationFunctional } from './ap06-r7-instrumentation.mjs';
import { writeJsonAtomic } from './browser-memory-probe.mjs';
import { configureR9Page, initializeR9Page, TRANSPORTS } from './ap06-r9-probe.mjs';
import { configureR10Page, initializeR10Page, R10_CONDITIONS } from './ap06-r10-probe.mjs';
import { sampleRenderer } from './ap06-r10-memory.mjs';
import { checkCase, networkGuardSnapshot, validateCleanNetwork, strictHttpFailure, validateHttpFailure, validatePreflightConsistency, cleanupContext, credentialAuthDelay } from './ap06-preflight.mjs';

const r9=process.env.AP06_R9_CHECK==='1',r10=process.env.AP06_R10_CHECK==='1',backendExperiment=r9||r10;
const conditions=r10?Object.keys(R10_CONDITIONS):r9?Object.keys(TRANSPORTS):['r8.0','r8.1','r8.2'];
const configure=r10?configureR10Page:r9?configureR9Page:configureIntegrationPage;
const initializeTransport=r10?initializeR10Page:r9?initializeR9Page:initializeIntegrationPage;
const authAttempts=[],authReadyAt=performance.now()+60250;
async function initialize(page,fixtures,condition){
  if(r10){
    const delay=credentialAuthDelay(authAttempts,performance.now(),authReadyAt);
    result.preflight.authSchedule.push({condition,delayMs:delay,attempt:authAttempts.length+1});save();
    if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
    authAttempts.push(performance.now());
  }
  return initializeTransport(page,fixtures,condition);
}
const output=process.env.AP06_R7_UNIT_OUTPUT;
if(!output)throw new Error('OWNED_R7_UNIT_OUTPUT_REQUIRED');
const fixtures=JSON.parse(readFileSync(process.env.AP06_R5_FIXTURE_MANIFEST,'utf8'));
const paths=JSON.parse(process.env.AP06_R7_ALLOWED_PATHS),origin=process.env.AP06_R5_MEDIA_ORIGIN;
const result={status:'FAIL',measurementBrowsers:0,unitBrowserLaunchAttempts:0,unitBrowserLaunches:0,browserClosed:false,
  cases:[],observations:{},boundaryCounters:{},transportProofs:{},rangeNetworks:{},rendererMemoryPreflight:{},negativeHttp:{},
  preflight:{schema:1,failures:[],contexts:[],authSchedule:[]},sourceBufferChecks:[],
  multiplexedContract:{fixtureHash:createHash('sha256').update(readFileSync(process.env.AP06_R5_FIXTURE_MANIFEST)).digest('hex'),
    workerHashes:{crypto:process.env.AP06_R5_CRYPTO_WORKER_SHA256,transmux:process.env.AP06_R5_TRANSMUX_WORKER_SHA256},initDataPerFixture:[1,1,1],initDataId:0},
  pageScriptSha256:createHash('sha256').update(integrationPageScript()).digest('hex'),appProducts:JSON.parse(process.env.AP06_R7_APP_PRODUCTS),
  sourceHashes:Object.fromEntries(['ap06-transmux-probe.mjs','ap06-orchestration-probe.mjs','ap06-integration-probe.mjs','ap06-r7-instrumentation.mjs',
    'ap06-angular-integration-check.mjs','ap06-preflight.mjs','ap06-r9-network.mjs'].map(name=>[name,createHash('sha256').update(readFileSync(new URL(name,import.meta.url))).digest('hex')]))};
const save=()=>writeJsonAtomic(output,result);
let browser,browserSession;
const ownedPids=new Set();
async function rememberPids(){
  if(!browserSession)return;
  const {processInfo}=await browserSession.send('SystemInfo.getProcessInfo');
  for(const process of processInfo)ownedPids.add(process.id);
  result.ownedPids=[...ownedPids];save();
}
const stateOf=page=>page.evaluate(()=>({counters:window.r5Counters,media:document.querySelectorAll('video,audio').length}));
const events=raw=>[...(raw.rangeNetwork?.requests??[]),...(raw.rangeNetwork?.bootstrapRequests??[]),...(raw.rangeNetwork?.optionsRequests??[])]
  .map(row=>({requestId:row.requestId,method:row.method,url:row.url,type:row.type,status:row.status,finished:row.finished,failed:row.failed}));

// Positive, Range error, cancellation and Store error share bootstrap, never a context.
async function withContext(condition,scenario,action){
  const record={condition,scenario,gate:'bootstrap',closed:false,routesRemoved:false,listenersDetached:false,sessionDetached:false,cleanupStatus:'PENDING'};
  result.preflight.contexts.push(record);let context,page,cdp,closeObservation;const raw={},routes=[];
  await checkCase(result,save,condition,scenario,async()=>{
    let failure;
    try{
      context=await browser.newContext({viewport:{width:1280,height:720},serviceWorkers:'block'});
      page=await context.newPage();closeObservation=await configure(page,context,raw,origin,paths,condition);
      await page.addInitScript({content:integrationPageScript()});await page.goto(origin);
      await page.evaluate(({counters,crypto,transmux})=>{
        window.r5Counters=counters;window.r5CryptoWorkerSource=crypto;window.r5TransmuxWorkerSource=transmux;
      },{counters:newIntegrationCounters(),crypto:readFileSync(process.env.AP06_R5_CRYPTO_WORKER,'utf8'),transmux:readFileSync(process.env.AP06_R5_TRANSMUX_WORKER,'utf8')});
      cdp=await context.newCDPSession(page);
      await action({page,context,raw,record,cdp,route:async(url,handler)=>{
        const scoped=async route=>{
          try{await handler(route);}catch(error){record.routeFailureCode=/^R10_[A-Z_]+$/.test(error.message)?error.message:'R10_ROUTE_FAILED';await route.abort('failed');}
        };
        routes.push([url,scoped]);await context.route(url,scoped);
      }});
      if(record.routeFailureCode)throw new Error(record.routeFailureCode);
    }catch(error){failure=error;}
    finally{
      const errors=[];
      const cleanup=async action=>{try{await action();}catch(error){errors.push(error);}};
      if(page)await cleanup(async()=>{
        const state=await stateOf(page);
        record.lifecycle={ownership:integrationSnapshot(state.counters),observed:state.counters.observed,mediaNodes:state.media};
        validateIntegrationCleanup(state.counters,state.media);record.cleanupStatus='PASS';
      });
      await cleanup(rememberPids);
      errors.push(...await cleanupContext({routes,observer:closeObservation,cdp,context},record));
      record.listenersDetached=raw.rangeNetwork?.listenersDetached??!backendExperiment;
      record.sessionDetached=raw.rangeNetwork?.sessionDetached??!backendExperiment;
      record.guards??=networkGuardSnapshot(raw);record.network=events(raw);
      record.rangeNetwork=raw.rangeNetwork??null;record.backendTraffic=raw.backendTraffic??null;
      if(errors.length){record.cleanupStatus='FAIL';record.cleanupErrors=errors.map(error=>error.name);failure??=new Error('R10_CONTEXT_CLEANUP_FAILED');}
      save();
    }
    if(failure)throw failure;
  },async()=>({gate:record.gate,raw,lifecycle:record.lifecycle,resources:record,network:events(raw)}));
}

async function positive({page,raw,record,cdp},condition){
  record.gate='original DI';const proof=await initialize(page,fixtures,condition);
  if(backendExperiment)result.transportProofs[condition]=proof;
  assert.ok(Object.values(await page.evaluate(()=>({...window.r7Contracts(),...window.r7InstrumentationContracts()}))).every(Boolean));
  async function windowListeners(){
    const {result:object}=await cdp.send('Runtime.evaluate',{expression:'window',objectGroup:'r7-unit-listeners'});
    try{const {listeners}=await cdp.send('DOMDebugger.getEventListeners',{objectId:object.objectId});return listeners.filter(listener=>listener.type==='keydown').length;}
    finally{await cdp.send('Runtime.releaseObjectGroup',{objectGroup:'r7-unit-listeners'});}
  }
  const listenersBefore=await windowListeners();record.gate='ABC playback and lifecycle';
  for(const fixture of fixtures){
    const before=await page.evaluate(()=>({...window.r5Counters.observed}));
    await page.evaluate(fixture=>window.r7Run(fixture),fixture);
    const after=await page.evaluate(()=>({...window.r5Counters.observed}));
    assert.equal(after.sourceBuffersCreated-before.sourceBuffersCreated,1);assert.equal(after.sourceBuffersReleased-before.sourceBuffersReleased,1);assert.equal(after.pendingAppends,0);
    result.sourceBufferChecks.push({condition,fixture:fixture.id,tracks:fixture.tracks.length,created:after.sourceBuffersCreated-before.sourceBuffersCreated,released:after.sourceBuffersReleased-before.sourceBuffersReleased});save();
  }
  const state=await stateOf(page),c=state.counters.observed;
  result.observations[condition]=state.counters.sessions;result.boundaryCounters[condition]=c;
  validateIntegrationFunctional(state.counters,state.media);
  assert.equal(c.playbackCompleted,3);assert.equal(c.workersCreated,6);assert.ok(c.detachedTransfers>0);
  if(r10)assert.ok(c.workerTransferBytesSent>0);
  assert.ok(state.counters.sessions.every(s=>s.maxCurrentTime>1.5&&s.maxCurrentTime<10&&s.seeks===0&&s.muted===false&&s.volume===1&&s.playbackRate===1&&s.playbackMs-s.canplayMs>=450));
  assert.equal(await windowListeners(),listenersBefore);assert.equal(c.componentsMounted,6);
  if(condition!=='r8.0'){
    assert.equal(c.storeLoadStarted,1);assert.equal(c.storeLoadCompleted,1);assert.equal(c.storeFileResolved,3);assert.equal(c.storeEffectsSettled,1);
  }
  assert.equal(c.unexpectedPeripheralOperations,0);assert.equal(c.outstandingSubscriptions,0);
  if(condition==='r8.2'||backendExperiment){
    assert.equal(c.authAttempts,1);assert.equal(c.authSuccesses,1);assert.equal(c.backendFileIdMatches,3);
    assert.equal(c.http206Validated,c.rangeRequestsCompleted);assert.equal(c.jwtRangesValidated,condition==='r9-r2.2'?0:c.rangeRequestsStarted);
    assert.equal(await page.evaluate(()=>[...Object.values(localStorage),...Object.values(sessionStorage)].some(value=>/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(value))),false);
  }
  record.gate='passive CDP and Auth/Store';
  if(backendExperiment){
    const network=raw.rangeNetwork;assert.equal(network.requests.length,c.rangeRequestsCompleted);
    assert.ok(network.requests.every(row=>row.finished&&!row.failed&&row.status===206&&row.type===(condition==='r9-r2.0'||condition==='r10.0'?'XHR':'Fetch')&&!row.fromDiskCache&&!row.fromServiceWorker));
    result.rangeNetworks[condition]={cdp:structuredClone(network)};
    if(r10){
      result.rendererMemoryPreflight[condition]=await sampleRenderer(cdp);
      const rows=network.bootstrapRequests;assert.deepEqual(rows.map(row=>row.kind).sort(),['auth','pending','tree']);
      assert.ok(rows.every(row=>row.type===R10_CONDITIONS[condition].otherType&&row.status===200&&row.finished));
    }
  }
  if(condition!=='r8.0'){
    record.gate='Store refresh without transfers';
    for(let index=0;index<2;index++)assert.deepEqual(await page.evaluate(()=>window.r8RefreshStore()),{files:3,visibleFiles:3,transfers:0,thumbnails:0,outstandingSubscriptions:0});
    assert.equal(await windowListeners(),listenersBefore);
  }
  record.gate='positive network guards';record.guards=validateCleanNetwork(raw,condition);
}

async function cancellation({page,record},condition){
  await initialize(page,fixtures,condition);record.gate='cancel active Range';
  const cancelled=await page.evaluate(async fixture=>{
    const pending=window.r7Run(fixture);pending.catch(()=>{});
    for(let tick=0;tick<30&&window.r5Counters.observed.activeRanges===0;tick++)await Promise.resolve();
    if(window.r5Counters.observed.activeRanges===0)throw new Error('UNIT_RANGE_DID_NOT_START');
    window.r7CancelSession();try{await pending;return false;}catch{return true;}
  },fixtures[2]);
  assert.equal(cancelled,true);const state=await stateOf(page);validateIntegrationCleanup(state.counters,state.media);
  assert.ok(state.counters.observed.rangeRequestsAborted>=1);
  record.gate='inconsistent Store container size';const before=state.counters.observed.storeFileResolved;
  await assert.rejects(page.evaluate(fixture=>window.r7Run(fixture),{...fixtures[0],ciphertextBytes:fixtures[0].ciphertextBytes-1}),/R8_STORE_FILE_IDENTITY_INVALID/);
  assert.equal((await stateOf(page)).counters.observed.storeFileResolved,before);
}

let completed=false;
try{
  await checkCase(result,save,'preflight','Chromium launch and version',async()=>{
    result.unitBrowserLaunchAttempts++;save();browser=await chromium.launch({args:AUTOPLAY_ARGS});result.unitBrowserLaunches++;save();assert.equal(browser.version(),'151.0.7922.34');
    browserSession=await browser.newBrowserCDPSession();await rememberPids();
  });
  for(const condition of conditions){
    await withContext(condition,'positive',ctx=>positive(ctx,condition));
    if(backendExperiment){
      const record=result.preflight.contexts.at(-1),network=result.rangeNetworks[condition];
      network.cdp.listenersDetached=record.listenersDetached;network.cdp.sessionDetached=record.sessionDetached;network.backend=record.backendTraffic;
    }
  }
  if(r10)await checkCase(result,save,'preflight','equal Range workload across three transports',async()=>{
    const signatures=conditions.map(condition=>({
      ranges:result.rangeNetworks[condition].cdp.requests.map(row=>({fixture:row.fixture,fileId:row.fileId,range:row.range,status:row.status,
        contentRange:row.headers['content-range'],contentLength:row.headers['content-length']})),
      requests:result.boundaryCounters[condition].rangeRequestsCompleted,bodyBytes:result.boundaryCounters[condition].rangeBytesReceived,
      transferBytes:result.boundaryCounters[condition].workerTransferBytesSent,mseBytes:result.boundaryCounters[condition].bytesAppended}));
    assert.ok(signatures[0].requests>0&&signatures[0].bodyBytes>0&&signatures[0].transferBytes>0);
    for(const signature of signatures)assert.deepEqual(signature,signatures[0]);
    result.workload={...signatures[0],allThreeTransportsEqual:true,developmentCycles:1};
  });
  if(r10)for(const condition of conditions){
    let observed,proof;
    await withContext(condition,'GET 403',async({page,route,record})=>{
      await initialize(page,fixtures,condition);record.gate='authenticated GET 403';
      const mapping=JSON.parse(process.env.AP06_R8_FILE_MAPPING),file=mapping.find(row=>row.fixture===0);
      observed={options:0,get:0};const url=`http://127.0.0.1:42187/files/${file.fileId}/download`;
      await route(url,strictHttpFailure({url,origin,fileId:file.fileId,ciphertextBytes:fixtures[0].ciphertextBytes},observed));
      proof=await page.evaluate(()=>window.r10NegativeRange());result.negativeHttp[condition]={observed,proof};
    });
    const record=result.preflight.contexts.at(-1);
    await checkCase(result,save,condition,'403 CDP, Angular and cleanup proof',async()=>{
      validateHttpFailure(record.rangeNetwork,observed,proof,R10_CONDITIONS[condition].rangeType);
      const c=record.lifecycle.observed;assert.equal(c.rangeRequestsStarted,1);assert.equal(c.rangeRequestsFailed,1);assert.equal(c.jwtRangesValidated,1);assert.equal(c.workersCreated,0);
      result.negativeHttp[condition].network=record.rangeNetwork;
    },async()=>({gate:'403 proof',lifecycle:record.lifecycle,resources:record,network:record.network}));
  }
  for(const condition of conditions.filter(c=>backendExperiment||c==='r8.2'))await withContext(condition,'cancellation',ctx=>cancellation(ctx,condition));
  const negativeCondition=r10?'r10.0':r9?'r9-r2.0':'r8.2';
  await withContext(negativeCondition,'Store HTTP 500',async({page,route,record})=>{
    record.gate='Store readiness rejects HTTP 500';
    const observed={options:0,get:0},url='http://127.0.0.1:42187/tree?file_limit=100&file_offset=0';
    await route(url,strictHttpFailure({url,origin},observed,500));
    await assert.rejects(initialize(page,fixtures,negativeCondition),/R8_STORE_LOAD_FAILED/);
    const state=await stateOf(page);assert.equal(state.counters.observed.storeLoadStarted,1);assert.equal(state.counters.observed.storeLoadCompleted,0);assert.equal(state.counters.observed.workersCreated,0);assert.equal(observed.get,1);
  });
  completed=true;
}catch{process.exitCode=1;}
finally{
  await checkCase(result,save,'preflight','Chromium cleanup',async()=>{
    try{await rememberPids();if(browserSession)await browserSession.detach();}
    finally{if(browser)await browser.close();result.browserClosed=true;}
    if(ownedPids.size){
      result.processExitAudit=JSON.parse(execFileSync(process.env.WAVE1_PYTHON,[process.env.AP06_R8_PID_AUDITOR,'--closed-pids',[...ownedPids].join(',')],{windowsHide:true,encoding:'utf8'}));
      assert.equal(result.processExitAudit.status,'PASS');
    }
  }).catch(()=>{process.exitCode=1;});
  if(completed)await checkCase(result,save,'preflight','terminal cleanup state',async()=>{
    assert.ok(result.preflight.contexts.every(record=>record.closed&&record.cleanupStatus==='PASS'));
  }).catch(()=>{completed=false;process.exitCode=1;});
  if(completed){
    try{validatePreflightConsistency(result,conditions);result.status='PASS';}
    catch(error){await checkCase(result,save,'preflight','receipt consistency',async()=>{throw error;}).catch(()=>{process.exitCode=1;});}
  }
  result.failureClass=result.preflight.failures[0]?.class??null;result.failure=result.preflight.failures[0]?.code??null;save();
  console.log(JSON.stringify({status:result.status,cases:result.cases.length,failures:result.preflight.failures,unitBrowserLaunches:result.unitBrowserLaunches}));
}
