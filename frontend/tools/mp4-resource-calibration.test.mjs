import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as resourceModel from './mp4-resource-calibration-lib.mjs';
import { expectedCorpusShape } from './mp4-resource-calibration.mjs';
import {
  CALIBRATION_CASES,
  OUTPUT_ROOT,
  buildManifest,
  aggregateLiveParserCosts,
  assertExpectedMp4BoxVersion,
  classifyResourceAcceptance,
  deriveResourcePolicies,
  EXPECTED_MP4BOX_VERSION,
  estimateParserMemory,
  fitPreExpansionResourceModel,
  linearFit,
  median,
  parseChildOutput,
  requireExplicitGc,
  resolveMp4BoxVersion,
  scanMp4ResourceMetadata,
  summarize,
  validateResourceModel,
  validateManifest,
  writeJsonAtomic,
} from './mp4-resource-calibration-lib.mjs';

test('median handles single, odd, and even datasets', () => {
  assert.equal(median([1]), 1);
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('summary reports min, median, and max', () => {
  assert.deepEqual(summarize([4, 1, 3]), { min: 1, median: 3, max: 4 });
});

test('linear fit recovers a known line', () => {
  const fit = linearFit([{ x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 7 }]);
  assert.equal(fit.slopeBytesPerSample, 2);
  assert.equal(fit.interceptBytes, 1);
  assert.equal(fit.rSquared, 1);
});

test('policy candidates use effective samples and measured concurrent parser heap', () => {
  const makeCase = (caseId, sampleCount, heap, audioTracks = 0, candidateHeap = heap * 2, multiCandidateHeap = heap * 3) => ({
    caseId,
    sampleCount,
    audioTracks,
    status: 'completed',
    parserIndexHeapBytes: { max: heap },
    candidate: [{ combinedParserHeapBytes: candidateHeap, candidateBootstrapBytes: 4096 }],
    multipleCandidates: [{ candidateCount: 2, combinedParserHeapBytes: multiCandidateHeap }],
  });
  const policies = deriveResourcePolicies([
    makeCase('small', 10_000, 10),
    makeCase('audio-45k', 45_000, 18, 1),
    makeCase('edge-50k', 50_000, 20),
    makeCase('edge-100k', 100_000, 40),
    makeCase('audio-128k', 128_000, 45, 1),
    makeCase('edge-200k', 200_000, 80),
  ]);
  assert.deepEqual(policies.map((policy) => policy.perParserIndexBudgetBytes), [20, 40, 80]);
  assert.deepEqual(policies.map((policy) => policy.aggregateLiveParserIndexBudgetBytes), [60, 120, 240]);
  assert.deepEqual(policies[0].observedCorpusAccepted, ['small', 'audio-45k', 'edge-50k']);
  assert.equal(policies[0].simultaneouslyMeasuredCandidates, 2);
});

test('corpus structure validation rejects a wrong stream count or moov position', () => {
  const fixture = CALIBRATION_CASES[0];
  const probe = {
    streams: [{ codec_type: 'video' }],
    box: { topLevel: ['ftyp', 'moov', 'mdat'], moovPosition: 'head', moofCount: 0, trunCount: 0 },
    sampleCount: fixture.videoFrames,
    format: { duration: fixture.videoFrames / fixture.fps },
    fileBytes: 1000,
  };
  assert.equal(expectedCorpusShape(fixture, probe).valid, true);
  assert.equal(expectedCorpusShape(fixture, { ...probe, streams: [] }).valid, false);
  assert.equal(expectedCorpusShape(fixture, { ...probe, box: { ...probe.box, moovPosition: 'tail' } }).valid, false);
});

test('manifest is deterministic and has unique safe fixture names', () => {
  const first = buildManifest();
  const second = buildManifest();
  assert.deepEqual(first, second);
  assert.equal(new Set(first.cases.map((item) => item.id)).size, first.cases.length);
  assert.ok(first.cases.every((item) => /^[a-z0-9-]+$/.test(item.id)));
  assert.equal(first.cases.some((item) => 'timestamp' in item), false);
});

test('manifest rejects invalid frame rate, frame count, mode, and duplicate IDs', () => {
  const valid = CALIBRATION_CASES[0];
  assert.throws(() => validateManifest([{ ...valid, fps: 0 }]), /fps/);
  assert.throws(() => validateManifest([{ ...valid, videoFrames: 0 }]), /frame count/);
  assert.throws(() => validateManifest([{ ...valid, mode: 'unknown' }]), /mode/);
  assert.throws(() => validateManifest([valid, { ...valid }]), /Duplicate/);
  assert.throws(() => validateManifest([{ ...valid, id: '../fixture' }]), /fixture ID/);
  assert.throws(() => validateManifest([{ ...valid, videoFrames: 200_001 }]), /over-budget/);
});

test('measurement requires explicit Node garbage collection', () => {
  assert.throws(() => requireExplicitGc(null), /--expose-gc/);
  assert.equal(requireExplicitGc(() => {}) instanceof Function, true);
});

test('resolved frontend MP4Box version is present and discoverable', () => {
  const resolved = resolveMp4BoxVersion();
  assert.equal(resolved.version, EXPECTED_MP4BOX_VERSION);
  assert.match(resolved.entry, /^node_modules\/mp4box\//);
  assert.equal(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies.mp4box, EXPECTED_MP4BOX_VERSION);
  assert.throws(() => assertExpectedMp4BoxVersion({ version: '2.4.2', entry: resolved.entry }), /2\.4\.1 is required/);
  assert.equal(assertExpectedMp4BoxVersion(resolved), resolved);
});

test('child output accepts valid JSON and fails closed for process and schema errors', () => {
  assert.equal(parseChildOutput(JSON.stringify({ schema: 1, caseId: 'valid', sampleCount: 2, indexHeapBytes: 10 })).caseId, 'valid');
  assert.throws(() => parseChildOutput('{}'), /missing required fields/);
  assert.throws(() => parseChildOutput('{'), /invalid JSON/);
  assert.throws(() => parseChildOutput('{}', 1), /status 1/);
});

test('JSON output is written atomically into its parent directory', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanika-mp4-calibration-'));
  try {
    const output = path.join(temporaryRoot, 'nested', 'result.json');
    writeJsonAtomic(output, { schema: 1, value: 42 });
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { schema: 1, value: 42 });
    assert.deepEqual(fs.readdirSync(path.dirname(output)), ['result.json']);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('default quality artifacts stay under ignored .quality output', () => {
  assert.match(OUTPUT_ROOT.replaceAll('\\', '/'), /\/\.quality\/mp4-resource-calibration$/);
});

const historicalClassicObservations = [
  { caseId: 'classic-faststart-v30-10k', mode: 'classic', status: 'completed', sampleCount: 10_000, parserIndexHeapBytes: { max: 4_039_640 }, tracks: [{ type: 'video', indexSampleCount: 10_000 }] },
  { caseId: 'classic-faststart-v30-50k', mode: 'classic', status: 'completed', sampleCount: 50_000, parserIndexHeapBytes: { max: 12_401_104 }, tracks: [{ type: 'video', indexSampleCount: 50_000 }] },
  { caseId: 'classic-faststart-v30-100k', mode: 'classic', status: 'completed', sampleCount: 100_000, parserIndexHeapBytes: { max: 22_965_016 }, tracks: [{ type: 'video', indexSampleCount: 100_000 }] },
  { caseId: 'classic-faststart-v30-200k', mode: 'classic', status: 'completed', sampleCount: 200_000, parserIndexHeapBytes: { max: 44_123_328 }, tracks: [{ type: 'video', indexSampleCount: 200_000 }] },
  { caseId: 'classic-av-v30-10k', mode: 'classic', status: 'completed', sampleCount: 25_626, parserIndexHeapBytes: { max: 10_262_736 }, tracks: [{ type: 'video', indexSampleCount: 10_000 }, { type: 'audio', indexSampleCount: 15_626 }] },
  { caseId: 'classic-multitrack-v30-10k', mode: 'classic', status: 'completed', sampleCount: 41_270, parserIndexHeapBytes: { max: 16_378_504 }, tracks: [{ type: 'video', indexSampleCount: 10_000 }, { type: 'audio', indexSampleCount: 15_635 }, { type: 'audio', indexSampleCount: 15_635 }] },
  { caseId: 'classic-av-v30-50k', mode: 'classic', status: 'completed', sampleCount: 128_126, parserIndexHeapBytes: { max: 42_890_672 }, tracks: [{ type: 'video', indexSampleCount: 50_000 }, { type: 'audio', indexSampleCount: 78_126 }] },
];

test('B89-R1M1-MODEL-001: pre-expansion estimate covers held-out classic A/V', () => {
  const model = resourceModel.fitPreExpansionResourceModel(historicalClassicObservations, 'classic', {
    holdoutCaseIds: ['classic-av-v30-50k'],
  });
  const estimate = resourceModel.estimateParserMemory(model, { status: 'characterized', mode: 'classic', sampleCount: 128_126 });
  assert.ok(estimate >= 42_890_672, `estimated ${estimate} < measured 42890672`);
});

test('B89-R1M1-MODEL-002: pre-expansion estimate covers classic multi-track', () => {
  const model = resourceModel.fitPreExpansionResourceModel(historicalClassicObservations, 'classic', {
    holdoutCaseIds: ['classic-av-v30-50k'],
  });
  const estimate = resourceModel.estimateParserMemory(model, { status: 'characterized', mode: 'classic', sampleCount: 41_270 });
  assert.ok(estimate >= 16_378_504, `estimated ${estimate} < measured 16378504`);
});

test('B89-R1M1-MODEL-003: acceptance uses estimate, not a low post-parse heap', () => {
  assert.equal(resourceModel.classifyResourceAcceptance({
    estimatedBytes: 1_000,
    observedHeapBytes: 10,
    budgetBytes: 500,
  }), 'reject');
});

test('B89-R1M1-MODEL-004: model validation reports any observed underestimation', () => {
  const validation = resourceModel.validateResourceModel(
    { mode: 'classic', fixedBytes: 0, bytesPerSample: 1, auxiliaryUnitBytes: 0, safetyFactor: 1 },
    [{ caseId: 'underestimated', sampleCount: 100, observedParserHeapBytes: 500 }],
  );
  assert.equal(validation.status, 'not-ratified');
  assert.equal(validation.underestimates.length, 1);
});

test('B89-R1M1-MODEL-005: aggregate budget sums heterogeneous live parsers', () => {
  assert.equal(resourceModel.aggregateLiveParserCosts([
    { id: 'active', estimatedBytes: 100 },
    { id: 'candidate-a', estimatedBytes: 200 },
    { id: 'candidate-b', estimatedBytes: 350 },
  ]), 650);
});

function mp4Box(type, payload = Buffer.alloc(0), sizeMode = 'normal') {
  const headerBytes = sizeMode === 'extended' ? 16 : 8;
  const box = Buffer.alloc(headerBytes + payload.length);
  box.writeUInt32BE(sizeMode === 'zero' ? 0 : sizeMode === 'extended' ? 1 : box.length, 0);
  box.write(type, 4, 4, 'ascii');
  if (sizeMode === 'extended') box.writeBigUInt64BE(BigInt(box.length), 8);
  payload.copy(box, headerBytes);
  return box;
}

function fullBox(type, body = Buffer.alloc(0), flags = 0) {
  const full = Buffer.alloc(4);
  full.writeUInt32BE(flags & 0x00ff_ffff);
  return mp4Box(type, Buffer.concat([full, body]));
}

function syntheticTrack({ id = 1, handler = 'vide', samples = 0, sizeField = 'stsz', fixedSize = 1, extra = [], mdiaExtra = [], entryExtra = [] } = {}) {
  const tkhd = Buffer.alloc(16);
  tkhd.writeUInt32BE(id, 8);
  const hdlr = Buffer.alloc(20);
  hdlr.write(handler, 4, 4, 'ascii');
  let sizeBox;
  if (sizeField === 'stsz') {
    const body = Buffer.alloc(8 + (fixedSize === 0 ? samples * 4 : 0));
    body.writeUInt32BE(fixedSize, 0);
    body.writeUInt32BE(samples, 4);
    sizeBox = fullBox('stsz', body);
  } else if (sizeField === 'stz2') {
    const packedBytes = Math.ceil(samples / 2);
    const body = Buffer.alloc(8 + packedBytes);
    body[3] = 4;
    body.writeUInt32BE(samples, 4);
    sizeBox = fullBox('stz2', body);
  }
  const descriptionCount = Buffer.alloc(4);
  descriptionCount.writeUInt32BE(1);
  const description = mp4Box(handler === 'vide' ? 'avc1' : 'mp4a', Buffer.concat([Buffer.alloc(handler === 'vide' ? 78 : 28), ...entryExtra]));
  const stsd = fullBox('stsd', Buffer.concat([descriptionCount, description]));
  const stbl = mp4Box('stbl', Buffer.concat([stsd, ...(sizeBox ? [sizeBox] : []), ...extra]));
  const mediaHeader = handler === 'vide' ? fullBox('vmhd', Buffer.alloc(8), 1) : fullBox('smhd', Buffer.alloc(4));
  const minf = mp4Box('minf', Buffer.concat([mediaHeader, stbl]));
  const mdia = mp4Box('mdia', Buffer.concat([fullBox('hdlr', hdlr), ...mdiaExtra, minf]));
  return mp4Box('trak', Buffer.concat([fullBox('tkhd', tkhd), mdia]));
}

function syntheticFragment(trackId, sampleCount, flags = 0) {
  const tfhd = fullBox('tfhd', Buffer.from([0, 0, 0, trackId]));
  const fieldCount = [0x100, 0x200, 0x400, 0x800].filter((flag) => flags & flag).length;
  const trunBody = Buffer.alloc(4 + fieldCount * sampleCount * 4);
  trunBody.writeUInt32BE(sampleCount, 0);
  const trun = fullBox('trun', trunBody, flags);
  return mp4Box('moof', mp4Box('traf', Buffer.concat([tfhd, trun])));
}

function syntheticMp4({ track = {}, fragments = [], topLevelMoovMode = 'normal', extraMoovBoxes = [] } = {}) {
  const moov = mp4Box('moov', Buffer.concat([syntheticTrack(track), ...extraMoovBoxes]), topLevelMoovMode);
  return Buffer.concat([mp4Box('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.alloc(4)])), moov, ...fragments]);
}

test('scanner counts fixed-size stsz without allocating per declared sample', () => {
  const bytes = syntheticMp4({ track: { samples: 4_000_000_000 } });
  const metadata = scanMp4ResourceMetadata(bytes);
  assert.equal(metadata.status, 'characterized');
  assert.equal(metadata.declaredSamples, 4_000_000_000);
  assert.ok(metadata.visitedBoxes < 20);
  assert.equal(bytes.length < 512, true);
});

test('scanner rejects an inconsistent variable-size stsz before interpreting samples', () => {
  const malformedBody = Buffer.alloc(8);
  malformedBody.writeUInt32BE(2, 4);
  const malformed = fullBox('stsz', malformedBody);
  const track = syntheticTrack({ samples: 0, sizeField: 'none', extra: [malformed] });
  assert.throws(() => scanMp4ResourceMetadata(mp4Box('moov', track)), /Inconsistent stsz sample-size length/);
});

test('scanner counts stz2 and a trun split across moofs without sample-sized loops', () => {
  const stz2 = scanMp4ResourceMetadata(syntheticMp4({ track: { samples: 3, sizeField: 'stz2' } }));
  assert.equal(stz2.declaredSamples, 3);
  const fragmented = scanMp4ResourceMetadata(syntheticMp4({
    track: { samples: 0 },
    fragments: [syntheticFragment(1, 3), syntheticFragment(1, 5)],
  }));
  assert.equal(fragmented.mode, 'fragmented');
  assert.equal(fragmented.declaredSamples, 8);
  assert.equal(fragmented.moofCount, 2);
});

test('scanner bounds an abusive trun sample_count without sample-proportional allocation', () => {
  const metadata = scanMp4ResourceMetadata(syntheticMp4({
    track: { samples: 0 },
    fragments: [syntheticFragment(1, 4_000_000_000)],
  }));
  assert.equal(metadata.status, 'characterized');
  assert.equal(metadata.declaredSamples, 4_000_000_000);
  assert.ok(metadata.visitedBoxes < 20);
  const estimate = estimateParserMemory({ mode: 'fragmented', fixedBytes: 0, bytesPerSample: 1, auxiliaryUnitBytes: 0, safetyFactor: 1 }, metadata);
  assert.equal(classifyResourceAcceptance({ estimatedBytes: estimate, budgetBytes: 100_000_000 }), 'reject');
});

test('scanner accounts for per-sample trun fields and skips mdat payload bytes', () => {
  const bytes = Buffer.concat([
    mp4Box('moov', syntheticTrack({ samples: 0 })),
    syntheticFragment(1, 4, 0x000100 | 0x000200),
    mp4Box('mdat', Buffer.alloc(256 * 1024, 0xff)),
  ]);
  const metadata = scanMp4ResourceMetadata(bytes);
  assert.equal(metadata.declaredSamples, 4);
  assert.equal(metadata.perSampleFieldUnits, 8);
  assert.equal(metadata.auxiliaryUnits, metadata.auxiliaryEntryCount + metadata.perSampleFieldUnits
    + metadata.visitedBoxes * 2 + metadata.additionalAuxiliaryUnits);
  assert.equal(metadata.additionalAuxiliaryUnits, 21);
  assert.equal(metadata.structuralUnits, metadata.declaredSamples + metadata.auxiliaryUnits);
  assert.equal(metadata.visitedBoxes, 16);
});

test('scanner applies measured weights to roll sgpd and rejects MP4Box 2.4.1 sgpd version 2', () => {
  const count = 3;
  const version0 = fullBox('sgpd', Buffer.concat([Buffer.from('roll'), Buffer.from([0, 0, 0, count]), Buffer.alloc(count * 2)]));
  const metadata = scanMp4ResourceMetadata(syntheticMp4({ track: { samples: 1, extra: [version0] } }));
  assert.equal(metadata.status, 'characterized');
  assert.equal(metadata.auxiliaryEntryCountsByType.sgpd, count);
  assert.equal(metadata.additionalAuxiliaryUnits, 17 + count * 10);

  const version2 = mp4Box('sgpd', Buffer.concat([
    Buffer.from([2, 0, 0, 0]), Buffer.from('roll'), Buffer.from([0, 0, 0, 2]),
    Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), Buffer.alloc(2),
  ]));
  const rejected = scanMp4ResourceMetadata(syntheticMp4({ track: { samples: 1, extra: [version2] } }));
  assert.equal(rejected.status, 'uncharacterized');
  assert.ok(rejected.reasons.includes('unsupported-sgpd-version'));
});

test('scanner admits bounded MP4Box-generated elng and charges parser/string retention', () => {
  const language = fullBox('elng', Buffer.from('fr-FR'));
  const metadata = scanMp4ResourceMetadata(syntheticMp4({ track: { samples: 1, mdiaExtra: [language] } }));
  assert.equal(metadata.status, 'characterized');
  assert.equal(metadata.additionalAuxiliaryUnits, 23);

  const tooLong = fullBox('elng', Buffer.from('a'.repeat(64)));
  const rejected = scanMp4ResourceMetadata(syntheticMp4({ track: { samples: 1, mdiaExtra: [tooLong] } }));
  assert.equal(rejected.status, 'uncharacterized');
  assert.ok(rejected.reasons.includes('unsupported-elng-layout'));
});

test('scanner mirrors probe-derived auxiliary weights for avcC and trun field-array allocations', () => {
  const base = scanMp4ResourceMetadata(syntheticMp4({ track: { samples: 1 } }));
  const avcC = mp4Box('avcC', Buffer.from([1, 66, 0, 30, 0xff, 1, 0, 1, 0x67, 0]));
  const configured = scanMp4ResourceMetadata(syntheticMp4({ track: { samples: 1, entryExtra: [avcC] } }));
  assert.equal(configured.auxiliaryEntryCountsByType.avcC, 1);
  assert.equal(configured.additionalAuxiliaryUnits - base.additionalAuxiliaryUnits, 5);

  const withoutFields = scanMp4ResourceMetadata(syntheticMp4({ track: { samples: 1 }, fragments: [syntheticFragment(1, 1)] }));
  const withFieldArray = scanMp4ResourceMetadata(syntheticMp4({ track: { samples: 1 }, fragments: [syntheticFragment(1, 1, 0x000100)] }));
  assert.equal(withFieldArray.perSampleFieldUnits - withoutFields.perSampleFieldUnits, 1);
  assert.equal(withFieldArray.additionalAuxiliaryUnits - withoutFields.additionalAuxiliaryUnits, 2);
});

test('scanner extracts the actual sidx reference count for versions 0 and 1', () => {
  const references = Buffer.alloc(12);
  const v0 = mp4Box('sidx', Buffer.concat([
    Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), Buffer.from([0, 0, 3, 232]), Buffer.alloc(4),
    Buffer.alloc(4), Buffer.alloc(2), Buffer.from([0, 1]), references,
  ]));
  const baseline = scanMp4ResourceMetadata(syntheticMp4({ track: { samples: 1 } }));
  const metadataV0 = scanMp4ResourceMetadata(Buffer.concat([syntheticMp4({ track: { samples: 1 } }), v0]));
  assert.equal(metadataV0.status, 'characterized');
  assert.equal(metadataV0.auxiliaryEntryCountsByType.sidx, 1);
  assert.equal(metadataV0.additionalAuxiliaryUnits - baseline.additionalAuxiliaryUnits, 1);

  const v1 = mp4Box('sidx', Buffer.concat([
    Buffer.from([1, 0, 0, 0]), Buffer.from([0, 0, 0, 1]), Buffer.from([0, 0, 3, 232]), Buffer.alloc(16),
    Buffer.alloc(2), Buffer.from([0, 1]), references,
  ]));
  const metadataV1 = scanMp4ResourceMetadata(Buffer.concat([syntheticMp4({ track: { samples: 1 } }), v1]));
  assert.equal(metadataV1.status, 'characterized');
  assert.equal(metadataV1.auxiliaryEntryCountsByType.sidx, 1);
});

test('scanner supports extended and zero-to-parent box sizes and fails closed on unknown expansion', () => {
  const extended = scanMp4ResourceMetadata(syntheticMp4({ track: { samples: 2 }, topLevelMoovMode: 'extended' }));
  assert.equal(extended.status, 'characterized');
  const zeroSize = Buffer.concat([mp4Box('moov', syntheticTrack({ samples: 2 }), 'zero')]);
  assert.equal(scanMp4ResourceMetadata(zeroSize).declaredSamples, 2);
  const unknown = scanMp4ResourceMetadata(syntheticMp4({ track: { samples: 2, extra: [mp4Box('subs', Buffer.alloc(4))] } }));
  assert.equal(unknown.status, 'uncharacterized');
  assert.ok(unknown.reasons.some((reason) => reason.includes('subs')));
  assert.throws(() => scanMp4ResourceMetadata(Buffer.from([0, 0, 0, 4, 0, 0, 0, 0])), /Invalid MP4 box bounds/);
});

test('scanner fails closed on unknown track identity, track type, and MP4 expansion structures', () => {
  const unknownHandler = scanMp4ResourceMetadata(syntheticMp4({ track: { handler: 'meta', samples: 2 } }));
  assert.equal(unknownHandler.status, 'uncharacterized');
  assert.ok(unknownHandler.reasons.some((reason) => reason.includes('unsupported-track-handler')));
  const unresolvedFragment = scanMp4ResourceMetadata(syntheticMp4({
    track: { id: 1, samples: 0 },
    fragments: [syntheticFragment(2, 2)],
  }));
  assert.equal(unresolvedFragment.status, 'uncharacterized');
  assert.ok(unresolvedFragment.reasons.includes('fragment-track-unresolved'));
});

test('scanner marks unknown nested children and known boxes in the wrong parent uncharacterized', () => {
  const unknownChild = scanMp4ResourceMetadata(syntheticMp4({ track: { samples: 2, extra: [mp4Box('zzzz')] } }));
  assert.equal(unknownChild.status, 'uncharacterized');
  assert.ok(unknownChild.reasons.some((reason) => reason.includes('unsupported-nested-box:zzzz')));
  const wrongParent = scanMp4ResourceMetadata(syntheticMp4({
    track: { samples: 2 },
    extraMoovBoxes: [fullBox('stsz', Buffer.alloc(8))],
  }));
  assert.equal(wrongParent.status, 'uncharacterized');
  assert.ok(wrongParent.reasons.some((reason) => reason.includes('unsupported-nested-box:stsz')));
});

test('scanner enforces depth, visited-box, metadata-byte, and track-count limits', () => {
  const file = syntheticMp4({ track: { samples: 2 } });
  assert.throws(() => scanMp4ResourceMetadata(file, { maxDepth: 2 }), /nesting limit/);
  assert.throws(() => scanMp4ResourceMetadata(file, { maxVisitedBoxes: 4 }), /box-count limit/);
  assert.equal(scanMp4ResourceMetadata(file, { maxMetadataBytes: 16 }).status, 'uncharacterized');
  const tk1 = syntheticTrack({ id: 1, samples: 1 });
  const tk2 = syntheticTrack({ id: 2, samples: 1 });
  assert.throws(() => scanMp4ResourceMetadata(mp4Box('moov', Buffer.concat([tk1, tk2])), { maxTracks: 1 }), /track-count limit/);
});

test('model estimate rejects unknown structures and unsafe arithmetic', () => {
  const model = { mode: 'classic', fixedBytes: 1, bytesPerSample: 2, auxiliaryUnitBytes: 0, safetyFactor: 1.1 };
  assert.throws(() => estimateParserMemory(model, { status: 'uncharacterized', mode: 'classic', structuralUnits: 1 }), /uncharacterized/);
  assert.throws(() => estimateParserMemory(model, { status: 'characterized', mode: 'classic', sampleCount: Number.MAX_SAFE_INTEGER }), /safe integer/);
  assert.equal(classifyResourceAcceptance({ estimatedBytes: 501, observedHeapBytes: 1, budgetBytes: 500 }), 'reject');
  assert.equal(validateResourceModel(model, [{ sampleCount: 100, observedParserHeapBytes: 500 }]).status, 'not-ratified');
});

test('live parser accounting distinguishes owners, candidates, removal, and promotion', () => {
  const active = { id: 'active', estimatedBytes: 100 };
  const candidateA = { id: 'candidate-a', estimatedBytes: 240 };
  const candidateB = { id: 'candidate-b', estimatedBytes: 410 };
  assert.equal(aggregateLiveParserCosts([active, candidateA]), 340);
  assert.equal(aggregateLiveParserCosts([active, candidateA, candidateB]), 750);
  assert.equal(aggregateLiveParserCosts([active, candidateB]), 510); // candidate A released/stale
  assert.equal(aggregateLiveParserCosts([{ ...candidateA, id: 'active' }]), 240); // promote; do not double count owner
  assert.throws(() => aggregateLiveParserCosts([active, { ...candidateA, id: 'active' }]), /duplicate/);
  assert.throws(() => aggregateLiveParserCosts([{ id: 'a', estimatedBytes: Number.MAX_SAFE_INTEGER }, { id: 'b', estimatedBytes: 1 }]), /Unsafe MP4 resource/);
});
