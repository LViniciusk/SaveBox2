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
function fixture(withHeaps=true){
  const events=[{ph:'M',pid:42,name:'process_name',args:{name:'Renderer'}}];
  for(let index=0;index<4;index++)events.push({ph:'v',pid:42,ts:(index+1)*100,id:`0x${index+1}`,
    cat:['disabled-by-default-memory-infra'],name:'explicitly_triggered',args:{dumps:{
      ...(withHeaps?{heaps_v2:{version:1,maps:{strings:[],nodes:[]},allocators:{malloc:{sizes:[80+index],counts:[1],nodes:[-1],types:[-1]}}}}:{})}}});
  return events;
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
  const receipt={tracingStarted:true,memoryInfraCategoryAvailable:true,heapProfilingEffective:null,complete:true,
    streamEof:trace.streamEof,dataLossOccurred:false,activatedBeforeWorkload:true,rendererPid:42,flags,
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
    assert.deepEqual(JSON.parse(valid.child.stdout),{status:'NATIVE_CAPABILITY_PASS',heapProfilingEffective:true,
      traceSha256:valid.trace.sha256,traceBytes:valid.trace.bytes});
    assert.equal(JSON.parse(await readFile(valid.receiptPath,'utf8')).heapProfilingEffective,null);
    const absent=await evaluateTrace(dir,fixture(false),'absent');
    assert.equal(absent.child.status,1,absent.child.stderr);
    assert.deepEqual(JSON.parse(absent.child.stdout),{status:'NATIVE_INCONCLUSIVE',reason:'NATIVE_HEAPS_V2_NOT_EMITTED',
      traceSha256:absent.trace.sha256,traceBytes:absent.trace.bytes});
    assert.equal(JSON.parse(await readFile(absent.receiptPath,'utf8')).heapProfilingEffective,null);
  }finally{await rm(dir,{recursive:true,force:true});}
});
