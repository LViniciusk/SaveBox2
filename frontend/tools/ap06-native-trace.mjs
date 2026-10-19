import {open,link,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {getAttestedBrowserProof,NATIVE_ARGS} from './ap06-browser-identity.mjs';

export {NATIVE_ARGS};
export const CHECKPOINTS=Object.freeze(['baseline','cycle-6-close','idle-120s','forced-GC-final']);
const validGuid=value=>typeof value==='string'&&/^(?:0x)?[a-f\d]+$/i.test(value);
async function bounded(promise,ms=30000){
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('NATIVE_CDP_TIMEOUT')),ms);})]);}
  finally{clearTimeout(timer);}
}
export async function writeTraceStream(cdp,handle,path,maxBytes=512*1024*1024){
  const temporary=`${path}.${randomUUID()}.partial`,hash=createHash('sha256');let file,bytes=0,eof=false,published=false,failure;
  try{
    file=await open(temporary,'wx');
    const deadline=Date.now()+120000;
    while(!eof){
      if(Date.now()>deadline)throw new Error('NATIVE_STREAM_TIMEOUT');
      const chunk=await bounded(cdp.send('IO.read',{handle,size:1024*1024}));
      if(typeof chunk.data!=='string'||chunk.data.length>2*1024*1024||
        chunk.base64Encoded!==undefined&&typeof chunk.base64Encoded!=='boolean'||
        chunk.base64Encoded===true&&!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data))
        throw new Error('NATIVE_STREAM_CHUNK_INVALID');
      const data=Buffer.from(chunk.data,chunk.base64Encoded?'base64':'utf8');bytes+=data.length;
      if(bytes>maxBytes)throw new Error('NATIVE_TRACE_SIZE_LIMIT');
      hash.update(data);let offset=0;while(offset<data.length){const result=await file.write(data,offset);if(!result.bytesWritten)throw new Error('NATIVE_WRITE_FAILED');offset+=result.bytesWritten;}
      eof=chunk.eof===true;
    }
    await file.sync();await file.close();file=undefined;
    await link(temporary,path);published=true;
  }catch(error){failure=error;}
  finally{
    const cleanupErrors=[];
    if(file)try{await file.close();}catch(error){cleanupErrors.push(error);}
    try{await bounded(cdp.send('IO.close',{handle}));}catch(error){cleanupErrors.push(error);}
    try{await unlink(temporary);}catch(error){if(error.code!=='ENOENT')cleanupErrors.push(error);}
    if(published&&cleanupErrors.length)try{await unlink(path);}catch(error){cleanupErrors.push(error);}
    if(failure&&cleanupErrors.length)failure=new AggregateError([failure,...cleanupErrors],'NATIVE_TRACE_CLEANUP_FAILED');
    else if(!failure&&cleanupErrors.length)failure=new AggregateError(cleanupErrors,'NATIVE_TRACE_CLEANUP_FAILED');
  }
  if(failure)throw failure;
  return {bytes,sha256:hash.digest('hex'),streamEof:eof};
}
export class NativeTrace {
  constructor(path){this.path=path;this.receipt={tracingStarted:false,memoryInfraCategoryAvailable:false,heapProfilingEffective:null,
    complete:false,dataLossOccurred:null,streamEof:false,activatedBeforeWorkload:false,requestAttempts:0,checkpoints:[],flags:[...NATIVE_ARGS],samplingIntervalBytes:16384};}
  async start(browser){
    if(this.cdp||this.started)throw new Error('NATIVE_TRACE_ALREADY_STARTED');
    const proof=getAttestedBrowserProof(browser);
    if(!proof.nativeFlagsValidated)throw new Error('NATIVE_FLAGS_NOT_EFFECTIVE');
    this.cdp=await browser.newBrowserCDPSession();
    this.receipt.categories=(await bounded(this.cdp.send('Tracing.getCategories'))).categories.filter(c=>c==='disabled-by-default-memory-infra');
    this.receipt.memoryInfraCategoryAvailable=this.receipt.categories.length>0;
    if(!this.receipt.categories.length)throw new Error('NATIVE_MEMORYINFRA_UNAVAILABLE');
    await bounded(this.cdp.send('Tracing.start',{transferMode:'ReturnAsStream',streamFormat:'json',streamCompression:'none',tracingBackend:'chrome',
      traceConfig:{recordMode:'recordUntilFull',traceBufferSizeInKb:65536,includedCategories:['disabled-by-default-memory-infra'],excludedCategories:['*'],memoryDumpConfig:{triggers:[]}}}));
    this.receipt.tracingStarted=true;this.receipt.activatedBeforeWorkload=true;this.receipt.startedAt=new Date().toISOString();this.started=true;
  }
  async dump(phase,processes){
    if(this.receipt.requestAttempts!==this.receipt.checkpoints.length)throw new Error('NATIVE_CHECKPOINT_RETRY_FORBIDDEN');
    if(phase!==CHECKPOINTS[this.receipt.checkpoints.length])throw new Error('NATIVE_CHECKPOINT_ORDER_INVALID');
    const renderer=processes.processes.filter(p=>p.type==='renderer');
    if(renderer.length!==1||this.receipt.rendererPid&&this.receipt.rendererPid!==renderer[0].pid)throw new Error('NATIVE_RENDERER_IDENTITY_CHANGED');
    this.receipt.rendererPid=renderer[0].pid;
    const at=performance.now();this.receipt.requestAttempts++;
    const result=await bounded(this.cdp.send('Tracing.requestMemoryDump',{deterministic:false,levelOfDetail:'detailed'}));
    if(result.success!==true||!validGuid(result.dumpGuid)||
      this.receipt.checkpoints.some(item=>item.dumpGuid.toLowerCase()===result.dumpGuid.toLowerCase()))throw new Error('NATIVE_DUMP_RECEIPT_INVALID');
    this.receipt.checkpoints.push({phase,...result,timestamp:performance.now(),wallTime:new Date().toISOString(),dumpDurationMs:performance.now()-at,
      rendererPrivateBytes:renderer[0].privateBytes,totalPrivateBytes:processes.privateBytes});
  }
  async stop(){
    if(!this.cdp)return this.receipt;
    try{
      if(!this.started)return this.receipt;
      const complete=new Promise(resolve=>this.cdp.once('Tracing.tracingComplete',resolve));
      await bounded(this.cdp.send('Tracing.end'));const event=await bounded(complete);
      this.receipt.dataLossOccurred=event.dataLossOccurred;this.receipt.traceFormat=event.traceFormat??'json';
      if(!event.stream)throw new Error('NATIVE_STREAM_MISSING');
      Object.assign(this.receipt,await writeTraceStream(this.cdp,event.stream,this.path));
      const checkpoints=this.receipt.checkpoints;
      const checkpointGuids=new Set();
      const checkpointsComplete=this.receipt.requestAttempts===CHECKPOINTS.length&&Array.isArray(checkpoints)&&
        checkpoints.length===CHECKPOINTS.length&&CHECKPOINTS.every((phase,index)=>{
        const checkpoint=checkpoints[index];
        if(checkpoint?.phase!==phase||checkpoint.success!==true||!validGuid(checkpoint.dumpGuid))return false;
        const key=checkpoint.dumpGuid.toLowerCase();if(checkpointGuids.has(key))return false;checkpointGuids.add(key);return true;
      });
      this.receipt.complete=this.receipt.tracingStarted&&checkpointsComplete&&this.receipt.traceFormat==='json'&&
        this.receipt.dataLossOccurred===false&&this.receipt.streamEof===true;
      this.receipt.completedAt=new Date().toISOString();return this.receipt;
    }finally{
      this.started=false;const cdp=this.cdp;this.cdp=undefined;await cdp.detach();
    }
  }
}
