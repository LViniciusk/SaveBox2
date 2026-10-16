import test from 'node:test';
import assert from 'node:assert/strict';
import { R11_CONDITIONS, selectR11, classifyStages, confirmFormal } from './ap06-r11-contract.mjs';
import { newR11Counters, installR11Instrumentation, validateR11Stage } from './ap06-r11-instrumentation.mjs';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

test('strict selectors and conflicts', () => {
  for (const c of Object.keys(R11_CONDITIONS)) assert.equal(selectR11(c), c);
  assert.equal(selectR11(undefined), null);
  for (const bad of [null,'r11.4','toString',{},0,['r11.0'],{toString:()=>'r11.0'}]) assert.throws(() => selectR11(bad));
  assert.throws(() => selectR11('r11.0','r10.0'));
  assert.throws(() => selectR11('r11.0',undefined,'xhr'));
});
test('pre-registered candidates, intermediate and non-reproduction', () => {
  const run=(x,y,c=450)=>classifyStages({'r11.0':35,'r11.1':c,'r11.2':x,'r11.3':y});
  assert.equal(run(400,420).hypothesis,'H1'); assert.equal(run(50,400).hypothesis,'H2');
  assert.equal(run(50,60).hypothesis,'H3'); assert.equal(run(180,400).status,'R11_INCONCLUSIVE');
  assert.equal(run(400,50).status,'R11_INCONCLUSIVE'); assert.equal(run(20,20,299).status,'R11_CONTROL_NOT_REPRODUCED');
  assert.throws(()=>run(NaN,20));
});
test('every formal replicate and frozen order must agree', () => {
  const candidate={status:'R11_CANDIDATE',hypothesis:'H2',pair:['r11.2','r11.3']};
  const rows=['r11.2','r11.3','r11.3','r11.2','r11.2','r11.3'].map(condition=>({condition,rendererPrivateDeltaMiB:condition==='r11.2'?50:400}));
  assert.equal(confirmFormal(candidate,450,rows).status,'R11_ATTRIBUTION_CONFIRMED');
  rows[4].rendererPrivateDeltaMiB=200;
  assert.equal(confirmFormal(candidate,450,rows).status,'R11_INCONCLUSIVE');
});
test('partial stages forbid media and require balanced scalar counters', () => {
  const c=newR11Counters();
  Object.assign(c,{blobCount:1,blobBytes:16,arrayBufferCount:1,arrayBufferBytes:16});
  validateR11Stage('r11.2',c,{workersCreated:0,mediaSourcesCreated:0,bytesAppended:0});
  assert.throws(()=>validateR11Stage('r11.2',c,{workersCreated:1,mediaSourcesCreated:0,bytesAppended:0}));
  assert.throws(()=>validateR11Stage('r11.3',c,{workersCreated:2,mediaSourcesCreated:1,bytesAppended:0}));
});
test('instrumentation source stores weak records and scalars without payload serialization', () => {
  const source=installR11Instrumentation.toString();
  assert.match(source,/WeakSet/); assert.doesNotMatch(source,/new Map|new Set|JSON.stringify|\.push\(/);
});

test('real scoped Blob materialization and slice count without retaining payloads', async()=>{
  const originalBlob=Blob.prototype.arrayBuffer,originalSlice=ArrayBuffer.prototype.slice,previous=globalThis.window;
  globalThis.window={r11Counters:newR11Counters()};
  try {
    installR11Instrumentation();const c=window.r11Counters;
    await new Blob(['unobserved']).arrayBuffer();assert.equal(c.arrayBufferCount,0);
    const blob=new Blob([new Uint8Array(16)]);window.r11ObserveBlob(blob);window.r11ObserveBlob(blob);
    const buffer=await blob.arrayBuffer();const copy=buffer.slice(0,8);
    assert.equal(c.blobCount,1);assert.equal(c.arrayBufferBytes,16);assert.equal(c.sliceBytes,8);
    structuredClone(copy,{transfer:[copy]});window.r11ObserveTransfer(1,8,Number(copy.byteLength===0));
    assert.equal(c.detachedBuffers,1);assert.equal(c.materializationsPending,0);
    window.r11ObserveWorkerResponse({type:'CHUNK_DECRYPTED'});assert.equal(c.workerProtocolFailures,1);
    assert.throws(()=>validateR11Stage('r11.2',c,{}));
  } finally {Blob.prototype.arrayBuffer=originalBlob;ArrayBuffer.prototype.slice=originalSlice;globalThis.window=previous;}
});

test('partial driver uses three exact Ranges and original worker methods, with teardown on errors',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'r11-stage-'));
  const previous=globalThis.Worker;
  try {
    const target=join(directory,'stage.mjs');
    await build({entryPoints:[new URL('ap06-r11-stage.ts',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',outfile:target,logLevel:'silent'});
    const {runR11Stage}=await import(pathToFileURL(target));
    const fixture={id:0,bytes:9*1024*1024,dataOffset:114,ciphertextBytes:9*1024*1024+162};
    const file={id:101,shareFdk:new Uint8Array(32)},calls=[],workers=[];
    globalThis.Worker=class{constructor(){workers.push(this);}terminate(){this.closed=true;}};
    const {of}=await import('rxjs');
    const drive={downloadFileRange:(id,start,end)=>{calls.push([id,start,end]);return of(new Blob([new Uint8Array(end-start+1)]));}};
    const kasumi={extractMetadata:async()=>({expectedSize:fixture.bytes,dataOffset:114,metadata:{}}),extractBaseNonce:async()=>new Uint8Array(24)};
    const stream={sendToCryptoWorker:async(_s,buffer,index)=>{assert.equal(index,0);structuredClone(buffer,{transfer:[buffer]});return new ArrayBuffer(4);},
      sendBootstrapToTransmuxWorker:async()=>({initData:[{id:0}],segments:[{id:0}]}),
      runChunkPipeline:async(s,g,index,count,promise,video)=>{assert.equal(s.sourceBuffers.size,0);assert.equal(video,null);assert.deepEqual([g,index,count],[0,1,1]);await promise;}};
    await runR11Stage('r11.2',fixture,file,drive,kasumi,stream);assert.equal(workers.length,0);
    assert.deepEqual(calls,[[101,0,131071],[101,114,4194433],[101,4194434,8388753]]);
    calls.length=0;await runR11Stage('r11.3',fixture,file,drive,kasumi,stream);assert.equal(workers.length,2);assert.ok(workers.every(w=>w.closed));
    stream.runChunkPipeline=async()=>{throw new Error('CANCELLED');};
    await assert.rejects(runR11Stage('r11.3',fixture,file,drive,kasumi,stream),/CANCELLED/);assert.ok(workers.every(w=>w.closed));
    stream.sendBootstrapToTransmuxWorker=async()=>({initData:[]});
    await assert.rejects(runR11Stage('r11.3',fixture,file,drive,kasumi,stream),/OUTPUT_MISSING/);assert.ok(workers.every(w=>w.closed));
    await assert.rejects(runR11Stage('r11.1',fixture,file,drive,kasumi,stream),/STAGE_FIXTURE_INVALID/);
  }finally{globalThis.Worker=previous;rmSync(directory,{recursive:true,force:true});}
});

// Extract the exact production methods, excluding Angular DI, so protocol tests exercise the reused implementation.
const source=readFileSync(new URL('../src/app/features/drive/services/video-stream.service.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('service.ts',source,ts.ScriptTarget.Latest,true);
const klass=ast.statements.find(n=>ts.isClassDeclaration(n) && n.name.text==='VideoStreamService');
const names=['waitForWorkerResponse','sendToCryptoWorker','sendBootstrapToTransmuxWorker','sendToTransmuxWorker','createAbortError'];
const methods=klass.members.filter(n=>n.name && names.includes(n.name.getText(ast))).map(n=>n.getText(ast)).join('\n');
const timeout=Number(/const WORKER_RESPONSE_TIMEOUT_MS = ([\d_]+)/.exec(source)[1].replaceAll('_',''));
const Driver=new Function(ts.transpile(`const WORKER_RESPONSE_TIMEOUT_MS=${timeout};class Driver{${methods}};return Driver;`))();
test('original worker protocols enforce order, detach, cancellation, error and timeout',async t=>{
  const service=new Driver();const worker=new EventTarget();let sent;
  worker.postMessage=(message,transfers)=>{sent=structuredClone(message,{transfer:transfers});};
  const s={cryptoWorker:worker,transmuxWorker:worker,fdk:new Uint8Array(32),baseNonce:new Uint8Array(24),lifecycleController:new AbortController()};
  const input=new ArrayBuffer(16),promise=service.sendToCryptoWorker(s,input,1);assert.equal(input.byteLength,0);
  assert.equal(sent.type,'DECRYPT_CHUNK');assert.equal(sent.chunkIndex,1);
  worker.dispatchEvent(new MessageEvent('message',{data:{type:'CHUNK_DECRYPTED',chunkIndex:0,decryptedChunk:new ArrayBuffer(4)}}));
  worker.dispatchEvent(new MessageEvent('message',{data:{type:'CHUNK_DECRYPTED',chunkIndex:1,decryptedChunk:new ArrayBuffer(4)}}));
  assert.equal((await promise).byteLength,4);
  let pending=service.sendToTransmuxWorker(s,new ArrayBuffer(4),2,true);s.lifecycleController.abort();await assert.rejects(pending,/abort/i);
  s.lifecycleController=new AbortController();pending=service.sendToTransmuxWorker(s,new ArrayBuffer(4),2,true);
  worker.dispatchEvent(new MessageEvent('message',{data:{type:'ERROR',chunkIndex:2,message:'WORKER_ERROR'}}));await assert.rejects(pending,/WORKER_ERROR/);
  t.mock.timers.enable({apis:['setTimeout']});
  pending=service.sendToTransmuxWorker(s,new ArrayBuffer(4),2,true);t.mock.timers.tick(timeout);
  await assert.rejects(pending,{name:'WorkerResponseTimeoutError'});t.mock.timers.reset();
});

test('formal ABBAAB rejects every inconsistent replicate, wrong order and missing replicate for H1 H2 H3',()=>{
  for (const [hypothesis,pair] of [['H1',['r11.0','r11.2']],['H2',['r11.2','r11.3']],['H3',['r11.3','r11.1']]]) {
    const candidate={status:'R11_CANDIDATE',hypothesis,pair},[a,b]=pair;
    const rows=[a,b,b,a,a,b].map(condition=>({condition,rendererPrivateDeltaMiB:condition===a?50:400}));
    assert.equal(confirmFormal(candidate,450,rows).hypothesis,hypothesis);
    for(let i=0;i<6;i++) {
      const bad=structuredClone(rows);bad[i].rendererPrivateDeltaMiB=200;
      assert.equal(confirmFormal(candidate,450,bad).status,'R11_INCONCLUSIVE');
      const order=structuredClone(rows);order[i].condition=order[i].condition===a?b:a;
      assert.equal(confirmFormal(candidate,450,order).status,'R11_INCONCLUSIVE');
    }
    assert.equal(confirmFormal(candidate,450,rows.slice(1)).status,'R11_INCONCLUSIVE');
  }
});
test('classification retains inclusive 70 percent and exclusive 30 percent boundaries',()=>{
  const classify=(x,y,c=300)=>classifyStages({'r11.0':20,'r11.1':c,'r11.2':x,'r11.3':y});
  assert.equal(classify(210,210).hypothesis,'H1');
  assert.equal(classify(89,210).hypothesis,'H2');
  assert.equal(classify(89,89).hypothesis,'H3');
  for(const [x,y] of [[90,210],[209,210],[-1,10],[210,89]])assert.equal(classify(x,y).status,'R11_INCONCLUSIVE');
  assert.equal(classify(10,10,299).status,'R11_CONTROL_NOT_REPRODUCED');
});
