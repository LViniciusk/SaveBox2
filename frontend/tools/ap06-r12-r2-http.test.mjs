import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';
import ts from 'typescript';
import {of,firstValueFrom,defer,finalize,tap,Observable,throwError} from 'rxjs';
import {CONDITIONS,transportCounts} from './ap06-r12-r2-contract.mjs';
import {newIntegrationCounters} from './ap06-r7-instrumentation.mjs';
const bundle=buildSync({stdin:{contents:"import '@angular/compiler';export * from './experiments/ap06-r7/r12-r2-range-backend.ts';export * from './experiments/ap06-r7/r10-range-backend.ts';export * from './experiments/ap06-r7/range-adapter.ts';export {CONDITIONS} from './tools/ap06-r12-r2-contract.mjs';",resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,platform:'node',format:'esm',write:false});
const helpers=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text+"\n//# sourceURL=ap06-r12-r2-test-bundle.mjs").toString('base64'));
const protocol=[101,102,103].flatMap(id=>[{id,start:0,end:131071},{id,start:114,end:4194433},{id,start:4194434,end:8388753}]);
const allowlist=helpers.buildRangeAllowlist([101,102,103].map(id=>({id,ciphertextBytes:10000000})));
function request(row=protocol[0],extra={}){
  const url=`http://127.0.0.1:42187/files/${row.id}/download`,values=new Map([['Range',`bytes=${row.start}-${row.end}`],['Authorization','Bearer synthetic-only']]);
  return {method:'GET',url,urlWithParams:url,responseType:'blob',withCredentials:true,
    headers:{get:k=>values.get(k)??null,has:k=>values.has(k)},clone(change){return {...this,...change};},...extra};
}
function backend(condition){
  const calls=[];return {condition:helpers.CONDITIONS[condition],cursor:0,protocol:()=>protocol,allowlist:()=>allowlist,calls,
    xhr:{handle:req=>{calls.push(['xhr',req]);return of('xhr');}},fetchBackend:{handle:req=>{calls.push(['fetch',req]);return of('fetch');}}};
}
test('actual mixed backend routes all 54 exact ranges and keeps Auth/Store XHR',async()=>{
  for(const [condition,selected] of Object.entries(CONDITIONS)){
    const b=backend(condition),handle=req=>helpers.R12R2RangeBackend.prototype.handle.call(b,req);
    for(const [url,method] of [['login','POST'],['tree?file_limit=100&file_offset=0','GET'],['pending-uploads','GET']]){
      await firstValueFrom(handle(request(undefined,{urlWithParams:'http://127.0.0.1:42187/'+url,method,headers:{get:()=>null}})));assert.equal(b.calls.at(-1)[0],'xhr');
    }
    for(let i=0;i<54;i++){
      const row=protocol[i%9],req=request(row);await firstValueFrom(handle(req));assert.equal(b.calls.at(-1)[0],selected[i%3===0?'metadata':'payload']);assert.equal(b.calls.at(-1)[1],req);
    }
    assert.throws(()=>handle(request()),/CONTRACT/);
  }
});
test('exact backend fails closed before delegation for wrong identity/sequence/type/headers',()=>{
  for(const condition of Object.keys(CONDITIONS))for(const bad of [request(protocol[1]),request({...protocol[0],end:1023}),request({...protocol[0],id:104}),
    request(undefined,{responseType:'arraybuffer'}),request(undefined,{withCredentials:false}),request(undefined,{headers:{get:()=>null}}),
    request(undefined,{urlWithParams:'https://outside.test/files/101/download'})]){
    const b=backend(condition);assert.throws(()=>helpers.R12R2RangeBackend.prototype.handle.call(b,bad));assert.equal(b.cursor,0);assert.equal(b.calls.length,0);
  }
});
const source=readFileSync(new URL('../experiments/ap06-r7/r8-integration.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('r8.ts',source,ts.ScriptTarget.Latest,true);
const expression=tree.statements.flatMap(s=>ts.isVariableStatement(s)?[...s.declarationList.declarations]:[]).find(n=>n.name.getText(tree)==='observeR8Http').initializer.getText(tree);
const factory=new Function('deps',ts.transpile(`const {defer,finalize,tap,inspectRangeRequest,validateBounds,validatePartialResponse,selectedFactorial,FACTORIAL_CONDITIONS,window,c}=deps;
const selectedR12=null,selectedR11=null,r10Condition='r10.1',r10Allowlist=deps.allowlist,fixtures=[{id:101,ciphertextBytes:10000000}],expectedId=f=>f.id,HttpEventType={Response:4};return ${expression};`));
test('actual interceptor preserves JWT/206/bounds/body/cancel guards and scalar routing only',async()=>{
  for(const condition of Object.keys(CONDITIONS)){
    const core=newIntegrationCounters().observed,routing=transportCounts(condition,0);
    const observe=factory({...helpers,defer,finalize,tap,selectedFactorial:condition,FACTORIAL_CONDITIONS:CONDITIONS,window:{r12r2Routing:routing},c:()=>core,allowlist});
    const row=protocol[0],req=request(row),body=new Blob([new Uint8Array(131072)]);
    const response={type:4,status:206,url:req.url,body,headers:{get:k=>k==='Content-Range'?'bytes 0-131071/10000000':k==='Content-Length'?'131072':null}};
    await firstValueFrom(observe(req,()=>of(response)));assert.equal(routing['metadata'+CONDITIONS[condition].metadata+'Bytes'],131072);
    for(const bad of [{status:200},{url:'https://outside.test'},{body:new ArrayBuffer(131072)},{body:new Blob(['short'])},{headers:{get:()=>null}}])await assert.rejects(firstValueFrom(observe(req,()=>of({...response,...bad}))));
    await assert.rejects(firstValueFrom(observe({...req,responseType:'arraybuffer'},()=>of(response))));
    const sub=observe(req,()=>new Observable(()=>()=>{})).subscribe();sub.unsubscribe();assert.equal(core.rangeRequestsAborted,6);
    await assert.rejects(firstValueFrom(observe(req,()=>throwError(()=>new Error('network-failed')))));
    assert.equal(core.outstandingSubscriptions,0);assert.equal(core.activeRanges,0);assert.equal(core.pendingOperations,0);
    assert.ok(Object.values(routing).every(v=>typeof v==='number'));assert.equal(Object.keys(routing).length,8);
  }
});
