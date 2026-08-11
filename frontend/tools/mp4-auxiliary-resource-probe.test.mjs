import assert from 'node:assert/strict';
import test from 'node:test';
import {
  maxPositiveSecantSlope,
  measurementBatchSize,
  measurementBatchSizeForPlan,
  diffV8HeapSpaces,
  observedAuxiliaryResidual,
  pairedAuxiliaryResidual,
  parseAuxiliaryProbeChild,
  snapshotV8HeapSpaces,
  validateAuxiliaryProbeRows,
  verifyParserCount,
} from './mp4-auxiliary-resource-probe.mjs';

const plan = { family: 'stts', variant: 'entries', counts: [0, 1] };
const row = (count, repetition = 1, overrides = {}) => {
  const batchSize = count < 0 ? 1 : measurementBatchSizeForPlan(plan, count);
  return ({
  schema: 1, family: 'stts', variant: 'entries', count, measurementBatchSize: batchSize,
  units: count * 10 * batchSize, version: '2.4.1',
  parsedCount: count * batchSize, parserVerified: true, guardAccepted: true,
  controlCount: 0, controlUnits: 0, controlParsedCount: 0, controlParserVerified: true,
  guardUsage: { declaredSamples: 0, auxiliaryUnits: count, metadataBytes: count * 8, visitedBoxes: 0, estimatedBytes: 0, mode: 'classic' },
  controlGuardUsage: { declaredSamples: 0, auxiliaryUnits: 0, metadataBytes: 0, visitedBoxes: 0, estimatedBytes: 0, mode: 'classic' },
  inputBytes: count * 8, repetition,
  retainedHeapUsedBytes: count * 32, controlRetainedHeapUsedBytes: 0,
  retainedMemoryDeltaBytes: { heapUsed: count * 32, heapTotal: 0, arrayBuffers: 0, external: 0, rss: 0 },
  controlRetainedMemoryDeltaBytes: { heapUsed: 0, heapTotal: 0, arrayBuffers: 0, external: 0, rss: 0 },
  ...overrides,
  });
};

test('AUX-CALC-001: 32 bytes per unit are recovered from a linear slope', () => {
  assert.equal(maxPositiveSecantSlope([{ units: 0, residualBytes: 0 }, { units: 1, residualBytes: 32 }, { units: 10, residualBytes: 320 }]), 32);
});

test('AUX-CALC-002: an 80-byte unit slope exceeds the 64-byte charge', () => {
  assert.ok(maxPositiveSecantSlope([{ units: 0, residualBytes: 0 }, { units: 10, residualBytes: 800 }]) > 64);
});

test('AUX-CALC-003: a local pairwise spike is not hidden by a lower endpoint average', () => {
  const points = [{ units: 0, residualBytes: 0 }, { units: 1, residualBytes: 100 }, { units: 3, residualBytes: 101 }];
  assert.ok(points.at(-1).residualBytes / points.at(-1).units < 64);
  assert.ok(maxPositiveSecantSlope(points) > 64);
});

test('AUX-CALC-003A: batch-normalized fractional residuals retain their measured slope', () => {
  assert.equal(maxPositiveSecantSlope([{ units: 0, residualBytes: 0 }, { units: 6, residualBytes: 0.5 }]), 0.5 / 6);
});

test('AUX-CALC-004: metadata growth is subtracted from heap growth', () => {
  assert.equal(observedAuxiliaryResidual(140, 40), 100);
  assert.equal(observedAuxiliaryResidual(10, 40), 0);
});

test('AUX-CALC-005: duplicate datapoints are rejected', () => {
  assert.throws(() => validateAuxiliaryProbeRows([row(0), row(0), row(1)], [plan]), /Duplicate/);
});

test('AUX-CALC-006: unsafe integer measurements are rejected', () => {
  assert.throws(() => observedAuxiliaryResidual(Number.MAX_SAFE_INTEGER + 1, 0), /Unsafe/);
});

test('AUX-CALC-007: negative counts are rejected', () => {
  assert.throws(() => validateAuxiliaryProbeRows([row(-1, 1, {
    guardUsage: { declaredSamples: 0, auxiliaryUnits: 0, metadataBytes: 0, visitedBoxes: 0, estimatedBytes: 0, mode: 'classic' },
  }), row(0), row(1)], [plan]), /Negative or unsafe/);
});

test('AUX-CALC-008: a missing control is reported explicitly', () => {
  assert.throws(() => validateAuxiliaryProbeRows([row(1)], [plan]), /Missing auxiliary control/);
});

test('AUX-CALC-009: incomplete child JSON is rejected', () => {
  assert.throws(() => parseAuxiliaryProbeChild('{"schema":1', 0, { plan, count: 0 }), /incomplete JSON/);
});

test('AUX-CALC-010: an MP4Box version mismatch aborts parsing evidence', () => {
  assert.throws(() => parseAuxiliaryProbeChild(JSON.stringify(row(0, 1, { version: '2.4.0' })), 0, { plan, count: 0 }), /version mismatch/);
});

test('AUX-CALC-011: parser count verification mismatch aborts the probe', () => {
  assert.throws(() => verifyParserCount(1, 2, 'stts'), /materialized 1; expected 2/);
});

test('AUX-CALC-012: non-finite memory observations are rejected', () => {
  assert.throws(() => validateAuxiliaryProbeRows([row(0), row(1, 1, {
    retainedMemoryDeltaBytes: { heapUsed: Number.NaN, heapTotal: 0, arrayBuffers: 0, external: 0, rss: 0 },
  })], [plan]), /Non-finite/);
});

test('AUX-CALC-013: a parser datapoint rejected by the production guard is invalid evidence', () => {
  assert.throws(() => parseAuxiliaryProbeChild(JSON.stringify(row(0, 1, { guardAccepted: false })), 0, {
    plan, count: 0,
  }), /incomplete parser or unit evidence/);
});

test('AUX-CALC-014: missing production guard usage is rejected', () => {
  assert.throws(() => validateAuxiliaryProbeRows([row(0), row(1, 1, { guardUsage: null })], [plan]), /production-guard verification/);
});

test('AUX-CALC-015: the production guard observation must contain safe resource counters', () => {
  assert.throws(() => validateAuxiliaryProbeRows([row(0), row(1, 1, {
    guardUsage: { declaredSamples: 0, auxiliaryUnits: Number.NaN, metadataBytes: 8, visitedBoxes: 0 },
  })], [plan]), /production-guard verification/);
});

test('AUX-CALC-016: incomplete paired-control evidence is rejected', () => {
  assert.throws(() => validateAuxiliaryProbeRows([row(0), row(1, 1, { controlParsedCount: 1 })], [plan]), /paired auxiliary control evidence/);
});

test('AUX-CALC-017: non-finite paired-control memory is rejected', () => {
  assert.throws(() => validateAuxiliaryProbeRows([row(0), row(1, 1, {
    controlRetainedMemoryDeltaBytes: { heapUsed: Infinity, heapTotal: 0, arrayBuffers: 0, external: 0, rss: 0 },
  })], [plan]), /paired-control memory observation/);
});

test('AUX-CALC-018: paired residual uses signed raw heap deltas and metadata', () => {
  assert.equal(pairedAuxiliaryResidual(100, -50, 10), 140);
  assert.equal(pairedAuxiliaryResidual(-100, 50, 10), -160);
  assert.throws(() => pairedAuxiliaryResidual(Number.MAX_SAFE_INTEGER, -1, 0), /Unsafe/);
});

test('AUX-CALC-019: negative heap deltas remain visible instead of being retried or erased', () => {
  for (const overrides of [
    { retainedMemoryDeltaBytes: { heapUsed: -1, heapTotal: 0, arrayBuffers: 0, external: 0, rss: 0 } },
    { controlRetainedMemoryDeltaBytes: { heapUsed: -1, heapTotal: 0, arrayBuffers: 0, external: 0, rss: 0 } },
  ]) {
    const parsed = parseAuxiliaryProbeChild(JSON.stringify(row(1, 1, overrides)), 0, { plan, count: 1 });
    assert.equal(parsed.retainedMemoryDeltaBytes.heapUsed, overrides.retainedMemoryDeltaBytes?.heapUsed ?? 32);
    assert.equal(parsed.controlRetainedMemoryDeltaBytes.heapUsed, overrides.controlRetainedMemoryDeltaBytes?.heapUsed ?? 0);
  }
});

test('AUX-CALC-020: low-count parser batches are deterministic and validated', () => {
  assert.equal(measurementBatchSize(0), 256);
  assert.equal(measurementBatchSize(1), 256);
  assert.equal(measurementBatchSize(10), 256);
  assert.equal(measurementBatchSize(100), 163);
  assert.equal(measurementBatchSize(1_000), 16);
  assert.equal(measurementBatchSize(10_000), 1);
  assert.equal(measurementBatchSize(8, 48), 256);
  assert.equal(measurementBatchSizeForPlan({ family: 'elng' }, 8), 256);
  assert.equal(measurementBatchSizeForPlan({ family: 'visited-box' }, 1_000), 8);
  assert.equal(measurementBatchSizeForPlan({ family: 'co64' }, 10_000), 3);
  assert.equal(measurementBatchSizeForPlan({ family: 'stsd' }, 32), 25);
  assert.equal(measurementBatchSizeForPlan({ family: 'trun', fields: 0 }, 100),
    measurementBatchSizeForPlan({ family: 'trun', fields: 4 }, 100));
  assert.throws(() => measurementBatchSize(-1), /Invalid auxiliary measurement count/);
  assert.throws(() => measurementBatchSize(1, -1), /Invalid auxiliary measurement count/);
  const batched = row(10);
  const parsed = parseAuxiliaryProbeChild(JSON.stringify(batched), 0, { plan, count: 10 });
  assert.equal(parsed.parsedCount, 10 * measurementBatchSizeForPlan(plan, 10));
  assert.throws(() => parseAuxiliaryProbeChild(JSON.stringify({ ...batched, parsedCount: 10 }), 0, {
    plan, count: 10,
  }), new RegExp(`materialized 10; expected ${10 * measurementBatchSizeForPlan(plan, 10)}`));
});

test('AUX-M4-001: optional V8 heap-space snapshots preserve signed per-space deltas', () => {
  const before = snapshotV8HeapSpaces();
  const after = snapshotV8HeapSpaces();
  assert.ok(Object.keys(before).length > 0);
  for (const space of Object.values(before)) {
    for (const value of Object.values(space)) assert.ok(Number.isSafeInteger(value) && value >= 0);
  }
  assert.deepEqual(diffV8HeapSpaces(
    { old_space: { usedBytes: 10, sizeBytes: 20 } },
    { old_space: { usedBytes: 7, sizeBytes: 24 }, new_space: { usedBytes: 3 } },
  ), {
    old_space: { sizeBytes: 4, usedBytes: -3, availableBytes: 0, physicalBytes: 0 },
    new_space: { sizeBytes: 0, usedBytes: 3, availableBytes: 0, physicalBytes: 0 },
  });
  assert.ok(Object.keys(after).length > 0);
});
