import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expectedPostHash,
  co64Counterfactual,
  hdlrGuardBoundary,
  hdlrParserReadsPastDeclaredChild,
  independentResidual,
  maximumPositiveSecant,
  parseAllowedSampleEntries,
  recalculateRawEvidence,
  validateRawRows,
} from './mp4-ap01-independent-audit.mjs';
import { decision as parserSurfaceDecision } from './mp4-parser-surface-inventory.mjs';

test('AUDIT-PROVENANCE-001: M2 markdown hash is normalized before comparison', () => {
  const report = '| File | PRE | POST | Expected changed |\n| --- | --- | --- | --- |\n| `frontend/package-lock.json` | `before` | `d0e9ed9e` | YES |';
  assert.equal(expectedPostHash(report, 'frontend/package-lock.json'), 'd0e9ed9e');
});

test('AUDIT-SURFACE-001: repeated occurrences do not duplicate allowed sample entries', () => {
  assert.deepEqual(parseAllowedSampleEntries("entry.type === 'avc1'; entry.type === 'mp4a' ? 28 : entry.type === 'mp4a'"), ['avc1', 'mp4a']);
});

test('AUDIT-SURFACE-002: composes unbounded MP4Box parser with explicit child-bounded production guard', () => {
  assert.equal(hdlrParserReadsPastDeclaredChild('this.name = stream.readCString();'), true);
  assert.equal(hdlrParserReadsPastDeclaredChild('this.name = stream.readCString(name_size);'), false);
  const source = `
    const SAFE_FIXED_OR_SIZE_BOUNDED_BOXES = new Set(['mvhd']);
    const HDLR_EXTRA_UNITS_PER_64_NAME_BYTES = 1;
    function findHandlerNameTerminator(bytes, start, end) {
      for (let index = start; index < end; index++) {
        if (bytes[index] === 0) return index;
      }
      return -1;
    }
    if (child.type === 'hdlr' && (parentType === 'mdia' || parentType === 'meta')) {
      if (fixedEnd < child.end) {
        const terminator = findHandlerNameTerminator(bytes, fixedEnd, child.end);
        if (terminator === -1) throw new ScanFailure('unsupported-structure');
        const nameBytes = terminator - fixedEnd + 1;
        delta.additionalAuxiliaryUnits = checkedAdd(delta.additionalAuxiliaryUnits,
          checkedMultiply(Math.ceil(nameBytes / 64), HDLR_EXTRA_UNITS_PER_64_NAME_BYTES));
      }
    }
  `;
  assert.equal(hdlrGuardBoundary(source).bounded, true);
  assert.equal(hdlrGuardBoundary(source.replace('index < end', 'index < bytes.byteLength')).bounded, false);
  assert.equal(hdlrGuardBoundary(source.replace("new Set(['mvhd'])", "new Set(['mvhd', 'hdlr'])")).bounded, false);
  assert.equal(hdlrGuardBoundary(source.replace('Math.ceil(nameBytes / 64)', 'nameBytes')).bounded, false);
  assert.equal(parserSurfaceDecision('hdlr', 'mdia'), 'modeled-handler-string');
  assert.equal(parserSurfaceDecision('hdlr', 'stbl'), 'unsupported');
});

function row(overrides = {}) {
  const {
    family = 'stsc', variant = 'entries', count = 1, controlCount = 0, repetition = 1, batch = 1,
    heap = 0, controlHeap = 0, metadata = 0, controlMetadata = 0,
    units = 0, controlUnits = 0, samples = 0, controlSamples = 0,
    version = '2.4.1', parserVerified = true, controlParserVerified = true, guardAccepted = true,
  } = overrides;
  const usage = (auxiliaryUnits, declaredSamples, metadataBytes) => ({
    auxiliaryUnits, declaredSamples, metadataBytes, visitedBoxes: 1, estimatedBytes: 1000, mode: family === 'trun' ? 'fragmented' : 'classic',
  });
  return {
    schema: 1, family, variant, count, repetition, measurementBatchSize: batch, units,
    version, parsedCount: count * batch, parserVerified, controlCount, controlUnits,
    controlParsedCount: controlCount * batch, controlParserVerified, guardAccepted,
    guardUsage: usage(controlUnits + units, samples, metadata),
    controlGuardUsage: usage(controlUnits, controlSamples, controlMetadata),
    retainedMemoryDeltaBytes: { heapUsed: heap, heapTotal: 0, arrayBuffers: 0, external: 0, rss: 0 },
    controlRetainedMemoryDeltaBytes: { heapUsed: controlHeap, heapTotal: 0, arrayBuffers: 0, external: 0, rss: 0 },
  };
}

function slopeFor(measuredUnits, residual, batch = 1) {
  return recalculateRawEvidence([row({ count: 1, batch, heap: residual * batch, units: measuredUnits })])
    .nonTrunFamilies[0].maxIndependentSlopeBytesPerUnit;
}

function co64Row({ count = 1, controlCount = 0, batch = 1, residualPerParser = 0, guardUnits, repetition = 1 } = {}) {
  const entries = count - controlCount;
  const currentUnits = guardUnits ?? entries * 7;
  const controlUnits = controlCount * 7;
  const value = row({
    family: 'co64', variant: 'entries', count, controlCount, repetition, batch,
    heap: residualPerParser * batch, units: currentUnits, controlUnits,
  });
  value.units = currentUnits * batch;
  value.controlUnits = controlUnits * batch;
  value.guardUsage.auxiliaryUnits = controlUnits + currentUnits;
  value.controlGuardUsage.auxiliaryUnits = controlUnits;
  return value;
}

function co64Result(rows) {
  const independent = recalculateRawEvidence(rows);
  return co64Counterfactual(rows, independent);
}

test('AUDIT-CALC-001: 32 B/unit passes', () => {
  assert.equal(slopeFor(10, 320), 32);
});

test('AUDIT-CALC-002: 64 B/unit passes at the inclusive boundary', () => {
  assert.equal(slopeFor(10, 640), 64);
});

test('AUDIT-CALC-003: 64.0001 B/unit exceeds the charge', () => {
  assert.ok(maximumPositiveSecant([{ units: 0, residualBytes: 0 }, { units: 10, residualBytes: 640.001 }]) > 64);
});

test('AUDIT-CALC-004: a local pairwise spike is not hidden by endpoint average', () => {
  const points = [{ units: 0, residualBytes: 0 }, { units: 1, residualBytes: 20 }, { units: 2, residualBytes: 200 }];
  assert.equal((points[2].residualBytes - points[0].residualBytes) / points[2].units, 100);
  assert.equal(maximumPositiveSecant(points), 180);
});

test('AUDIT-CALC-005: metadata delta is subtracted from the heap delta', () => {
  const result = independentResidual(row({ heap: 100, metadata: 40 }));
  assert.equal(result.rawResidual, 60);
  assert.equal(result.residual, 60);
});

test('AUDIT-CALC-006/007: production guard delta is the sole unit authority', () => {
  const value = row({ units: 9_999_999, heap: 192 });
  value.guardUsage.auxiliaryUnits = 3;
  assert.equal(recalculateRawEvidence([value]).nonTrunFamilies[0].maxIndependentSlopeBytesPerUnit, 64);
});

test('AUDIT-CALC-008: duplicate family/variant/count/repetition rows reject', () => {
  const value = row();
  assert.throws(() => validateRawRows([value, { ...value }]), /Duplicate M2 raw observation/);
});

test('AUDIT-CALC-009: NaN and Infinity memory measurements reject', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const raw = row();
    raw.retainedMemoryDeltaBytes.heapUsed = value;
    assert.throws(() => validateRawRows([raw]), /invalid retainedMemoryDeltaBytes/);
  }
});

test('AUDIT-CALC-010: unsafe integer guard counters reject', () => {
  const raw = row();
  raw.guardUsage.auxiliaryUnits = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => validateRawRows([raw]), /unsafe counter/);
});

test('AUDIT-CALC-011: missing paired trun control rejects', () => {
  const raw = row();
  delete raw.controlRetainedMemoryDeltaBytes;
  assert.throws(() => validateRawRows([raw]), /invalid controlRetainedMemoryDeltaBytes/);
});

test('AUDIT-CALC-012: a mismatched MP4Box version rejects', () => {
  assert.throws(() => validateRawRows([row({ version: '2.4.2' })]), /invalid provenance/);
});

test('AUDIT-CALC-013: parserVerified false rejects', () => {
  assert.throws(() => validateRawRows([row({ parserVerified: false })]), /invalid provenance/);
});

test('AUDIT-CALC-014: guardAccepted false rejects', () => {
  assert.throws(() => validateRawRows([row({ guardAccepted: false })]), /invalid provenance/);
});

test('AUDIT-CALC-015: negative signed raw heap residual remains observable', () => {
  const result = independentResidual(row({ heap: -17 }));
  assert.equal(result.rawResidual, -17);
  assert.equal(result.residual, 0);
});

test('AUDIT-CALC-016: trun rows with different declared samples cannot be paired', () => {
  const base = row({ family: 'trun', variant: '0-optional-fields', count: 5, samples: 5, heap: 20 });
  const target = row({ family: 'trun', variant: '3-optional-fields', count: 5, samples: 6, heap: 30, units: 9 });
  assert.throws(() => recalculateRawEvidence([base, target], { requiredTrunCounts: [] }), /Unequal trun sample count/);
});

test('AUDIT-CALC-017: residual and guard units normalize by measurement batch', () => {
  assert.equal(slopeFor(5, 320, 2), 64);
});

test('AUDIT-CALC-018: trun uses guard-unit and metadata deltas at the same sample count', () => {
  const base = row({ family: 'trun', variant: '0-optional-fields', count: 2, samples: 2, heap: 100, metadata: 10 });
  const target = row({ family: 'trun', variant: '3-optional-fields', count: 2, samples: 2, heap: 720, metadata: 30, units: 10 });
  const result = recalculateRawEvidence([base, target], { requiredTrunCounts: [] });
  assert.equal(result.trunComparisons[0].maxIndependentSlopeBytesPerUnit, 60);
});

test('AUDIT-CO64-CF-001: canonical batch counterfactual uses per-parser units', () => {
  const result = co64Result([co64Row({ batch: 256, residualPerParser: 332.90625 })]);
  assert.equal(result.currentSlopeBytesPerUnit, 47.558035714285715);
  assert.equal(result.oldCounterfactualSlopeBytesPerUnit, 55.484375);
});

test('AUDIT-CO64-CF-002: changing batch leaves the per-parser counterfactual invariant', () => {
  for (const batch of [1, 3, 16, 256]) {
    const result = co64Result([co64Row({ batch, residualPerParser: 336 })]);
    assert.equal(result.oldCounterfactualSlopeBytesPerUnit, 56);
    assert.equal(result.observations[0].oldUnitsPerParser, 6);
  }
});

test('AUDIT-CO64-CF-003: seven-to-six unit transformation scales the secant by 7/6', () => {
  const result = co64Result([
    co64Row({ count: 1, batch: 1, residualPerParser: 336 }),
    co64Row({ count: 10, batch: 3, residualPerParser: 3_360 }),
    co64Row({ count: 100, batch: 16, residualPerParser: 33_600 }),
  ]);
  assert.ok(Math.abs(result.oldCounterfactualSlopeBytesPerUnit - result.currentSlopeBytesPerUnit * 7 / 6) < 1e-12);
});

test('AUDIT-CO64-CF-004: multi-count observations retain seven current and six old units per entry', () => {
  const result = co64Result([
    co64Row({ count: 1, batch: 1, residualPerParser: 336 }),
    co64Row({ count: 10, batch: 3, residualPerParser: 3_360 }),
    co64Row({ count: 100, batch: 16, residualPerParser: 33_600 }),
  ]);
  assert.deepEqual(result.observations.map(({ count, currentUnitsPerParser, oldUnitsPerParser }) => ({
    count, currentUnitsPerParser, oldUnitsPerParser,
  })), [
    { count: 1, currentUnitsPerParser: 7, oldUnitsPerParser: 6 },
    { count: 10, currentUnitsPerParser: 70, oldUnitsPerParser: 60 },
    { count: 100, currentUnitsPerParser: 700, oldUnitsPerParser: 600 },
  ]);
});

test('AUDIT-CO64-CF-005: exactly 64 bytes per old unit does not exceed charge', () => {
  const result = co64Result([co64Row({ batch: 2, residualPerParser: 6 * 64 })]);
  assert.equal(result.oldCounterfactualSlopeBytesPerUnit, 64);
  assert.equal(result.oldChargeWouldFailRawOrSecant, false);
});

test('AUDIT-CO64-CF-006: one byte above the old per-entry charge is reported', () => {
  const result = co64Result([co64Row({ batch: 2, residualPerParser: 6 * 64 + 1 })]);
  assert.equal(result.oldChargeWouldFailRawOrSecant, true);
});

test('AUDIT-CO64-CF-007: a raw current model other than seven units per entry rejects', () => {
  assert.throws(() => co64Result([co64Row({ guardUnits: 8 })]), /Unexpected current CO64 auxiliary-unit model/);
});

test('AUDIT-CO64-CF-008: old units are derived by removing one current unit per entry', () => {
  const result = co64Result([co64Row({ count: 100, batch: 3, residualPerParser: 33_600 })]);
  assert.equal(result.observations[0].oldUnitsPerParser, result.observations[0].currentUnitsPerParser - 100);
  assert.equal(result.observations[0].oldUnitsPerParser, 6 * 100);
  assert.ok(result.observations[0].oldUnitsPerParser > 0);
});

test('AUDIT-CO64-CF-009: zero-entry control adds no secant point', () => {
  const result = co64Result([co64Row({ count: 0, controlCount: 0, batch: 4 })]);
  assert.equal(result.oldCounterfactualSlopeBytesPerUnit, 0);
  assert.deepEqual(result.observations, []);
});

test('AUDIT-CO64-CF-010: old units per parser do not change when only batch changes', () => {
  const results = [1, 3, 16, 256].map((batch) => co64Result([co64Row({ batch, residualPerParser: 336 })]));
  assert.deepEqual(results.map((value) => value.observations[0].oldUnitsPerParser), [6, 6, 6, 6]);
  assert.deepEqual(results.map((value) => value.oldCounterfactualSlopeBytesPerUnit), [56, 56, 56, 56]);
});

test('AUDIT-CO64-CF-011: negative/unsafe counts, invalid batches, and non-finite residuals reject', () => {
  const invalidRows = [
    co64Row({ count: -1 }),
    co64Row({ count: Number.MAX_SAFE_INTEGER + 1 }),
    co64Row({ batch: 0 }),
    co64Row({ batch: -1 }),
    co64Row({ residualPerParser: Number.NaN }),
    co64Row({ residualPerParser: Number.POSITIVE_INFINITY }),
  ];
  for (const invalid of invalidRows) assert.throws(() => co64Result([invalid]));
});
