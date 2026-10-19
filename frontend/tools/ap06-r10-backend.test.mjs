import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { firstValueFrom, of, throwError } from 'rxjs';

const bundle = buildSync({ stdin: { contents: "import '@angular/compiler'; export * from './experiments/ap06-r7/r10-range-backend.ts';",
  resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, platform: 'node', format: 'esm', write: false });
const { buildRangeAllowlist, inspectRangeRequest, R10RangeBackend, selectR10Condition } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const files = [101,102,103].map(id => ({ id, ciphertextBytes:100 }));
const allowlist = buildRangeAllowlist(files);
function request(url='http://127.0.0.1:42187/files/101/download', range='bytes=10-13', extra={}) {
  const headers = new Map([['Range',range],['Authorization','Bearer synthetic-unit-token']]);
  return { method:'GET',urlWithParams:url,withCredentials:true,headers:{ get:key=>headers.get(key)??null },...extra };
}
test('strict bootstrap conditions and allowlist reject ambiguous identities', () => {
  for (const value of ['r10.0','r10.1','r10.2']) assert.equal(selectR10Condition(value),value);
  assert.equal(selectR10Condition(undefined),null);
  for (const value of [null,'',{},'r9-r2.1']) assert.throws(()=>selectR10Condition(value));
  for (const values of [[files[0]], [files[0],files[0],files[2]],files.map(row=>({...row,id:-row.id}))]) {
    assert.throws(()=>buildRangeAllowlist(values));
  }
});
test('exact measured Range and inclusive safe bounds are authorized', () => {
  assert.deepEqual(inspectRangeRequest(request(),allowlist),{id:101,start:10,end:13,total:100,url:'http://127.0.0.1:42187/files/101/download'});
  assert.equal(inspectRangeRequest(request('http://127.0.0.1:42187/login',null,{method:'POST'}),allowlist),null);
  for (const url of ['http://127.0.0.1:42187/tree?file_limit=100&file_offset=0','http://127.0.0.1:42187/pending-uploads']) {
    assert.equal(inspectRangeRequest(request(url,null),allowlist),null);
  }
});
test('external, traversal, query, unknown ID, malformed Range, missing JWT/cookies fail closed', () => {
  for (const url of ['https://external.test/files/101/download','http://localhost:42187/files/101/download',
    'http://127.0.0.1:42188/files/101/download','http://127.0.0.1:42187/files/104/download',
    'http://127.0.0.1:42187/files/101/download?x=1','http://127.0.0.1:42187/files/102/../101/download',
    'http://127.0.0.1:42187/files/%31%30%31/download','http://127.0.0.1:42187/login?x=1']) {
    assert.throws(()=>inspectRangeRequest(request(url),allowlist));
  }
  for (const range of [null,'bytes=0-100','bytes=-1-2','bytes=1-0','bytes=01-2','bytes=0-','bytes=0-1,3-4','bytes=0-9007199254740992']) {
    assert.throws(()=>inspectRangeRequest(request(undefined,range),allowlist));
  }
  for (const extra of [{method:'POST'},{withCredentials:false},{headers:{get:()=>null}}]) {
    assert.throws(()=>inspectRangeRequest(request(undefined,undefined,extra),allowlist));
  }
});
test('selective backend delegates only authorized Ranges to Fetch and preserves request identity', async () => {
  const calls=[];
  const backend={allowlist:()=>allowlist,xhr:{handle:req=>{calls.push(['xhr',req]);return of('xhr');}},
    fetchBackend:{handle:req=>{calls.push(['fetch',req]);return of('fetch');}}};
  const range=request(),login=request('http://127.0.0.1:42187/login',null,{method:'POST'});
  assert.equal(await firstValueFrom(R10RangeBackend.prototype.handle.call(backend,range)),'fetch');
  assert.equal(await firstValueFrom(R10RangeBackend.prototype.handle.call(backend,login)),'xhr');
  assert.equal(calls[0][1],range);assert.equal(calls[1][1],login);
  assert.throws(()=>R10RangeBackend.prototype.handle.call(backend,request(undefined,'bytes=0-999')));
  assert.equal(calls.length,2);
});
test('selective transport errors propagate once without XHR fallback or hidden retry', async()=>{
  let fetchCalls=0,xhrCalls=0;
  const error=new Error('synthetic transport failure');
  const backend={allowlist:()=>allowlist,fetchBackend:{handle:()=>{fetchCalls++;return throwError(()=>error);}},xhr:{handle:()=>{xhrCalls++;return of('unexpected');}}};
  await assert.rejects(firstValueFrom(R10RangeBackend.prototype.handle.call(backend,request())),e=>e===error);
  assert.equal(fetchCalls,1);assert.equal(xhrCalls,0);
});
