import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {CHECKPOINTS,NativeTrace,writeTraceStream} from './ap06-native-trace.mjs';
import {AUTOPLAY_ARGS,launchWithIdentityLease} from './ap06-browser-identity.mjs';

async function attestedBrowser(cdp){
  const version='151.0.7922.34';
  const browser={newBrowserCDPSession:async()=>cdp,version:()=>version};
  const old=process.env.AP06_R5_PROCESS_HANDLE_AUDIT;delete process.env.AP06_R5_PROCESS_HANDLE_AUDIT;
  try{
    await launchWithIdentityLease({launch:async()=>browser},{args:[...AUTOPLAY_ARGS,'--memlog=all','--memlog-stack-mode=native',
      '--memlog-sampling-rate=16384','--memlog-keep-small-allocations']},{browserLaunches:0,browserIdentity:{}},
      {chromiumVersion:version},{request:async()=>({status:'PASS',browserPid:42,processCreationTime:'100'})},()=>{});
  }finally{if(old===undefined)delete process.env.AP06_R5_PROCESS_HANDLE_AUDIT;else process.env.AP06_R5_PROCESS_HANDLE_AUDIT=old;}
  return browser;
}

test('trace stream writes chunks in bounded sequence, checks size and closes IO',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ap06-native-test-'));
  try{
    const calls=[];let index=0;
    let finalVisibleDuringRead=false;
    const cdp={send:async(method,args)=>{calls.push([method,args]);if(method!=='IO.read')return{};
      try{await readFile(join(dir,'trace.json'));finalVisibleDuringRead=true;}catch{}
      return {data:Buffer.from(['hello ','world'][index++]).toString('base64'),base64Encoded:true,eof:index===2};}};
    const result=await writeTraceStream(cdp,'owned',join(dir,'trace.json'),20);
    assert.equal((await readFile(join(dir,'trace.json'))).toString(),'hello world');assert.equal(result.bytes,11);assert.ok(result.streamEof);
    assert.equal(finalVisibleDuringRead,false);
    assert.equal(calls.at(-1)[0],'IO.close');
    await assert.rejects(writeTraceStream(cdp,'owned',join(dir,'trace.json'),20));
    const overflow={send:async(method)=>method==='IO.read'?{data:'too large',eof:true}: {}};
    await assert.rejects(writeTraceStream(overflow,'owned',join(dir,'limit.json'),2),/SIZE_LIMIT/);
  }finally{assert.ok((await realpath(dir)).startsWith((await realpath(tmpdir()))+sep));await rm(dir,{recursive:true,force:true});}
});
test('stream failures close CDP and remove unpublished or invalid traces',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ap06-native-cleanup-'));
  try{
    let closed=false,index=0;
    const failed={send:async method=>{
      if(method==='IO.close'){closed=true;return{};}
      if(index++===0)return{data:'partial',eof:false};
      throw new Error('read failed');
    }};
    await assert.rejects(writeTraceStream(failed,'owned',join(dir,'failed.json')),/read failed/);
    assert.equal(closed,true);assert.deepEqual(await readdir(dir),[]);
    closed=false;
    const invalid={send:async method=>{if(method==='IO.close'){closed=true;return{};}return{data:'%%%',base64Encoded:true,eof:true};}};
    await assert.rejects(writeTraceStream(invalid,'owned',join(dir,'invalid.json')),/CHUNK_INVALID/);
    assert.equal(closed,true);assert.deepEqual(await readdir(dir),[]);
    const closeFailure={send:async method=>{if(method==='IO.close')throw new Error('close failed');return{data:'{}',eof:true};}};
    await assert.rejects(writeTraceStream(closeFailure,'owned',join(dir,'close-failure.json')),/CLEANUP_FAILED/);
    assert.deepEqual(await readdir(dir),[]);
  }finally{assert.ok((await realpath(dir)).startsWith((await realpath(tmpdir()))+sep));await rm(dir,{recursive:true,force:true});}
});
test('native activation requires identity proof before opening CDP',async()=>{
  let requested=false;
  await assert.rejects(new NativeTrace('unused').start({newBrowserCDPSession:async()=>{requested=true;}}),/AP06_BROWSER_NOT_ATTESTED/);
  assert.equal(requested,false);
});

test('MemoryInfra category failure is controlled and detaches the attested CDP session',async()=>{
  const calls=[];let detached=false;
  const cdp={send:async(method)=>{calls.push(method);if(method==='SystemInfo.getProcessInfo')return{processInfo:[{type:'browser',id:42}]};
    if(method==='Browser.getVersion')return{product:'HeadlessShell/151.0.7922.34'};
    if(method==='Tracing.getCategories')return{categories:[]};throw new Error('unexpected CDP method');},detach:async()=>{detached=true;}};
  const browser=await attestedBrowser(cdp),trace=new NativeTrace('unused');
  await assert.rejects(trace.start(browser),/NATIVE_MEMORYINFRA_UNAVAILABLE/);
  await trace.stop();
  assert.deepEqual(calls.filter(method=>method.startsWith('Tracing.')),['Tracing.getCategories']);
  assert.equal(trace.receipt.memoryInfraCategoryAvailable,false);
  assert.equal(detached,true);
});

test('four explicit checkpoint requests follow MemoryInfra start and complete the receipt',async()=>{
  const calls=[];let detached=false,requests=0;
  const guids=['0x01','2','0X0003','0004'];
  const cdp=new EventEmitter();
  cdp.send=async(method,params)=>{
    calls.push([method,params]);
    if(method==='SystemInfo.getProcessInfo')return{processInfo:[{type:'browser',id:42}]};
    if(method==='Browser.getVersion')return{product:'HeadlessShell/151.0.7922.34'};
    if(method==='Tracing.getCategories')return{categories:['disabled-by-default-memory-infra']};
    if(method==='Tracing.requestMemoryDump')return{dumpGuid:guids[requests++],success:true};
    if(method==='Tracing.end'){
      queueMicrotask(()=>cdp.emit('Tracing.tracingComplete',{dataLossOccurred:false,traceFormat:'json',stream:'trace'}));return{};
    }
    if(method==='IO.read')return{data:'{"traceEvents":[]}',eof:true};
    return{};
  };
  cdp.detach=async()=>{detached=true;};
  const browser=await attestedBrowser(cdp),dir=await mkdtemp(join(tmpdir(),'ap06-native-full-'));
  try{
    const trace=new NativeTrace(join(dir,'complete.json'));await trace.start(browser);
    const processes={processes:[{type:'renderer',pid:42,privateBytes:10}],privateBytes:10};
    for(const phase of ['baseline','cycle-6-close','idle-120s','forced-GC-final'])await trace.dump(phase,processes);
    await trace.stop();
    const tracing=calls.filter(([method])=>method.startsWith('Tracing.'));
    assert.deepEqual(tracing.map(([method])=>method),['Tracing.getCategories','Tracing.start',
      'Tracing.requestMemoryDump','Tracing.requestMemoryDump','Tracing.requestMemoryDump','Tracing.requestMemoryDump','Tracing.end']);
    assert.deepEqual(tracing[1][1].traceConfig.memoryDumpConfig,{triggers:[]});
    assert.equal(tracing[1][1].tracingBackend,'chrome');
    assert.ok(tracing.slice(2,6).every(([,payload])=>payload.deterministic===false&&payload.levelOfDetail==='detailed'));
    assert.equal(trace.receipt.requestAttempts,4);assert.equal(trace.receipt.complete,true);assert.equal(detached,true);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('numeric GUID aliases are duplicates during capture and in the final receipt gate',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ap06-native-guid-alias-'));
  try{
    let requests=0,detached=false;
    const cdp=new EventEmitter();
    cdp.send=async method=>{
      if(method==='Tracing.requestMemoryDump')return{dumpGuid:['0x01','1'][requests++],success:true};
      if(method==='Tracing.end'){
        queueMicrotask(()=>cdp.emit('Tracing.tracingComplete',{dataLossOccurred:false,traceFormat:'json',stream:'trace'}));return{};
      }
      if(method==='IO.read')return{data:'{"traceEvents":[]}',eof:true};
      return{};
    };
    cdp.detach=async()=>{detached=true;};
    const trace=new NativeTrace(join(dir,'alias.json'));trace.cdp=cdp;trace.started=true;trace.receipt.tracingStarted=true;
    const processes={processes:[{type:'renderer',pid:42,privateBytes:10}],privateBytes:10};
    await trace.dump('baseline',processes);
    await assert.rejects(trace.dump('cycle-6-close',processes),/NATIVE_DUMP_RECEIPT_INVALID/);
    await trace.stop();
    assert.equal(trace.receipt.complete,false);assert.equal(trace.receipt.requestAttempts,2);
    assert.equal(trace.receipt.checkpoints.length,1);assert.equal(detached,true);

    const invalid=new NativeTrace(join(dir,'invalid.json'));invalid.cdp={send:async method=>
      method==='Tracing.requestMemoryDump'?{dumpGuid:'0x1g',success:true}:{}};invalid.started=true;
    invalid.receipt.tracingStarted=true;
    await assert.rejects(invalid.dump('baseline',processes),/NATIVE_DUMP_RECEIPT_INVALID/);

    const finalCdp=new EventEmitter();finalCdp.send=async method=>{
      if(method==='Tracing.end'){
        queueMicrotask(()=>finalCdp.emit('Tracing.tracingComplete',{dataLossOccurred:false,traceFormat:'json',stream:'trace'}));return{};
      }
      if(method==='IO.read')return{data:'{"traceEvents":[]}',eof:true};
      return{};
    };finalCdp.detach=async()=>{};
    const finalGate=new NativeTrace(join(dir,'tampered.json'));finalGate.cdp=finalCdp;finalGate.started=true;
    finalGate.receipt.tracingStarted=true;finalGate.receipt.requestAttempts=4;
    finalGate.receipt.checkpoints=['baseline','cycle-6-close','idle-120s','forced-GC-final'].map((phase,index)=>
      ({phase,dumpGuid:['0x01','1','3','4'][index],success:true}));
    await finalGate.stop();assert.equal(finalGate.receipt.complete,false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('failed checkpoint request cannot produce a complete trace receipt',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ap06-native-partial-'));
  try{
    const cdp=new EventEmitter();let requests=0,detached=false;
    cdp.send=async method=>{
      if(method==='Tracing.requestMemoryDump'){
        requests++;return{dumpGuid:`0x${requests}`,success:requests===1};
      }
      if(method==='Tracing.end'){
        queueMicrotask(()=>cdp.emit('Tracing.tracingComplete',{dataLossOccurred:false,traceFormat:'json',stream:'trace'}));return{};
      }
      if(method==='IO.read')return{data:'{"traceEvents":[]}',eof:true};
      return{};
    };
    cdp.detach=async()=>{detached=true;};
    const trace=new NativeTrace(join(dir,'partial.json'));trace.cdp=cdp;trace.started=true;trace.receipt.tracingStarted=true;
    const processes={processes:[{type:'renderer',pid:42,privateBytes:10}],privateBytes:10};
    await trace.dump('baseline',processes);
    await assert.rejects(trace.dump('cycle-6-close',processes),/NATIVE_DUMP_RECEIPT_INVALID/);
    await assert.rejects(trace.dump('cycle-6-close',processes),/NATIVE_CHECKPOINT_RETRY_FORBIDDEN/);
    await trace.stop();
    assert.equal(trace.receipt.complete,false);
    assert.equal(trace.receipt.requestAttempts,2);
    assert.equal(trace.receipt.checkpoints.length,1);
    assert.equal(detached,true);
    assert.deepEqual(await readdir(dir),['partial.json']);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('third and fourth checkpoint failures remain incomplete and cannot retry',async()=>{
  for(const failureAt of [3,4]){
    const dir=await mkdtemp(join(tmpdir(),'ap06-native-late-failure-'));
    try{
      const cdp=new EventEmitter();let requests=0;
      cdp.send=async method=>{
        if(method==='Tracing.requestMemoryDump'){requests++;return{dumpGuid:`0x${requests}`,success:requests!==failureAt};}
        if(method==='Tracing.end'){
          queueMicrotask(()=>cdp.emit('Tracing.tracingComplete',{dataLossOccurred:false,traceFormat:'json',stream:'trace'}));return{};
        }
        if(method==='IO.read')return{data:'{"traceEvents":[]}',eof:true};
        return{};
      };
      cdp.detach=async()=>{};
      const trace=new NativeTrace(join(dir,'late-failure.json'));trace.cdp=cdp;trace.started=true;trace.receipt.tracingStarted=true;
      const processes={processes:[{type:'renderer',pid:42,privateBytes:10}],privateBytes:10};
      for(let index=0;index<failureAt-1;index++)await trace.dump(CHECKPOINTS[index],processes);
      await assert.rejects(trace.dump(CHECKPOINTS[failureAt-1],processes),/NATIVE_DUMP_RECEIPT_INVALID/);
      await assert.rejects(trace.dump(CHECKPOINTS[failureAt-1],processes),/NATIVE_CHECKPOINT_RETRY_FORBIDDEN/);
      await trace.stop();
      assert.equal(trace.receipt.complete,false);assert.equal(trace.receipt.requestAttempts,failureAt);
      assert.equal(trace.receipt.checkpoints.length,failureAt-1);assert.equal(requests,failureAt);
    }finally{await rm(dir,{recursive:true,force:true});}
  }
});

test('checkpoint CDP timeout leaves the receipt incomplete without waiting',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ap06-native-timeout-'));
  const originalSetTimeout=globalThis.setTimeout,originalClearTimeout=globalThis.clearTimeout,token={};
  try{
    globalThis.setTimeout=(callback,delay,...args)=>{
      if(delay===30000){queueMicrotask(()=>callback(...args));return token;}
      return originalSetTimeout(callback,delay,...args);
    };
    globalThis.clearTimeout=handle=>handle===token?undefined:originalClearTimeout(handle);
    const cdp=new EventEmitter();cdp.send=async method=>{
      if(method==='Tracing.requestMemoryDump')return new Promise(()=>{});
      if(method==='Tracing.end'){
        queueMicrotask(()=>cdp.emit('Tracing.tracingComplete',{dataLossOccurred:false,traceFormat:'json',stream:'trace'}));return{};
      }
      if(method==='IO.read')return{data:'{"traceEvents":[]}',eof:true};
      return{};
    };cdp.detach=async()=>{};
    const trace=new NativeTrace(join(dir,'timeout.json'));trace.cdp=cdp;trace.started=true;trace.receipt.tracingStarted=true;
    const processes={processes:[{type:'renderer',pid:42,privateBytes:10}],privateBytes:10};
    await assert.rejects(trace.dump(CHECKPOINTS[0],processes),/NATIVE_CDP_TIMEOUT/);
    globalThis.setTimeout=originalSetTimeout;globalThis.clearTimeout=originalClearTimeout;
    await trace.stop();
    assert.equal(trace.receipt.complete,false);assert.equal(trace.receipt.requestAttempts,1);
    assert.equal(trace.receipt.checkpoints.length,0);
    await assert.rejects(trace.dump(CHECKPOINTS[0],processes),/NATIVE_CHECKPOINT_RETRY_FORBIDDEN/);
  }finally{
    globalThis.setTimeout=originalSetTimeout;globalThis.clearTimeout=originalClearTimeout;
    await rm(dir,{recursive:true,force:true});
  }
});
