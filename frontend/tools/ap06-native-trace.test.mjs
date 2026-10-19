import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {NativeTrace,writeTraceStream} from './ap06-native-trace.mjs';

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
