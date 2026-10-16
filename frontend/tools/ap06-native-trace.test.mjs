import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {EventEmitter} from 'node:events';
import {NativeTrace,NATIVE_ARGS,writeTraceStream} from './ap06-native-trace.mjs';

test('trace stream writes chunks in bounded sequence, checks size and closes IO',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ap06-native-test-'));
  try{
    const calls=[];let index=0;
    const cdp={send:async(method,args)=>{calls.push([method,args]);return method==='IO.read'?{data:Buffer.from(['hello ','world'][index++]).toString('base64'),base64Encoded:true,eof:index===2}:{};}};
    const result=await writeTraceStream(cdp,'owned',join(dir,'trace.json'),20);
    assert.equal((await readFile(join(dir,'trace.json'))).toString(),'hello world');assert.equal(result.bytes,11);assert.ok(result.streamEof);
    assert.equal(calls.at(-1)[0],'IO.close');
    await assert.rejects(writeTraceStream(cdp,'owned',join(dir,'trace.json'),20));
    const overflow={send:async(method)=>method==='IO.read'?{data:'too large',eof:true}: {}};
    await assert.rejects(writeTraceStream(overflow,'owned',join(dir,'limit.json'),2),/SIZE_LIMIT/);
  }finally{assert.ok((await realpath(dir)).startsWith((await realpath(tmpdir()))+sep));await rm(dir,{recursive:true,force:true});}
});
test('native activation needs actual flags and MemoryInfra; dump never requests GC',async()=>{
  const calls=[],cdp=new EventEmitter();
  cdp.send=async(method,args)=>{
    calls.push([method,args]);
    if(method==='Browser.getBrowserCommandLine')return {arguments:[...NATIVE_ARGS]};
    if(method==='Tracing.getCategories')return {categories:['disabled-by-default-memory-infra']};
    if(method==='Tracing.requestMemoryDump')return {success:true,dumpGuid:'01'};
    return {};
  };
  const trace=new NativeTrace('unused');await trace.start({newBrowserCDPSession:async()=>cdp});
  assert.ok(trace.receipt.activatedBeforeWorkload);
  await trace.dump('baseline',{processes:[{pid:42,type:'renderer',privateBytes:100}],privateBytes:120});
  assert.deepEqual(calls.at(-1),['Tracing.requestMemoryDump',{deterministic:false,levelOfDetail:'detailed'}]);
  await assert.rejects(trace.dump('cycle-6-close',{processes:[{pid:43,type:'renderer'}]}),/IDENTITY/);
  for(const override of [{arguments:[]},{categories:[]}]){
    const broken={send:async(method)=>method==='Browser.getBrowserCommandLine'?('arguments'in override?override:{arguments:[...NATIVE_ARGS]}):override};
    await assert.rejects(new NativeTrace('unused').start({newBrowserCDPSession:async()=>broken}));
  }
});
