import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import ts from 'typescript';
import { defer,finalize,tap,of,throwError,Observable,firstValueFrom } from 'rxjs';
import { R12_CONDITIONS,rangeBodyBytes } from './ap06-r12-contract.mjs';
import { newIntegrationCounters } from './ap06-r7-instrumentation.mjs';
import { captureNaturalIdle } from './ap06-transmux-probe.mjs';

const bundle=buildSync({stdin:{contents:"import '@angular/compiler'; export * from './experiments/ap06-r7/r10-range-backend.ts'; export * from './experiments/ap06-r7/range-adapter.ts';",resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,platform:'node',format:'esm',write:false});
const helpers=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const source=readFileSync(new URL('../experiments/ap06-r7/r8-integration.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('r8.ts',source,ts.ScriptTarget.Latest,true);
const initializer=name=>tree.statements.flatMap(s=>ts.isVariableStatement(s)?[...s.declarationList.declarations]:[]).find(n=>n.name.getText(tree)===name).initializer.getText(tree);
const make=new Function('deps',ts.transpile(`const {defer,finalize,tap,inspectRangeRequest,validateBounds,validatePartialResponse,HttpEventType,selectedR12,selectedR11,r10Condition,r10Allowlist,fixtures,expectedId,c,rangeBodyBytes}=deps;const selectedFactorial=null;return ${initializer('observeR8Http')};`));
const allowlist=helpers.buildRangeAllowlist([101,102,103].map(id=>({id,ciphertextBytes:1000})));
function setup(condition){
  const counters=newIntegrationCounters().observed;
  const selector=new Function('selectedR12','selectedR11','R12_CONDITIONS','window','selectR10Condition',ts.transpile('const selectedFactorial=null;return '+initializer('r10Condition')));
  const alias=selector(condition,null,R12_CONDITIONS,{},helpers.selectR10Condition);
  assert.equal(alias,R12_CONDITIONS[condition].transport==='xhr'?'r10.0':'r10.1');
  const observe=make({...helpers,defer,finalize,tap,HttpEventType:{Response:4},selectedR12:condition,selectedR11:null,r10Condition:alias,r10Allowlist:allowlist,
    fixtures:[{id:101,ciphertextBytes:1000}],expectedId:f=>f.id,c:()=>counters,rangeBodyBytes});
  return {observe,counters};
}
function request(range='bytes=10-13',type='blob'){
  const url='http://127.0.0.1:42187/files/101/download',headers=new Map([['Range',range],['Authorization','Bearer synthetic-test']]);
  return {url,urlWithParams:url,method:'GET',withCredentials:true,responseType:type,headers:{get:k=>headers.get(k)??null,has:k=>headers.has(k)},clone(extra){return {...this,...extra};}};
}
function response(body,range='bytes 10-13/1000',length='4'){
  const headers=new Map([['Content-Range',range],['Content-Length',length]]);
  return {type:4,status:206,url:'http://127.0.0.1:42187/files/101/download',body,headers:{get:k=>headers.get(k)??null}};
}
test('exact interceptor accepts the five formats and keeps historical Blob validation',async()=>{
  for(const condition of Object.keys(R12_CONDITIONS)){
    const {observe,counters}=setup(condition),direct=condition==='r12.4';
    await firstValueFrom(observe(request(undefined,direct?'arraybuffer':'blob'),()=>of(response(direct?new ArrayBuffer(4):new Blob(['abcd'])))));
    await firstValueFrom(observe(request('bytes=0-3'),()=>of(response(new Blob(['abcd']),'bytes 0-3/1000'))));
    assert.equal(counters.rangeBytesReceived,8);assert.equal(counters.pendingOperations,0);assert.equal(counters.rangeRequestsCompleted,2);
  }
});
test('exact interceptor fails JWT, cookies, redirect, origin, status, bounds, type and truncation',async()=>{
  for(const condition of Object.keys(R12_CONDITIONS)){
    const direct=condition==='r12.4',type=direct?'arraybuffer':'blob';
    const good=()=>response(direct?new ArrayBuffer(4):new Blob(['abcd']));
    const cases=[{req:{withCredentials:false}},{req:{headers:{get:()=>null,has:()=>false}}},{req:{urlWithParams:'https://outside.test/files/101/download'}},
      {req:{responseType:direct?'blob':'arraybuffer'}},{res:{url:'http://127.0.0.1:42187/files/102/download'}},{res:{status:200}},
      {res:{body:direct?new Blob(['abcd']):new ArrayBuffer(4)}},{res:{body:direct?new ArrayBuffer(3):new Blob(['abc'])}},
      {res:{headers:{get:()=>null}}},{req:{headers:{get:k=>k==='Range'?'bytes=0-1000':'Bearer test',has:()=>true}}}];
    for(const bad of cases){
      const {observe,counters}=setup(condition);
      await assert.rejects(firstValueFrom(observe({...request(undefined,type),...bad.req},()=>of({...good(),...bad.res}))));
      assert.equal(counters.pendingOperations,0);assert.equal(counters.activeRanges,0);assert.equal(counters.outstandingSubscriptions,0);
    }
    const {observe,counters}=setup(condition);let cancelled=false;
    const subscription=observe(request(undefined,type),()=>new Observable(()=>()=>{cancelled=true;})).subscribe();subscription.unsubscribe();
    assert.ok(cancelled);assert.equal(counters.rangeRequestsAborted,1);assert.equal(counters.pendingOperations,0);
    await assert.rejects(firstValueFrom(observe(request(undefined,type),()=>throwError(()=>new Error('transport-failed')))));
    assert.equal(counters.rangeRequestsFailed,1);assert.equal(counters.pendingOperations,0);
  }
});
test('natural idle checkpoints wait 30 plus 90 seconds without GC or payload operations',async()=>{
  const calls=[];await captureNaturalIdle({waitForTimeout:async ms=>calls.push(ms)},async phase=>calls.push(phase),120000);
  assert.deepEqual(calls,['post-teardown-settled',30000,'idle-30s',90000,'idle-120s']);
  calls.length=0;await captureNaturalIdle({waitForTimeout:async ms=>calls.push(ms)},async phase=>calls.push(phase),30000);
  assert.deepEqual(calls,['post-teardown-settled',30000,'idle-30s']);
  await assert.rejects(captureNaturalIdle({},()=>{},90000));
});
