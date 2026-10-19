import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {writeTraceStream} from './ap06-native-trace.mjs';

const root=resolve(import.meta.dirname,'../..');
const parser=fileURLToPath(new URL('../../tools/quality/run_ap06_r12_r13_native.py',import.meta.url));
const phases=['baseline','cycle-6-close','idle-120s','forced-GC-final'];
const flags=['--memlog=all','--memlog-stack-mode=native','--memlog-sampling-rate=16384','--memlog-keep-small-allocations'];
function fixture(withHeaps=true,checkpointCount=4,schemaVersion=1){
  const events=[{ph:'M',pid:42,name:'process_name',args:{name:'Renderer'}}],requests=[];
  for(let index=0;index<checkpointCount;index++){
    const dumpGuid=`0x${index+1}`,start=index*100;
    events.push({ph:'v',pid:42,ts:start+1,id:dumpGuid,
      cat:['disabled-by-default-memory-infra'],name:'periodic_interval',args:{dumps:{
        level_of_detail:'detailed',
        ...(withHeaps?{heaps_v2:{version:schemaVersion,maps:{strings:[],nodes:[]},allocators:{malloc:{sizes:[80+index],counts:[1],nodes:[-1],types:[-1]}}}}:{})}}});
    requests.push(
      {ph:'b',pid:99,ts:start,id2:{local:dumpGuid},name:'GlobalMemoryDump',
        cat:['disabled-by-default-memory-infra'],args:{dump_guid:dumpGuid,dump_type:'explicitly_triggered',
          level_of_detail:'detailed',success:true}},
      {ph:'e',pid:99,ts:start+2,id2:{local:dumpGuid},name:'GlobalMemoryDump',cat:['disabled-by-default-memory-infra']});
  }
  return [...events,...requests];
}
async function evaluateTrace(dir,events,label){
  const path=join(dir,`${label}.trace.json`),receiptPath=join(dir,`${label}.receipt.json`),json=JSON.stringify({traceEvents:events});
  let offset=0;
  const cdp={send:async method=>{
    if(method==='IO.close')return{};
    const data=json.slice(offset,offset+113);offset+=data.length;
    return{data,eof:offset>=json.length};
  }};
  const trace=await writeTraceStream(cdp,'synthetic',path);
  const receipt={tracingStarted:true,memoryInfraCategoryAvailable:true,heapProfilingEffective:null,complete:true,requestAttempts:4,
    streamEof:trace.streamEof,dataLossOccurred:false,activatedBeforeWorkload:true,rendererPid:42,flags,
    browserIdentity:{before:{nativeFlagsValidated:true}},
    sha256:trace.sha256,bytes:trace.bytes,
    checkpoints:phases.map((phase,index)=>({phase,dumpGuid:`0x${index+1}`,success:true,timestamp:index+1}))};
  await writeFile(receiptPath,JSON.stringify(receipt));
  const child=spawnSync(process.env.WAVE1_PYTHON||'python',[parser,'--validate-synthetic-trace',path,'--receipt',receiptPath],
    {cwd:root,encoding:'utf8',windowsHide:true});
  return{child,receipt,trace,path,receiptPath};
}

test('Node stream producer and Python strict consumer agree on valid and profiler-absent traces',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ap06-native-integration-'));
  try{
    const valid=await evaluateTrace(dir,fixture(),'valid');
    assert.equal(valid.child.status,0,valid.child.stderr);
    const validResult=JSON.parse(valid.child.stdout);
    assert.deepEqual({status:validResult.status,heapProfilingEffective:validResult.heapProfilingEffective,
      traceSha256:validResult.traceSha256,traceBytes:validResult.traceBytes},
      {status:'NATIVE_CAPABILITY_PASS',heapProfilingEffective:true,traceSha256:valid.trace.sha256,traceBytes:valid.trace.bytes});
    assert.equal(validResult.diagnostic.profilerActivationEvidence,'OBSERVED_RENDERER_HEAPS_V2');
    assert.equal(validResult.diagnostic.heapsV2Status,'VALIDATED');
    assert.equal(validResult.diagnostic.browserProcessFlagsAttested,true);
    assert.equal(validResult.diagnostic.rendererIdentityProof,'MISSING');
    assert.equal(validResult.diagnostic.requestAttempts,4);
    assert.equal(validResult.diagnostic.successfulCheckpointRequests,4);
    assert.equal(validResult.diagnostic.correlatedRendererDumps,4);
    assert.equal(validResult.diagnostic.rendererCorrelation,'COMPLETE');
    assert.equal(JSON.parse(await readFile(valid.receiptPath,'utf8')).heapProfilingEffective,null);
    const absent=await evaluateTrace(dir,fixture(false),'absent');
    assert.equal(absent.child.status,1,absent.child.stderr);
    const absentResult=JSON.parse(absent.child.stdout);
    assert.deepEqual({status:absentResult.status,reason:absentResult.reason,traceSha256:absentResult.traceSha256,
      traceBytes:absentResult.traceBytes},{status:'NATIVE_INCONCLUSIVE',reason:'NATIVE_HEAPS_V2_NOT_EMITTED',
      traceSha256:absent.trace.sha256,traceBytes:absent.trace.bytes});
    assert.equal(absentResult.diagnostic.profilerActivationEvidence,'NO_VALID_HEAPS_V2');
    assert.equal(absentResult.diagnostic.heapsV2Status,'ABSENT');
    assert.equal(absentResult.diagnostic.successfulCheckpointRequests,4);
    assert.equal(absentResult.diagnostic.correlatedRendererDumps,4);
    assert.equal(absentResult.diagnostic.rendererCorrelation,'COMPLETE');
    assert.equal(JSON.parse(await readFile(absent.receiptPath,'utf8')).heapProfilingEffective,null);
    const partial=await evaluateTrace(dir,fixture(true,3),'partial');
    assert.equal(partial.child.status,1,partial.child.stderr);
    const partialResult=JSON.parse(partial.child.stdout);
    assert.equal(partialResult.reason,'NATIVE_CHECKPOINT_DUMPS_INCOMPLETE');
    assert.equal(partialResult.diagnostic.rendererCorrelation,'PARTIAL');
    assert.equal(partialResult.diagnostic.correlatedRendererDumps,3);
    assert.equal(partialResult.diagnostic.heapsV2Status,'PARTIAL');
    const malformed=await evaluateTrace(dir,fixture(true,4,2),'malformed');
    assert.equal(malformed.child.status,1,malformed.child.stderr);
    const malformedResult=JSON.parse(malformed.child.stdout);
    assert.equal(malformedResult.reason,'NATIVE_HEAPS_V2_SCHEMA_UNSUPPORTED');
    assert.equal(malformedResult.diagnostic.heapsV2Status,'STRUCTURALLY_REJECTED');
    assert.equal(malformedResult.diagnostic.rendererCorrelation,'COMPLETE');
  }finally{await rm(dir,{recursive:true,force:true});}
});
