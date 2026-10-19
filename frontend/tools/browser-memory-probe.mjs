import { summarize, writeJsonAtomic } from './mp4-resource-calibration-lib.mjs';

export { writeJsonAtomic };
export const REQUIRED_METRICS = ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents'];

export function validateRawMetric(sample) {
  for (const key of ['runId', 'scenarioId', 'fixtureId', 'browserVersion', 'sourceHash', 'phase', 'timestamp', 'gc']) {
    if (typeof sample?.[key] !== 'string' || !sample[key]) throw new Error(`Missing identity: ${key}`);
  }
  if (!['natural', 'forced-diagnostic'].includes(sample.gc)) throw new Error('Invalid GC identity');
  if (!['PASS', 'PENDING', 'FAIL'].includes(sample.functionalStatus)) throw new Error('Missing functional status');
  for (const key of REQUIRED_METRICS) {
    if (['Nodes','Documents'].includes(key) && sample.metrics?.[key] === null &&
        sample.rendererMemory?.dom?.unavailable?.[key === 'Nodes' ? 'nodes' : 'documents']) continue;
    if (!Number.isFinite(sample.metrics?.[key])) throw new Error(`Non-finite required metric: ${key}`);
  }
  for (const value of Object.values(sample.metrics)) {
    if (value !== null && !Number.isFinite(value)) throw new Error('Non-finite metric');
  }
  if (!['AVAILABLE', 'NOT_AVAILABLE'].includes(sample.processMemory?.status)) throw new Error('Missing process availability');
  if (sample.processMemory.status === 'AVAILABLE') {
    for (const key of ['privateBytes', 'workingSetBytes']) {
      if (!Number.isFinite(sample.processMemory[key])) throw new Error('Non-finite process metric');
    }
  }
  return sample;
}

export function calculateSignedDelta(value, baseline) {
  if (!Number.isFinite(value) || !Number.isFinite(baseline)) throw new Error('Non-finite delta');
  return value - baseline;
}

export function groupProcessMetrics(sample, processInfo) {
  if (sample.status !== 'AVAILABLE') return sample;
  const types = new Map(processInfo.map(({ id, type }) => [id, type]));
  const byType = {};
  const byCategory = {};
  const processes = [];
  for (const process of sample.processes) {
    const type = types.get(process.pid);
    if (!type) throw new Error('Missing owned CDP process type');
    if (!Number.isFinite(process.privateBytes) || !Number.isFinite(process.workingSetBytes)) throw new Error('Non-finite process metric');
    processes.push({ ...process, type });
    byType[type] ??= { privateBytes: 0, workingSetBytes: 0, processes: 0 };
    byType[type].privateBytes += process.privateBytes;
    byType[type].workingSetBytes += process.workingSetBytes;
    byType[type].processes++;
    const category = type === 'browser' || type === 'renderer' ? type :
      /^(GPU|gpu-process)$/i.test(type) ? 'gpu-process' : /utility|Service/i.test(type) ? 'utility' : 'other';
    byCategory[category] ??= { privateBytes: 0, workingSetBytes: 0, processes: 0 };
    byCategory[category].privateBytes += process.privateBytes;
    byCategory[category].workingSetBytes += process.workingSetBytes;
    byCategory[category].processes++;
  }
  return { ...sample, processes, byType, byCategory, gpuDeviceMemory: { status: 'NOT_AVAILABLE' } };
}

export async function collectRawMetrics(cdp, identity, processReader, rendererMemory = null) {
  const performance = await cdp.send('Performance.getMetrics');
  const dom = rendererMemory?.dom ?? await cdp.send('Memory.getDOMCounters');
  const exposed = Object.fromEntries(performance.metrics.map(({ name, value }) => [name, value]));
  let processMemory = { status: 'NOT_AVAILABLE', reason: 'No reliable owned-process memory collector' };
  if (processReader) {
    try { processMemory = await processReader(); } catch { processMemory.reason = 'Owned-process collector unavailable'; }
  }
  return validateRawMetric({
    ...identity, ...(rendererMemory ? { rendererMemory } : {}), timestamp: new Date().toISOString(), processMemory,
    metrics: {
      JSHeapUsedSize: exposed.JSHeapUsedSize, JSHeapTotalSize: exposed.JSHeapTotalSize,
      Nodes: dom.nodes, Documents: dom.documents, LayoutObjects: exposed.LayoutObjects ?? null,
      eventListeners: dom.jsEventListeners ?? null,
    },
  });
}

export function summarizeRuns(raw) {
  if (!Array.isArray(raw?.samples) || !raw.samples.length) throw new Error('Raw samples required; summary is not evidence');
  const samples = raw.samples.map(validateRawMetric);
  if (new Set(samples.map(s => s.sourceHash)).size !== 1) throw new Error('INCOMPARABLE_MEASUREMENT_BASELINES');
  if (new Set(samples.map(s => s.fixtureId)).size !== 1 || new Set(samples.map(s => s.scenarioId)).size !== 1) {
    throw new Error('Different fixtures/scenarios cannot be aggregated');
  }
  if (samples.some(s => s.functionalStatus !== 'PASS') || raw.functionalStatus !== 'PASS' || raw.cleanupStatus !== 'PASS') {
    throw new Error('Functional scenario/cleanup must PASS');
  }
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.phase}:${sample.gc}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  const phases = [];
  for (const [key, rows] of groups) {
    if (new Set(rows.map(s => s.runId)).size !== rows.length) throw new Error('Repeated datapoint in independent-run aggregate');
    const metricRows = {};
    for (const metric of Object.keys(rows[0].metrics)) {
      const values = rows.map(s => s.metrics[metric]);
      if (values.some(v => v === null)) { metricRows[metric] = { status: 'NOT_AVAILABLE' }; continue; }
      const deltas = rows.map(s => {
        const baseline = samples.find(b => b.runId === s.runId && b.phase === 'baseline' && b.gc === 'natural');
        if (!baseline) throw new Error('Missing raw baseline');
        return calculateSignedDelta(s.metrics[metric], baseline.metrics[metric]);
      });
      metricRows[metric] = { ...summarize(values), signedDelta: summarize(deltas) };
    }
    const processMemory = rows.every(s => s.processMemory.status === 'AVAILABLE')
      ? Object.fromEntries(['privateBytes', 'workingSetBytes'].map(metric => [metric, {
          ...summarize(rows.map(s => s.processMemory[metric])),
          signedDelta: summarize(rows.map(s => calculateSignedDelta(s.processMemory[metric],
            samples.find(b => b.runId === s.runId && b.phase === 'baseline' && b.gc === 'natural').processMemory[metric]))),
        }]))
      : { status: 'NOT_AVAILABLE' };
    phases.push({ phase: key.split(':')[0], gc: key.split(':')[1], independentRuns: rows.length, metrics: metricRows, processMemory });
  }
  return { status: 'CHARACTERIZED', scenarioId: samples[0].scenarioId, fixtureId: samples[0].fixtureId,
    sourceHash: samples[0].sourceHash, phases, p95: null, p95Reason: 'Three independent repetitions do not justify a tail percentile' };
}
