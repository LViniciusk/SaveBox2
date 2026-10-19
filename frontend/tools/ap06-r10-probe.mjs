import { fileURLToPath } from 'node:url';
import { configureBackendObservation, initializeBackendPage, runBackendProbe, authorityAction } from './ap06-r9-probe.mjs';
import { sampleRenderer } from './ap06-r10-memory.mjs';

export const R10_CONDITIONS = { 'r10.0':{transport:'xhr',rangeType:'XHR',otherType:'XHR'},
  'r10.1':{transport:'range-fetch',rangeType:'Fetch',otherType:'XHR'},
  'r10.2':{transport:'global-fetch',rangeType:'Fetch',otherType:'Fetch'} };

export async function configureR10Page(page, context, raw, origin, paths, condition) {
  if (!R10_CONDITIONS[condition]) throw new Error('R10_INVALID_CONDITION');
  await page.addInitScript(value => { window.ap06R10Condition=value; },condition);
  return configureBackendObservation(page,context,raw,origin,paths,{bootstrapHttp:true,optionsHttp:true});
}

export const initializeR10Page = (page,fixtures) => initializeBackendPage(page,fixtures,'r10TransportProof');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const condition=process.env.AP06_R6_CONDITION;
  if (!R10_CONDITIONS[condition] || !/^(triage|formal)-\d{2}-r10\.[012]$/.test(process.env.AP06_R10_ATTEMPT ?? '')) {
    throw new Error('R10_INVALID_MEASUREMENT_IDENTITY');
  }
  await runBackendProbe({ condition,transport:R10_CONDITIONS[condition].transport,configure:configureR10Page,
    initialize:initializeR10Page,auxiliaryMetrics:sampleRenderer,repetitions:1,runLabel:process.env.AP06_R10_ATTEMPT,
    afterRun:async (raw,output) => {
      authorityAction(['--verify-freeze'],raw,output);
      authorityAction(['--publish-raw',output,'--snapshot',process.env.AP06_R10_ATTEMPT],raw,output);
    } });
}
