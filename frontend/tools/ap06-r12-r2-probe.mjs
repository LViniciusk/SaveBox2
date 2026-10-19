import {fileURLToPath} from 'node:url';
import {integrationPageScript} from './ap06-integration-probe.mjs';
import {configureBackendObservation,runBackendProbe,authorityAction} from './ap06-r9-probe.mjs';
import {initializeR11Page} from './ap06-r11-probe.mjs';
import {newR12Counters,validateR12Counters} from './ap06-r12-contract.mjs';
import {validateIntegrationCleanup} from './ap06-r7-instrumentation.mjs';
import {sampleRenderer} from './ap06-r10-memory.mjs';
import {CONDITIONS,selectCondition,transportCounts} from './ap06-r12-r2-contract.mjs';

export const pageScript=()=>integrationPageScript()+`window.r12r2Counters=(${newR12Counters.toString()})();window.r12r2Routing=${JSON.stringify(transportCounts('r12r2.0',0))};`;
export async function configure(page,context,raw,origin,paths,condition){
  selectCondition(condition);await page.addInitScript(value=>{window.ap06R12R2Condition=value;},condition);
  return configureBackendObservation(page,context,raw,origin,paths,{bootstrapHttp:true,optionsHttp:true});
}
export async function initialize(page,fixtures){
  const proof=await initializeR11Page(page,fixtures,'r12r2');
  await page.evaluate(()=>{window.r5Counters.routing=window.r12r2Routing;});return proof;
}
export function validateFunctional(condition,counters,media){
  validateIntegrationCleanup(counters,media);
  const sessions=counters.r12r2.sessionsCompleted;
  validateR12Counters('r12.0',counters.r12r2,sessions,sessions*8388640);
  const wanted=transportCounts(condition,sessions);
  if(!sessions||Object.keys(counters.routing).sort().join()!==Object.keys(wanted).sort().join()||
    Object.entries(wanted).some(([k,v])=>counters.routing[k]!==v)||
    ['workersCreated','workerMessagesSent','mediaSourcesCreated','sourceBuffersCreated','bytesAppended','playbackStarted','playbackCompleted'].some(k=>counters.observed[k]!==0))throw new Error('R12R2_FUNCTIONAL_CONTRACT_FAILED');
}
export async function runFactorialProbe(options={}){
  const condition=selectCondition(process.env.AP06_R6_CONDITION),selected=CONDITIONS[condition];
  const attempt=process.env.AP06_R12R2_ATTEMPT;
  if(!/^(triage|formal)-\d{2}-r12r2\.[0-3]$/.test(attempt??''))throw new Error('R12R2_INVALID_ATTEMPT');
  await runBackendProbe({condition,transport:'factorial',pageScript:pageScript(),
    experimentalIdentity:{videoPlayerComponentUsed:false,videoStreamServiceUsed:false,attributionDriverUsed:true,
      httpWorkloadEquivalent:true,metadataCommon:true,payload:'blob',metadataTransport:selected.metadata,payloadTransport:selected.payload,
      workersUsed:false,mseUsed:false,playbackFunctional:false},
    configure,initialize,auxiliaryMetrics:sampleRenderer,functionalValidator:(c,m)=>validateFunctional(condition,c,m),
    idleAfterTeardownMs:120000,naturalCloseDelayMs:0,repetitions:1,runLabel:attempt,
    afterRun:async(raw,output)=>{
      authorityAction(['--verify-freeze'],raw,output);
      authorityAction(['--publish-raw',output,'--snapshot',attempt],raw,output);
    },...options});
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])await runFactorialProbe();
