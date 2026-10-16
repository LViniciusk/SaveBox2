import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export const NATIVE_ARGS=Object.freeze(['--memlog=all','--memlog-stack-mode=native','--memlog-sampling-rate=16384','--memlog-keep-small-allocations']);
export const CHECKPOINTS=Object.freeze(['baseline','cycle-6-close','idle-120s','forced-GC-final']);
async function bounded(promise,ms=30000){
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('NATIVE_CDP_TIMEOUT')),ms);})]);}
  finally{clearTimeout(timer);}
}
export async function writeTraceStream(cdp,handle,path,maxBytes=512*1024*1024){
  const file=await open(path,'wx');const hash=createHash('sha256');let bytes=0,eof=false;
  try{
    const deadline=Date.now()+120000;
    while(!eof){
      if(Date.now()>deadline)throw new Error('NATIVE_STREAM_TIMEOUT');
      const chunk=await bounded(cdp.send('IO.read',{handle,size:1024*1024}));
      if(typeof chunk.data!=='string'||chunk.data.length>2*1024*1024)throw new Error('NATIVE_STREAM_CHUNK_INVALID');
      const data=Buffer.from(chunk.data,chunk.base64Encoded?'base64':'utf8');bytes+=data.length;
      if(bytes>maxBytes)throw new Error('NATIVE_TRACE_SIZE_LIMIT');
      hash.update(data);let offset=0;while(offset<data.length){const result=await file.write(data,offset);if(!result.bytesWritten)throw new Error('NATIVE_WRITE_FAILED');offset+=result.bytesWritten;}
      eof=chunk.eof===true;
    }
    await file.sync();return {bytes,sha256:hash.digest('hex'),streamEof:true};
  }finally{await file.close();await bounded(cdp.send('IO.close',{handle}));}
}
export class NativeTrace {
  constructor(path){this.path=path;this.receipt={complete:false,dataLossOccurred:null,activatedBeforeWorkload:false,checkpoints:[],flags:[...NATIVE_ARGS],samplingIntervalBytes:16384};}
  async start(browser){
    this.cdp=await browser.newBrowserCDPSession();
    const {arguments:args}=await bounded(this.cdp.send('Browser.getBrowserCommandLine'));
    if(!NATIVE_ARGS.every(flag=>args.includes(flag)))throw new Error('NATIVE_FLAGS_NOT_EFFECTIVE');
    this.receipt.categories=(await bounded(this.cdp.send('Tracing.getCategories'))).categories.filter(c=>c==='disabled-by-default-memory-infra');
    if(!this.receipt.categories.length)throw new Error('NATIVE_MEMORYINFRA_UNAVAILABLE');
    await bounded(this.cdp.send('Tracing.start',{transferMode:'ReturnAsStream',streamFormat:'json',streamCompression:'none',tracingBackend:'chrome',
      traceConfig:{recordMode:'recordUntilFull',traceBufferSizeInKb:65536,includedCategories:['disabled-by-default-memory-infra'],excludedCategories:['*'],memoryDumpConfig:{triggers:[]}}}));
    this.receipt.activatedBeforeWorkload=true;this.receipt.startedAt=new Date().toISOString();this.started=true;
  }
  async dump(phase,processes){
    if(!CHECKPOINTS.includes(phase))return;
    const renderer=processes.processes.filter(p=>p.type==='renderer');
    if(renderer.length!==1||this.receipt.rendererPid&&this.receipt.rendererPid!==renderer[0].pid)throw new Error('NATIVE_RENDERER_IDENTITY_CHANGED');
    this.receipt.rendererPid=renderer[0].pid;
    const at=performance.now(),result=await bounded(this.cdp.send('Tracing.requestMemoryDump',{deterministic:false,levelOfDetail:'detailed'}));
    this.receipt.checkpoints.push({phase,...result,timestamp:performance.now(),wallTime:new Date().toISOString(),dumpDurationMs:performance.now()-at,
      rendererPrivateBytes:renderer[0].privateBytes,totalPrivateBytes:processes.privateBytes});
    if(!result.success)throw new Error('NATIVE_DUMP_FAILED');
  }
  async stop(){
    if(!this.started)return this.receipt;
    const complete=new Promise(resolve=>this.cdp.once('Tracing.tracingComplete',resolve));
    await bounded(this.cdp.send('Tracing.end'));const event=await bounded(complete);
    this.receipt.dataLossOccurred=event.dataLossOccurred;this.receipt.traceFormat=event.traceFormat??'json';
    if(!event.stream)throw new Error('NATIVE_STREAM_MISSING');
    Object.assign(this.receipt,await writeTraceStream(this.cdp,event.stream,this.path));
    this.receipt.complete=this.receipt.traceFormat==='json'&&event.dataLossOccurred===false;
    this.receipt.completedAt=new Date().toISOString();await this.cdp.detach();return this.receipt;
  }
}
