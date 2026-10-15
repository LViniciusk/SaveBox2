import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleRenderer } from './ap06-r10-memory.mjs';

const heap={usedSize:20,totalSize:40,embedderHeapUsedSize:5,backingStorageSize:10};
const dom={documents:1,nodes:8,jsEventListeners:3};
const session=(h=heap,d=dom)=>({send:async name=>name==='Runtime.getHeapUsage'?h:d});
test('collector returns only finite scalar numbers and makes no invasive calls', async () => {
  const calls=[];const s=session();const send=s.send;s.send=name=>{calls.push(name);return send(name);};
  const result=await sampleRenderer(s);
  assert.deepEqual(calls.sort(),['Memory.getDOMCounters','Runtime.getHeapUsage']);
  assert.equal(result.heap.usedSize,20);assert.equal(result.heap.backingStorageSize,10);
  assert.equal(result.dom.jsEventListeners,3);assert.equal(result.heap.status,'AVAILABLE');
  assert.ok(!JSON.stringify(result).includes('objectId'));
});
test('missing fields and unsupported APIs are unavailable with reasons, never zero', async () => {
  const result=await sampleRenderer(session({usedSize:20,totalSize:40},dom));
  assert.equal(result.heap.backingStorageSize,null);assert.equal(result.heap.status,'PARTIAL');
  assert.equal(result.heap.unavailable.backingStorageSize,'FIELD_NOT_SUPPORTED');
  const unavailable=await sampleRenderer({send:async()=>{throw new Error("Protocol error: method wasn't found");}});
  assert.equal(unavailable.heap.status,'UNAVAILABLE');assert.equal(unavailable.dom.nodes,null);
});
test('invalid numbers and disconnected essential session cannot pass as unavailable', async () => {
  for (const value of [-1,NaN,Infinity,'5',true]) {
    await assert.rejects(sampleRenderer(session({...heap,backingStorageSize:value})),/INVALID/);
  }
  await assert.rejects(sampleRenderer(session(heap,{...dom,nodes:1.5})),/INVALID/);
  await assert.rejects(sampleRenderer(session({...heap,usedSize:50})),/INVALID_HEAP_SIZE_RELATION/);
  await assert.rejects(sampleRenderer({send:async()=>{throw new Error('Target closed');}}),/Target closed/);
});
