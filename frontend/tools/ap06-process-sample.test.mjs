import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleOwnedProcesses } from './ap06-process-sample.mjs';

test('shared native collector keeps every owned PID and accounts AudioService in utility',async()=>{
  const processInfo=['browser','renderer','GPU','network.mojom.NetworkService','audio.mojom.AudioService'].map((type,i)=>({id:i+1,type}));
  let sends=0,calls=0;
  const result=await sampleOwnedProcesses({send:async method=>{assert.equal(method,'SystemInfo.getProcessInfo');sends++;return{processInfo};}},
    async(_python,args,options)=>{
      calls++;assert.deepEqual(args.slice(1),['--process-sample','1,2,3,4,5']);assert.equal(options.windowsHide,true);
      return{stdout:JSON.stringify({status:'AVAILABLE',privateBytes:50,workingSetBytes:100,
        processes:processInfo.map(p=>({pid:p.id,privateBytes:10,workingSetBytes:20}))})};
    });
  assert.equal(sends,1);assert.equal(calls,1);assert.equal(result.privateBytes,50);assert.equal(result.byCategory.utility.privateBytes,20);
  assert.equal(result.byType['audio.mojom.AudioService'].privateBytes,10);
});
test('collector errors propagate without a retry or substitute process set',async()=>{
  let calls=0;
  await assert.rejects(sampleOwnedProcesses({send:async()=>({processInfo:[{id:1,type:'browser'}]})},async()=>{calls++;throw Error('NATIVE_FAILED');}),/NATIVE_FAILED/);
  assert.equal(calls,1);
});
