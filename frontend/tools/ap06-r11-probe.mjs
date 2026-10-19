import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { integrationPageScript } from './ap06-integration-probe.mjs';
import { configureBackendObservation, runBackendProbe, authorityAction } from './ap06-r9-probe.mjs';
import { initializeIntegrationPage } from './ap06-integration-probe.mjs';
import { sampleRenderer } from './ap06-r10-memory.mjs';
import { validateIntegrationFunctional, validateIntegrationCleanup } from './ap06-r7-instrumentation.mjs';
import { R11_CONDITIONS, selectR11 } from './ap06-r11-contract.mjs';
import { newR11Counters, installR11Instrumentation, validateR11Stage } from './ap06-r11-instrumentation.mjs';

export function r11PageScript() {
  return integrationPageScript()+`window.r11Counters=(${newR11Counters.toString()})();(${installR11Instrumentation.toString()})();`;
}

export async function configureR11Page(page,context,raw,origin,paths,condition) {
  selectR11(condition);
  await page.addInitScript(value=>{window.ap06R11Condition=value;},condition);
  return configureBackendObservation(page,context,raw,origin,paths,{bootstrapHttp:true,optionsHttp:true});
}

export async function initializeR11Page(page,fixtures,counterName='r11') {
  const runtime=JSON.parse(readFileSync(process.env.AP06_R8_PRIVATE_CONFIG,'utf8'));
  const bytes=execFileSync(process.env.WAVE1_PYTHON,[process.env.AP06_R11_KEYS,process.env.AP06_R11_AUTHORITY],{windowsHide:true});
  try {
    runtime.fdks=JSON.parse(bytes.toString('utf8'));
    await initializeIntegrationPage(page,fixtures,'r8.2',runtime);
  } finally { bytes.fill(0);runtime.password='';for(const key of Object.values(runtime.fdks??{}))key.fill(0); }
  return page.evaluate(name=>{
    window.r5Counters[name]=window[name+'Counters'];
    if(name==='r11'){
      const run=window.r7Run;
      window.r7Run=async fixture=>{
        const c=window.r11Counters;c.sessionsStarted++;
        try{await run(fixture);c.sessionsCompleted++;}catch(error){c.sessionsFailed++;throw error;}
      };
    }
    window.r5RunFixture=fixture=>window.r7Run(fixture);
    return window.r10TransportProof();
  },counterName);
}

export function validateR11Functional(condition,counters,media) {
  validateIntegrationCleanup(counters,media);
  if (R11_CONDITIONS[condition].terminal==='mse') validateIntegrationFunctional(counters,media);
  validateR11Stage(condition,counters.r11,counters.observed);
}

if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const condition=process.env.AP06_R6_CONDITION;
  selectR11(condition);
  if(!/^(triage|formal)-\d{2}-r11\.[0-3]$/.test(process.env.AP06_R11_ATTEMPT??''))throw new Error('R11_INVALID_ATTEMPT');
  await runBackendProbe({condition,transport:R11_CONDITIONS[condition].range,pageScript:r11PageScript(),
    experimentalIdentity:{videoPlayerComponentUsed:R11_CONDITIONS[condition].terminal==='mse',
      videoStreamServiceUsed:condition!=='r11.2',attributionDriverUsed:['r11.2','r11.3'].includes(condition),
      httpWorkloadEquivalent:true,cryptoWorkloadEquivalent:condition!=='r11.2',transmuxWorkloadEquivalent:condition!=='r11.2',
      mseWorkloadEquivalent:R11_CONDITIONS[condition].terminal==='mse',playbackFunctional:R11_CONDITIONS[condition].terminal==='mse'},
    configure:configureR11Page,initialize:initializeR11Page,auxiliaryMetrics:sampleRenderer,
    functionalValidator:(c,m)=>validateR11Functional(condition,c,m),
    idleAfterTeardownMs:30000,naturalCloseDelayMs:0,repetitions:1,runLabel:process.env.AP06_R11_ATTEMPT,
    afterRun:async(raw,output)=>{
      authorityAction(['--verify-freeze'],raw,output);
      authorityAction(['--publish-raw',output,'--snapshot',process.env.AP06_R11_ATTEMPT],raw,output);
    }});
}
