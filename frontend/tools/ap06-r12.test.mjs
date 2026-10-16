import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { of, Observable, throwError } from 'rxjs';
import { R12_CONDITIONS, R12_CONTRASTS, selectR12, classifyR12, confirmR12, newR12Counters, validateR12Counters, rangeBodyBytes } from './ap06-r12-contract.mjs';

test('R12 selectors are strict, immutable and reject every historical selector',()=>{
  assert.equal(selectR12(undefined),null);
  for(const c of Object.keys(R12_CONDITIONS)){
    assert.equal(selectR12(c),c);assert.ok(Object.isFrozen(R12_CONDITIONS[c]));
    for(let i=0;i<3;i++){const conflicts=[undefined,undefined,undefined];conflicts[i]='selected';assert.throws(()=>selectR12(c,...conflicts));}
  }
  for(const bad of [null,'r12.5','toString',0,{},['r12.0']])assert.throws(()=>selectR12(bad));
});
const values=()=>({'r12.0':20,'r12.1':400,'r12.2':30,'r12.3':420,'r12.4':40});
test('four contrasts, priority, either direction and exact threshold',()=>{
  const examples=[[20,400,30,420,40],[400,400,30,600,40],[400,400,30,420,40],[400,400,400,420,40]];
  for(let i=0;i<4;i++){
    const v=Object.fromEntries(Object.keys(R12_CONDITIONS).map((c,j)=>[c,examples[i][j]]));
    assert.deepEqual(classifyR12(v).pair,R12_CONTRASTS[i]);
  }
  const v=values();v['r12.0']=600;assert.equal(classifyR12(v).highCondition,'r12.0');
  v['r12.0']=550;assert.equal(classifyR12(v).contrast,1);
  v['r12.0']=549;assert.notEqual(classifyR12(v).contrast,1);
  assert.equal(classifyR12(Object.fromEntries(Object.keys(v).map(c=>[c,400]))).status,'R12_INCONCLUSIVE');
  v['r12.3']=299;assert.equal(classifyR12(v).status,'R12_CONTROL_NOT_REPRODUCED');
  for(const bad of [NaN,Infinity,'400',null]){v['r12.3']=bad;assert.throws(()=>classifyR12(v));}
});
test('ABBAAB formal sign and conservative separation use all six replicates',()=>{
  for(const inverted of [false,true]){
    const v=values();if(inverted)v['r12.0']=700;
    const candidate=classifyR12(v),[a,b]=candidate.pair;
    const rows=[a,b,b,a,a,b].map(condition=>({condition,rendererPrivateDeltaMiB:condition===candidate.highCondition?450:300}));
    assert.equal(confirmR12(candidate,420,rows).status,'R12_CONTRAST_CONFIRMED');
    for(let i=0;i<6;i++){
      const bad=structuredClone(rows);bad[i].rendererPrivateDeltaMiB=conditionHigh(bad[i])?449:301;
      function conditionHigh(r){return r.condition===candidate.highCondition;}
      assert.equal(confirmR12(candidate,420,bad).status,'R12_FORMAL_DISAGREEMENT');
      bad[i].condition=bad[i].condition===a?b:a;assert.equal(confirmR12(candidate,420,bad).status,'R12_FORMAL_DISAGREEMENT');
    }
    assert.equal(confirmR12(candidate,420,rows.slice(1)).status,'R12_FORMAL_DISAGREEMENT');
    assert.equal(confirmR12(candidate,299,rows).status,'R12_CONTROL_NOT_REPRODUCED');
  }
});
test('body format is condition AND range scoped, never cross-accepted',()=>{
  for(const c of Object.keys(R12_CONDITIONS)){
    assert.equal(rangeBodyBytes(c,false,new Blob(['abc'])),3);
    assert.equal(rangeBodyBytes(c,true,c==='r12.4'?new ArrayBuffer(3):new Blob(['abc'])),3);
    assert.throws(()=>rangeBodyBytes(c,false,new ArrayBuffer(3)));
    assert.throws(()=>rangeBodyBytes(c,true,c==='r12.4'?new Blob(['abc']):new ArrayBuffer(3)));
  }
});
test('real driver separates metadata, materializes only selected payload and releases references on failure/abort',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ap06-r12-'));
  try{
    const target=join(directory,'stage.mjs');await build({entryPoints:[fileURLToPath(new URL('ap06-r12-stage.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:target,logLevel:'silent'});
    const {runR12Stage}=await import(pathToFileURL(target));
    const fixture={id:0,bytes:9*1024*1024,dataOffset:114,ciphertextBytes:9*1024*1024+162};
    const file={id:101,shareFdk:new Uint8Array(32)};
    for(const condition of Object.keys(R12_CONDITIONS)){
      const c=newR12Counters(),calls=[];let payloadConversions=0,metadataCalls=0;
      const get=(start,end,buffer)=>{calls.push([start,end,buffer]);const bytes=end-start+1;
        if(buffer)return of(new ArrayBuffer(bytes));
        const blob=new Blob([new Uint8Array(bytes)]);if(start){const materialize=blob.arrayBuffer.bind(blob);blob.arrayBuffer=()=>{payloadConversions++;return materialize();};}return of(blob);};
      const drive={downloadFileRange:(_id,start,end)=>get(start,end,false)};
      const kasumi={extractMetadata:async blob=>{metadataCalls++;await blob.arrayBuffer();return {expectedSize:fixture.bytes,dataOffset:114,metadata:{}};},extractBaseNonce:async()=>new Uint8Array(24)};
      const signal=new AbortController().signal;
      await runR12Stage(condition,fixture,file,drive,kasumi,(s,e)=>get(s,e,true),c,signal);
      assert.equal(metadataCalls,1);assert.equal(payloadConversions,condition==='r12.2'||condition==='r12.3'?2:0);
      assert.deepEqual(calls,[[0,131071,false],[114,4194433,condition==='r12.4'],[4194434,8388753,condition==='r12.4']]);
      assert.equal(c.metadataBytes,131072);assert.equal(c.activeReferences,0);assert.equal(c.pendingOperations,0);assert.equal(c.completedOperations,3);
      validateR12Counters(condition,c,1,8388640);
      const cancelled=new AbortController();let released=false;
      drive.downloadFileRange=()=>new Observable(()=>{queueMicrotask(()=>cancelled.abort());return()=>{released=true;};});
      const abortCounters=newR12Counters();await assert.rejects(runR12Stage(condition,fixture,file,drive,kasumi,()=>of(new ArrayBuffer(4)),abortCounters,cancelled.signal));
      assert.ok(released);assert.equal(abortCounters.cancelledOperations,1);assert.equal(abortCounters.activeReferences,0);assert.equal(abortCounters.pendingOperations,0);
      drive.downloadFileRange=()=>throwError(()=>new Error('HTTP_FAILURE'));
      const failed=newR12Counters();await assert.rejects(runR12Stage(condition,fixture,file,drive,kasumi,()=>of(new ArrayBuffer(4)),failed,signal));
      assert.equal(failed.failedOperations,1);assert.equal(failed.activeReferences,0);assert.equal(failed.pendingOperations,0);
    }
  }finally{rmSync(directory,{recursive:true,force:true});}
});
