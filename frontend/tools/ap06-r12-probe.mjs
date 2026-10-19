import { fileURLToPath } from 'node:url';
import { integrationPageScript } from './ap06-integration-probe.mjs';
import { configureBackendObservation, runBackendProbe, authorityAction } from './ap06-r9-probe.mjs';
import { initializeR11Page } from './ap06-r11-probe.mjs';
import { sampleRenderer } from './ap06-r10-memory.mjs';
import { validateIntegrationCleanup } from './ap06-r7-instrumentation.mjs';
import { R12_CONDITIONS, selectR12, newR12Counters, validateR12Counters } from './ap06-r12-contract.mjs';

export function r12PageScript(){return integrationPageScript()+`window.r12Counters=(${newR12Counters.toString()})();`;}
export async function configureR12Page(page,context,raw,origin,paths,condition){
  selectR12(condition);await page.addInitScript(value=>{window.ap06R12Condition=value;},condition);
  return configureBackendObservation(page,context,raw,origin,paths,{bootstrapHttp:true,optionsHttp:true});
}
export const initializeR12Page=(page,fixtures)=>initializeR11Page(page,fixtures,'r12');
export function validateR12Functional(condition,counters,media){
  validateIntegrationCleanup(counters,media);
  const c=counters.observed,sessions=counters.r12.sessionsCompleted;
  validateR12Counters(condition,counters.r12,sessions,sessions*2*(4194304+16));
  if(!sessions||['workersCreated','workerMessagesSent','mediaSourcesCreated','sourceBuffersCreated','bytesAppended','playbackStarted','playbackCompleted'].some(k=>c[k]!==0))throw new Error('R12_FORBIDDEN_PIPELINE');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const condition=selectR12(process.env.AP06_R6_CONDITION);
  if(!/^(triage|formal)-\d{2}-r12\.[0-4]$/.test(process.env.AP06_R12_ATTEMPT??''))throw new Error('R12_INVALID_ATTEMPT');
  await runBackendProbe({condition,transport:R12_CONDITIONS[condition].transport,pageScript:r12PageScript(),
    experimentalIdentity:{videoPlayerComponentUsed:false,videoStreamServiceUsed:false,attributionDriverUsed:true,
      httpWorkloadEquivalent:true,metadataCommon:true,payload:R12_CONDITIONS[condition].payload,workersUsed:false,mseUsed:false,playbackFunctional:false},
    configure:configureR12Page,initialize:initializeR12Page,auxiliaryMetrics:sampleRenderer,
    functionalValidator:(c,m)=>validateR12Functional(condition,c,m),idleAfterTeardownMs:120000,naturalCloseDelayMs:0,
    repetitions:1,runLabel:process.env.AP06_R12_ATTEMPT,
    afterRun:async(raw,output)=>{
      authorityAction(['--verify-freeze'],raw,output);
      authorityAction(['--publish-raw',output,'--snapshot',process.env.AP06_R12_ATTEMPT],raw,output);
    }});
}
