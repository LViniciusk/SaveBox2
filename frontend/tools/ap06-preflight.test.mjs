import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { networkGuardSnapshot, validateCleanNetwork, checkCase, strictHttpFailure,
  validateHttpFailure, validatePreflightConsistency, cleanupContext, credentialAuthDelay } from './ap06-preflight.mjs';
import { observeRangeNetwork } from './ap06-r9-network.mjs';
import { writeJsonAtomic } from './browser-memory-probe.mjs';

const clean=()=>({pageErrors:0,recoveryWarnings:0,network:{rejectedRequests:0,externalRequests:0,unexpectedRequests:0}});
const url='http://127.0.0.1:42187/files/101/download';
const policy={url,origin:'http://127.0.0.1:42088',fileId:101,ciphertextBytes:100};
const request=(method='GET',range='bytes=0-9',other={})=>({method:()=>method,url:()=>url,
  headers:()=>({range,authorization:'Bearer unit-secret',...other})});
const proof=()=>({rejected:true,angularHttpError:true,status:403,lockedBefore:false,lockedAfter:true,authenticated:true});
const negative=()=>({enabledBeforeNavigation:true,listenersDetached:true,sessionDetached:true,duplicateRequestIds:0,
  requests:[{requestId:'a',method:'GET',url,type:'XHR',status:403,finished:true,failed:false,range:'bytes=0-9'}],
  optionsRequests:[{requestId:'o',method:'OPTIONS',url,type:'Preflight',status:204,finished:true,failed:false}]});

test('credential pacing respects native five/minute limit, initial API window and never retries',()=>{
  const source=readFileSync(new URL('../../backend/include/middlewares/RateLimitMiddleware.hpp',import.meta.url),'utf8');
  assert.match(source,/AUTH_LIMIT = 5/);assert.match(source,/now_steady - client.window_start >= std::chrono::minutes\(1\)/);
  assert.equal(credentialAuthDelay([],0,60250),60250);
  assert.equal(credentialAuthDelay([60250,60300,60350,60400],61000,60250),0);
  assert.equal(credentialAuthDelay([60250,60300,60350,60400,60450],61000,60250),59500);
  assert.equal(credentialAuthDelay([60250,60300,60350,60400,60450],120500,60250),0);
  assert.equal(credentialAuthDelay([60250,60300,60350,60400,60450,120500],120501,60250),49);
});
test('an auth 429 has an explicit status gate and actual/expected without copying the raw error message',async()=>{
  const result={cases:[],preflight:{failures:[]}};
  await assert.rejects(checkCase(result,()=>{},'r10.2','GET 403',async()=>{throw new Error('unit-secret');},async()=>({
    gate:'bootstrap',raw:clean(),network:[{method:'POST',url:'http://127.0.0.1:42187/login',status:429}]})));
  const f=result.preflight.failures[0];assert.equal(f.code,'R10_AUTH_BOOTSTRAP_HTTP_429');assert.equal(f.actual,429);assert.equal(f.expected,200);
  assert.equal(JSON.stringify(result).includes('unit-secret'),false);
});

test('every positive guard reports actual/expected and preserves all simultaneous failures',()=>{
  assert.ok(Object.values(validateCleanNetwork(clean(),'r10.0')).every(n=>n===0));
  for(const name of Object.keys(networkGuardSnapshot(clean()))) {
    const raw=clean();if(name in raw)raw[name]=3;else raw.network[name]=3;
    assert.throws(()=>validateCleanNetwork(raw,'r10.1'),error=>error.guard.name===name && error.guard.actual===3 && error.guard.expected===0);
  }
  const raw=clean();raw.pageErrors=2;raw.network.externalRequests=1;
  assert.throws(()=>validateCleanNetwork(raw,'r10.0'),error=>error.counters.pageErrors===2 && error.counters.externalRequests===1);
});
test('strict mock delegates OPTIONS and fulfills only one authenticated bounded GET',async()=>{
  const state={options:0,get:0};const handler=strictHttpFailure(policy,state);const calls=[];
  const route=req=>({request:()=>req,continue:async()=>calls.push('continue'),fulfill:async data=>calls.push(data),abort:async()=>calls.push('abort')});
  await handler(route(request('OPTIONS')));await handler(route(request()));
  assert.equal(calls[0],'continue');assert.equal(calls[1].status,403);assert.deepEqual(state,{options:1,get:1});
  await assert.rejects(handler(route(request())),/ADDITIONAL/);
  for(const req of [request('POST'),request('GET','bytes=0-100'),request('GET','bytes=0-'),request('GET','bytes=0-9',{authorization:''})]) {
    const observed={options:0,get:0};await assert.rejects(strictHttpFailure(policy,observed)(route(req)),/NEGATIVE/);
  }
});
test('403 evidence rejects CORS/network errors, missing GET, status/type/identity duplicates and retries',()=>{
  validateHttpFailure(negative(),{options:1,get:1},proof(),'XHR');
  const mutations=[d=>d.requests.splice(0),d=>d.requests.push({...d.requests[0],requestId:'b'}),
    d=>d.requests[0].status=200,d=>d.requests[0].type='Fetch',d=>d.requests[0].failed=true,
    d=>d.requests[0].finished=false,d=>d.duplicateRequestIds=1,d=>d.optionsRequests[0].status=403,
    d=>d.optionsRequests[0].requestId='a'];
  for(const change of mutations){const data=negative();change(data);assert.throws(()=>validateHttpFailure(data,{options:1,get:1},proof(),'XHR'));}
  for(const change of [p=>p.status=0,p=>p.rejected=false,p=>p.angularHttpError=false,p=>p.lockedAfter=false]) {
    const p=proof();change(p);assert.throws(()=>validateHttpFailure(negative(),{options:1,get:1},p,'XHR'));
  }
});
test('PENDING is persisted before execution, failure is atomic, bounded stack/diagnostics never include secrets',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ap06-preflight-'));
  try {
    const result={cases:[],preflight:{failures:[]}},path=join(dir,'receipt.json');
    const save=()=>writeJsonAtomic(path,result);
    await assert.rejects(checkCase(result,save,'r10.1','positive',async()=>{
      assert.equal(JSON.parse(readFileSync(path)).cases[0].status,'PENDING');
      const error=new Error('password=unit-secret');error.stack='Error: unit-secret\n    at action (C:/private/unit-secret/ap06-preflight.test.mjs:70:5)\n    at unit-secret';throw error;
    },async()=>({gate:'network',raw:clean(),lifecycle:{workersLive:0},resources:{closed:false}})));
    const saved=JSON.parse(readFileSync(path));assert.equal(saved.cases[0].status,'FAIL');
    assert.equal(saved.preflight.failures[0].gate,'network');assert.equal(saved.preflight.failures[0].frames[0].file,'ap06-preflight.test.mjs');
    assert.equal(JSON.stringify(saved).includes('unit-secret'),false);assert.deepEqual(readdirSync(dir),['receipt.json']);
  } finally {rmSync(dir,{recursive:true});}
});
test('PASS consistency rejects failures, missing conditions, pending cases and unfinished cleanup',()=>{
  const receipt={cases:[{status:'PASS'}],browserClosed:true,preflight:{failures:[],contexts:[{condition:'r8.0',scenario:'positive',closed:true,
    routesRemoved:true,listenersDetached:true,sessionDetached:true,cleanupStatus:'PASS',guards:networkGuardSnapshot(clean())}]}};
  validatePreflightConsistency(receipt,['r8.0']);
  for(const change of [r=>r.preflight.failures.push({}),r=>r.cases[0].status='PENDING',r=>r.browserClosed=false,
    r=>r.preflight.contexts[0].closed=false,r=>r.preflight.contexts[0].cleanupStatus='FAIL',r=>r.preflight.contexts=[]]){
    const r=structuredClone(receipt);change(r);assert.throws(()=>validatePreflightConsistency(r,['r8.0']));
  }
  const missing=structuredClone(receipt);missing.preflight.contexts[0].condition='r10.0';
  assert.throws(()=>validatePreflightConsistency(missing,['r10.0']),/NEGATIVE_CONDITIONS_MISSING/);
});
test('observer OPTIONS is isolated and listener cleanup survives Network.enable/detach exceptions',async()=>{
  const sessions=[];
  const context={newCDPSession:async()=>{const s=new EventEmitter();s.send=async()=>{};s.detach=async()=>{};sessions.push(s);return s;}};
  const a=await observeRangeNetwork(context,{},[{fixture:0,fileId:101}],{optionsHttp:true});
  const b=await observeRangeNetwork(context,{},[{fixture:0,fileId:101}],{optionsHttp:true});
  sessions[0].emit('Network.requestWillBeSent',{requestId:'opt',type:'Other',request:{url,method:'OPTIONS',headers:{}}});
  assert.equal(a.data.optionsRequests.length,1);assert.equal(b.data.optionsRequests.length,0);
  sessions[0].detach=async()=>{throw new Error('detach failed');};
  await assert.rejects(a.close());assert.equal(sessions[0].eventNames().length,0);await b.close();
  const bad=new EventEmitter();let detached=false;bad.send=async()=>{throw new Error('enable failed');};bad.detach=async()=>{detached=true;};
  await assert.rejects(observeRangeNetwork({newCDPSession:async()=>bad},{},[]));
  assert.equal(bad.eventNames().length,0);assert.equal(detached,true);
});
test('unroute/detach exceptions still close the context and cannot report complete cleanup',async()=>{
  const calls=[],record={};const handler=()=>{};
  const errors=await cleanupContext({routes:[[url,handler]],observer:async()=>{calls.push('observer');throw Error('unit failure');},
    cdp:{detach:async()=>{calls.push('detach');}},context:{unroute:async(u,h)=>{assert.equal(u,url);assert.equal(h,handler);calls.push('unroute');throw Error('unit failure');},close:async()=>calls.push('close')}},record);
  assert.deepEqual(calls,['unroute','observer','detach','close']);assert.equal(errors.length,2);
  assert.equal(record.routesRemoved,false);assert.equal(record.closed,true);
});
