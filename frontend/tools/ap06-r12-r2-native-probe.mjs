import {execFileSync} from 'node:child_process';
import {AUTOPLAY_ARGS} from './ap06-integration-probe.mjs';
import {NativeTrace,NATIVE_ARGS} from './ap06-native-trace.mjs';
import {configure,runFactorialProbe} from './ap06-r12-r2-probe.mjs';
import {sampleRenderer} from './ap06-r10-memory.mjs';
import {sampleOwnedProcesses} from './ap06-process-sample.mjs';
import {writeJsonAtomic} from './browser-memory-probe.mjs';
let trace,browserCdp;
await runFactorialProbe({launchOptions:{args:[...AUTOPLAY_ARGS,...NATIVE_ARGS]},
  configure:async(page,context,raw,origin,paths,condition)=>{
    const browser=context.browser();trace=new NativeTrace(process.env.AP06_NATIVE_TRACE);await trace.start(browser);browserCdp=await browser.newBrowserCDPSession();
    const close=await configure(page,context,raw,origin,paths,condition);
    return async()=>{
      try{await close();}finally{
        try{await trace.stop();}finally{
          writeJsonAtomic(process.env.AP06_NATIVE_RECEIPT,trace.receipt);
          execFileSync(process.env.WAVE1_PYTHON,[process.env.AP06_R9_PUBLISHER,'--seal-trace','--receipt',process.env.AP06_NATIVE_RECEIPT],{windowsHide:true,stdio:'pipe'});
        }
      }
    };
  },
  auxiliaryMetrics:async(cdp,checkpoint)=>{
    if(trace)await trace.dump(checkpoint.phase,await sampleOwnedProcesses(browserCdp));
    return sampleRenderer(cdp);
  },
});
