import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHARGE_BYTES = 64;
export const EXPECTED_VERSION = '2.4.1';
export const EXPECTED_ENTRY_SHA256 = 'fe5c6e926ba86f46469aa2b96389b32ecc7d1220f2b546400885fd04093bd80a';
export const MAX_NEW_ISOLATED_NODE_PROBES = 140;
const SCRIPT = fileURLToPath(import.meta.url);
const FRONTEND_ROOT = path.resolve(path.dirname(SCRIPT), '..');
const REPOSITORY_ROOT = path.resolve(FRONTEND_ROOT, '..');
const M2 = path.join(REPOSITORY_ROOT, '.quality', 'b89-r3m2-ap01');
const OUT = path.join(REPOSITORY_ROOT, '.quality', 'b89-r3m3-ap01');
const GUARD = path.join(FRONTEND_ROOT, 'src/app/features/drive/workers/stream-transmux-resource-guard.ts');
const PROBE = path.join(FRONTEND_ROOT, 'tools/mp4-auxiliary-resource-probe.mjs');
const require = createRequire(path.join(FRONTEND_ROOT, 'package.json'));
const mp4box = require('mp4box');
const memoryKeys = ['heapUsed', 'heapTotal', 'arrayBuffers', 'external', 'rss'];
const usageKeys = ['declaredSamples', 'auxiliaryUnits', 'metadataBytes', 'visitedBoxes', 'estimatedBytes'];
const startedPhases = [];

const fail = (message) => { throw new Error(message); };
const isSafeCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function json(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function timed(name, work) {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  try {
    const value = work();
    startedPhases.push({ name, startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start), status: 'PASS' });
    saveTimings();
    return value;
  } catch (error) {
    startedPhases.push({ name, startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start), status: 'FAIL', error: String(error?.message ?? error) });
    saveTimings();
    throw error;
  }
}

function saveTimings() {
  writeJson(path.join(OUT, 'gate-timings.json'), { schema: 1, round: 'B.89-R3.M3', phases: [...startedPhases] });
}

export function expectedPostHash(report, file) {
  const line = report.split(/\r?\n/).find((value) => value.includes(`| \`${file}\` |`));
  return line?.split('|').map((value) => value.trim())[3]?.replaceAll('`', '') ?? null;
}

export function parseAllowedSampleEntries(source) {
  return [...new Set([...source.matchAll(/entry\.type === '(avc1|mp4a)'/g)].map((item) => item[1]))].sort();
}

export function hdlrParserReadsPastDeclaredChild(source) {
  return /readCString\(\s*\)/.test(source) && !/readCString\(\s*name_size\s*\)/.test(source);
}

export function hdlrGuardBoundary(source) {
  const safeTypes = parseLiteralSet(source, 'SAFE_FIXED_OR_SIZE_BOUNDED_BOXES');
  const specializedBranch = /child\.type === 'hdlr'\s*&&\s*\(\s*parentType === 'mdia'\s*\|\|\s*parentType === 'meta'\s*\)/.test(source);
  const helper = source.match(/function findHandlerNameTerminator\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? '';
  const byteLoopStopsAtEnd = /index\s*=\s*start\s*;\s*index\s*<\s*end\s*;\s*index\+\+/.test(helper);
  const nulCheck = /bytes\[index\]\s*===\s*0/.test(helper);
  const branchUsesDeclaredChildEnd = /if\s*\(fixedEnd\s*<\s*child\.end\)[\s\S]*?findHandlerNameTerminator\(bytes,\s*fixedEnd,\s*child\.end\)/.test(source);
  const rejectsMissingNameTerminator = /const terminator = findHandlerNameTerminator\(bytes,\s*fixedEnd,\s*child\.end\);[\s\S]*?if\s*\(terminator\s*===\s*-1\)\s*throw new ScanFailure\('unsupported-structure'\)/.test(source);
  const safeClassificationRemoved = !safeTypes.includes('hdlr');
  const nameBytesIncludeTerminator = /const nameBytes = terminator - fixedEnd \+ 1/.test(source);
  const retainedStringCharge = /HDLR_EXTRA_UNITS_PER_64_NAME_BYTES\s*=\s*1/.test(source)
    && /checkedMultiply\(Math\.ceil\(nameBytes \/ 64\),\s*HDLR_EXTRA_UNITS_PER_64_NAME_BYTES\)/.test(source);
  return {
    specializedBranch,
    byteLoopStopsAtEnd,
    nulCheck,
    branchUsesDeclaredChildEnd,
    rejectsMissingNameTerminator,
    safeClassificationRemoved,
    nameBytesIncludeTerminator,
    retainedStringCharge,
    bounded: specializedBranch && byteLoopStopsAtEnd && nulCheck && branchUsesDeclaredChildEnd
      && rejectsMissingNameTerminator && safeClassificationRemoved && nameBytesIncludeTerminator && retainedStringCharge,
  };
}

function currentMp4box() {
  const entry = require.resolve('mp4box');
  const metadata = json(path.resolve(path.dirname(entry), '..', 'package.json'));
  return { version: metadata.version, entry: path.relative(FRONTEND_ROOT, entry).replaceAll(path.sep, '/'), entrySha256: sha256(entry) };
}

export function validateGuardUsage(usage, label = 'guard usage') {
  if (!usage || !usageKeys.every((key) => isSafeCount(usage[key]))
      || !['classic', 'fragmented', 'unknown'].includes(usage.mode)) {
    fail(`${label} is incomplete or contains an unsafe counter.`);
  }
}

export function validateRawRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) fail('M2 raw observations are missing.');
  const keys = new Set();
  for (const row of rows) {
    if (!row || row.schema !== 1 || row.version !== EXPECTED_VERSION || row.parserVerified !== true
        || row.controlParserVerified !== true || row.guardAccepted !== true
        || typeof row.family !== 'string' || typeof row.variant !== 'string'
        || !Number.isSafeInteger(row.repetition) || row.repetition < 1
        || !Number.isSafeInteger(row.measurementBatchSize) || row.measurementBatchSize < 1
        || !isSafeCount(row.count) || !isSafeCount(row.controlCount)) {
      fail('M2 raw observation has invalid provenance or counters.');
    }
    validateGuardUsage(row.guardUsage, 'target guard usage');
    validateGuardUsage(row.controlGuardUsage, 'control guard usage');
    for (const field of ['retainedMemoryDeltaBytes', 'controlRetainedMemoryDeltaBytes']) {
      if (!row[field] || !memoryKeys.every((key) => isFiniteNumber(row[field][key]))) {
        fail(`M2 raw observation has invalid ${field}.`);
      }
    }
    const key = `${row.family}\0${row.variant}\0${row.count}\0${row.repetition}`;
    if (keys.has(key)) fail(`Duplicate M2 raw observation: ${row.family}/${row.variant}/${row.count}/${row.repetition}.`);
    keys.add(key);
  }
  return rows.length;
}

export function independentResidual(row) {
  const heapDelta = row.retainedMemoryDeltaBytes.heapUsed - row.controlRetainedMemoryDeltaBytes.heapUsed;
  const metadataDelta = row.guardUsage.metadataBytes - row.controlGuardUsage.metadataBytes;
  const rawResidual = heapDelta - metadataDelta;
  if (!Number.isSafeInteger(rawResidual)) fail('Independent residual exceeds safe integer precision.');
  return { heapDelta, metadataDelta, rawResidual, residual: Math.max(0, rawResidual) };
}

export function maximumPositiveSecant(points) {
  const ordered = [...points].sort((left, right) => left.units - right.units);
  let maximum = 0;
  for (let left = 0; left < ordered.length; left++) {
    for (let right = left + 1; right < ordered.length; right++) {
      const deltaUnits = ordered[right].units - ordered[left].units;
      const deltaResidual = ordered[right].residualBytes - ordered[left].residualBytes;
      if (deltaUnits > 0 && deltaResidual > 0) maximum = Math.max(maximum, deltaResidual / deltaUnits);
    }
  }
  return maximum;
}

function independentNonTrun(rows) {
  const groups = new Map();
  for (const row of rows.filter((item) => item.family !== 'trun')) {
    const sampleDelta = row.guardUsage.declaredSamples - row.controlGuardUsage.declaredSamples;
    const units = row.guardUsage.auxiliaryUnits - row.controlGuardUsage.auxiliaryUnits;
    if (sampleDelta !== 0 || !isSafeCount(units)) fail(`Non-trun control mismatch at ${row.family}/${row.variant}/${row.count}.`);
    const value = independentResidual(row);
    const key = `${row.family}\0${row.variant}`;
    const points = groups.get(key) ?? new Map();
    const countRows = points.get(row.count) ?? [];
    countRows.push({ count: row.count, units, residualPerParser: value.residual / row.measurementBatchSize, rawResidual: value.rawResidual, repetition: row.repetition, batchSize: row.measurementBatchSize });
    points.set(row.count, countRows);
    groups.set(key, points);
  }

  const families = [];
  for (const [key, pointsByCount] of groups) {
    const [family, variant] = key.split('\0');
    const observations = [...pointsByCount.entries()].map(([count, values]) => {
      const units = values[0].units;
      const batchSize = values[0].batchSize;
      if (values.some((value) => value.units !== units || value.batchSize !== batchSize)) fail(`Inconsistent guard units or batch size: ${family}/${variant}/${count}.`);
      return {
        count,
        rawRowsUsed: values.length,
        perParserUnits: units,
        worstResidualPerParserBytes: Math.max(...values.map((value) => value.residualPerParser)),
        worstRawSignedResidualBytes: Math.max(...values.map((value) => value.rawResidual)),
        minimumRawSignedResidualBytes: Math.min(...values.map((value) => value.rawResidual)),
        repetitions: values.map((value) => value.repetition).sort((a, b) => a - b),
      };
    });
    const points = [{ units: 0, residualBytes: 0 }, ...observations.map((item) => ({ units: item.perParserUnits, residualBytes: item.worstResidualPerParserBytes }))];
    const slope = maximumPositiveSecant(points);
    families.push({
      family, variant, source: 'M2 raw observations; independently recalculated', rawRowsUsed: observations.reduce((sum, item) => sum + item.rawRowsUsed, 0),
      maxIndependentSlopeBytesPerUnit: slope, chargeBytesPerUnit: CHARGE_BYTES, marginBytesPerUnit: CHARGE_BYTES - slope,
      result: slope <= CHARGE_BYTES ? 'PASS' : 'FAIL', observations,
    });
  }
  return families;
}

function independentTrun(rows, requiredCounts = [1, 10, 100, 1_000, 10_000, 50_000]) {
  const trunRows = rows.filter((row) => row.family === 'trun');
  if (trunRows.length === 0) return { comparisons: [], excludedCounts: [] };
  const counts = [...new Set(trunRows.map((row) => row.count))].filter((count) => count > 0).sort((a, b) => a - b);
  const excludedCounts = [];
  for (const count of requiredCounts) {
    const families = new Set(trunRows.filter((row) => row.count === count).map((row) => row.variant));
    if ([0, 1, 2, 3, 4].some((fields) => !families.has(`${fields}-optional-fields`))) {
      fail(`M2 trun same-sample control matrix is incomplete at required count=${count}.`);
    }
  }
  const observations = [];
  for (const count of counts) {
    const baseRows = trunRows.filter((row) => row.count === count && row.variant === '0-optional-fields');
    if (!baseRows.length) {
      excludedCounts.push({ count, reason: 'no same-sample zero-optional-field baseline; not paired in M2 raw corpus' });
      continue;
    }
    for (const target of trunRows.filter((row) => row.count === count && row.variant !== '0-optional-fields')) {
      const fields = Number(target.variant[0]);
      const base = baseRows.find((row) => row.repetition === target.repetition);
      if (!base || ![1, 2, 3, 4].includes(fields)) {
        if (requiredCounts.includes(count)) fail(`Missing paired trun control at count=${count}, variant=${target.variant}.`);
        excludedCounts.push({ count, variant: target.variant, repetition: target.repetition, reason: 'no matching same-repetition baseline' });
        continue;
      }
      if (target.guardUsage.declaredSamples !== base.guardUsage.declaredSamples
          || target.measurementBatchSize !== base.measurementBatchSize) fail(`Unequal trun sample count or batch at count=${count}, fields=${fields}.`);
      const targetUnits = target.guardUsage.auxiliaryUnits - target.controlGuardUsage.auxiliaryUnits;
      const baseUnits = base.guardUsage.auxiliaryUnits - base.controlGuardUsage.auxiliaryUnits;
      const perParserUnits = targetUnits - baseUnits;
      const units = perParserUnits * target.measurementBatchSize;
      if (!isSafeCount(perParserUnits) || perParserUnits === 0 || !isSafeCount(units)) fail(`Invalid trun guard delta at count=${count}, fields=${fields}.`);
      const targetHeap = target.retainedMemoryDeltaBytes.heapUsed - target.controlRetainedMemoryDeltaBytes.heapUsed;
      const baseHeap = base.retainedMemoryDeltaBytes.heapUsed - base.controlRetainedMemoryDeltaBytes.heapUsed;
      const targetMetadata = target.guardUsage.metadataBytes - target.controlGuardUsage.metadataBytes;
      const baseMetadata = base.guardUsage.metadataBytes - base.controlGuardUsage.metadataBytes;
      const rawResidual = targetHeap - baseHeap - (targetMetadata - baseMetadata);
      if (!Number.isSafeInteger(rawResidual)) fail('Trun residual exceeds safe integer precision.');
      const residual = Math.max(0, rawResidual);
      observations.push({
        count, optionalFields: fields, repetition: target.repetition, declaredSamples: target.guardUsage.declaredSamples,
        measurementBatchSize: target.measurementBatchSize, perParserUnits,
        auxiliaryUnits: units, rawSignedResidualBytes: rawResidual, residualBytes: residual,
        residualBytesPerParser: residual / target.measurementBatchSize,
        maxPositiveSlopeBytesPerUnit: residual / units,
      });
    }
  }
  const grouped = new Map();
  for (const row of observations) {
    const key = `${row.count}\0${row.optionalFields}`;
    const values = grouped.get(key) ?? [];
    values.push(row);
    grouped.set(key, values);
  }
  const comparisons = [...grouped.entries()].map(([key, values]) => {
    const [count, optionalFields] = key.split('\0').map(Number);
    const slope = Math.max(...values.map((item) => item.maxPositiveSlopeBytesPerUnit));
    return { count, optionalFields, rawRowsUsed: values.length, maxIndependentSlopeBytesPerUnit: slope, chargeBytesPerUnit: CHARGE_BYTES, marginBytesPerUnit: CHARGE_BYTES - slope, result: slope <= CHARGE_BYTES ? 'PASS' : 'FAIL', observations: values };
  });
  return { comparisons, excludedCounts };
}

export function recalculateRawEvidence(rows, { requiredTrunCounts } = {}) {
  validateRawRows(rows);
  const nonTrun = independentNonTrun(rows);
  const trunAudit = independentTrun(rows, requiredTrunCounts);
  const trun = trunAudit.comparisons;
  const all = [...nonTrun, ...trun.map((item) => ({ family: 'trun', variant: `${item.optionalFields}-optional-fields`, ...item }))];
  const worst = [...all].sort((a, b) => b.maxIndependentSlopeBytesPerUnit - a.maxIndependentSlopeBytesPerUnit)[0];
  return {
    schema: 1, round: 'B.89-R3.M3', sourceRound: 'B.89-R3.M2', rawObservationCount: rows.length,
    nonTrunFamilies: nonTrun, trunComparisons: trun, trunUnpairedCountsExcluded: trunAudit.excludedCounts,
    worstFamily: worst?.family ?? null, worstVariant: worst?.variant ?? null,
    worstSlope: worst?.maxIndependentSlopeBytesPerUnit ?? null,
    worstMargin: worst ? CHARGE_BYTES - worst.maxIndependentSlopeBytesPerUnit : null,
    chargeBytesPerUnit: CHARGE_BYTES,
    result: all.every((item) => item.result === 'PASS') ? 'PASS' : 'FAIL',
  };
}

function parseLiteralSet(source, name) {
  const match = source.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  if (!match) fail(`Could not read production ${name}.`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]);
}

function parseParents(source, name) {
  const match = source.match(new RegExp(`const ${name}:[^=]+ = Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`));
  if (!match) fail(`Could not read production ${name}.`);
  return Object.fromEntries([...match[1].matchAll(/([\w ]+): \[([^\]]*)\]/g)].map((item) => [item[1].trim(), [...item[2].matchAll(/'([^']+)'/g)].map((parent) => parent[1])]));
}

function surfaceAudit() {
  const source = readFileSync(GUARD, 'utf8');
  const registry = mp4box.BoxParser;
  const boxes = Object.keys(registry.box).sort();
  const sampleEntries = Object.keys(registry.sampleEntry).sort();
  const sampleGroups = Object.keys(registry.sampleGroupEntry).sort();
  const uuids = Object.keys(registry.uuid ?? {}).sort();
  const allowedSampleEntries = parseAllowedSampleEntries(source);
  const safeTypes = parseLiteralSet(source, 'SAFE_FIXED_OR_SIZE_BOUNDED_BOXES');
  const safeParents = parseParents(source, 'SAFE_LEAF_PARENTS');
  const supportedGroups = parseLiteralSet(source, 'SUPPORTED_SGPD_GROUP_TYPES');
  const containers = parseLiteralSet(source, 'SUPPORTED_CONTAINERS');
  const opaqueNestedParents = parseLiteralSet(source, 'OPAQUE_NESTED_BOX_PARENTS');
  const opaqueTopLevel = parseLiteralSet(source, 'OPAQUE_TOP_LEVEL_BOXES');
  const findings = [];
  if (boxes.length !== 199 || sampleEntries.length !== 54 || sampleGroups.length !== 18 || uuids.length !== 8) findings.push('Runtime parser registry counts differ from the M2 version contract.');
  if (allowedSampleEntries.join(',') !== 'avc1,mp4a') findings.push(`Production sample-entry gate differs: ${allowedSampleEntries.join(',')}.`);
  if (supportedGroups.join(',') !== 'roll') findings.push(`Production sample-group gate differs: ${supportedGroups.join(',')}.`);
  if (safeTypes.some((type) => !safeParents[type])) findings.push('A production safe leaf has no explicit parent rule.');
  const safeLeaves = [...safeTypes, 'free'].map((type) => {
    const parser = registry.box[type];
    if (typeof parser !== 'function') {
      findings.push(`Safe leaf ${type} has no runtime box parser.`);
      return { type, parents: safeParents[type] ?? [], parserClass: null, decision: 'FAIL' };
    }
    const parseSource = parser.prototype?.parse?.toString() ?? '';
    const countDrivenAllocation = /new\s+Array|Array\.from|for\s*\([^;]*;[^;]*(?:count|entry|num)/i.test(parseSource);
    const dynamicDispatch = /parseOneBox|BoxParser\.|sampleEntry|sampleGroupEntry/.test(parseSource);
    const lengthDrivenStringAllocation = /readCString|readString|TextDecoder/.test(parseSource);
    const physicalLengthRead = /readUint8Array\([^)]*(?:this\.size|size)|readString\([^)]*(?:this\.size|size)/.test(parseSource);
    const fixedReadOnly = !countDrivenAllocation && !dynamicDispatch && !physicalLengthRead && !lengthDrivenStringAllocation;
    const physicallyBounded = fixedReadOnly || type === 'free' || type === 'data';
    if (!physicallyBounded) findings.push(`Safe leaf ${type} could not be proven physically bounded from its parser.`);
    return {
      type, parents: type === 'free' ? ['top-level', ...opaqueNestedParents] : safeParents[type] ?? [], parserClass: parser.name,
      parserSourceSha256: createHash('sha256').update(parseSource).digest('hex'),
      countDrivenAllocation, lengthDrivenStringAllocation, dynamicRegistryDispatch: dynamicDispatch,
      physicalLengthRead, physicallyBounded,
      boundingBasis: type === 'free' ? 'box size is capped by maxMetadataBoxBytes and included in maxMetadataBytes'
        : type === 'data' ? 'raw allocation is derived from this.size and included in bounded metadata bytes'
          : fixedReadOnly ? 'parser reads a fixed number of scalar/array fields' : 'physical box-length review required',
      decision: physicallyBounded ? 'PASS' : 'FAIL',
    };
  });
  const hdlrParserSource = registry.box.hdlr?.prototype?.parse?.toString() ?? '';
  const handlerBoundaryGuard = hdlrGuardBoundary(source);
  const handlerBoundary = {
    type: 'hdlr',
    parents: safeParents.hdlr ?? ['mdia', 'meta'],
    parserClass: registry.box.hdlr?.name ?? null,
    parserSourceSha256: createHash('sha256').update(hdlrParserSource).digest('hex'),
    parserReadsPastDeclaredChild: hdlrParserReadsPastDeclaredChild(hdlrParserSource),
    productionGuard: handlerBoundaryGuard,
    decision: hdlrParserReadsPastDeclaredChild(hdlrParserSource) && handlerBoundaryGuard.bounded ? 'PASS' : 'FAIL',
    boundingBasis: 'MP4Box hdlr parser is unbounded to the child by itself; the pre-parser guard requires a NUL in [fixedEnd, child.end) and charges one auxiliary unit per 64 name bytes including the terminator.',
  };
  if (handlerBoundary.decision !== 'PASS') findings.push('The hdlr parser boundary is not contained by an explicit production guard check.');
  return {
    schema: 1, round: 'B.89-R3.M3', mp4box: currentMp4box(),
    registryCounts: { boxes: boxes.length, sampleEntries: sampleEntries.length, sampleGroupEntries: sampleGroups.length, uuidParsers: uuids.length },
    boxes, sampleEntries, sampleGroupEntries: sampleGroups, uuidTypes: uuids,
    productionGrammar: { supportedContainers: containers, safeFixedOrSizeBoundedBoxes: safeTypes, safeLeafParents: safeParents, specializedHandlerBoxes: ['hdlr'], opaqueFreeTopLevel: opaqueTopLevel, opaqueFreeNestedParents: opaqueNestedParents, supportedSampleEntries: [...new Set(allowedSampleEntries)].sort(), supportedSampleGroups: supportedGroups },
    unsupportedSampleEntries: sampleEntries.filter((type) => !allowedSampleEntries.includes(type)),
    unsupportedSampleGroups: sampleGroups.filter((type) => !supportedGroups.includes(type)),
    unknownTopLevelPolicy: 'recordOpaqueTopLevel accepts mdat and explicit free only; other top-level types throw unsupported-structure (source review; runtime structural matrix is separate).',
    wrongContextRuntimeMatrix: 'PENDING_FOCUSED_GUARD_TESTS',
    findings, safeLeaves, handlerBoundary,
    result: findings.length === 0 && safeLeaves.every((item) => item.decision === 'PASS') && handlerBoundary.decision === 'PASS' ? 'PASS' : 'FAIL',
  };
}

function provenance() {
  const report = readFileSync(path.join(M2, 'final-report.md'), 'utf8');
  const guardFile = path.relative(REPOSITORY_ROOT, GUARD).replaceAll(path.sep, '/');
  const lockFile = 'frontend/package-lock.json';
  const expectedGuardHash = expectedPostHash(report, guardFile);
  const expectedLockHash = expectedPostHash(report, lockFile);
  const runtime = currentMp4box();
  const evidenceFiles = ['auxiliary-probes.json', 'auxiliary-summary.json', 'mp4box-parser-surface.json', 'supported-box-inventory.json', 'surface-classification.json', 'mp4box-version-contract.json', 'resource-model-summary.json', 'resource-model-run/browser-results.json'];
  const artifacts = Object.fromEntries(evidenceFiles.map((name) => {
    const file = name === 'resource-model-run/browser-results.json' ? path.join(M2, name) : path.join(M2, name);
    return [name, json(file)];
  }));
  const hashes = {
    guard: sha256(GUARD), lockfile: sha256(path.join(FRONTEND_ROOT, 'package-lock.json')),
    packageJson: sha256(path.join(FRONTEND_ROOT, 'package.json')),
    protocol: sha256(path.join(FRONTEND_ROOT, 'src/app/features/drive/workers/stream-transmux-protocol.ts')),
    state: sha256(path.join(FRONTEND_ROOT, 'src/app/features/drive/workers/stream-transmux-state.ts')),
    calibration: sha256(path.join(FRONTEND_ROOT, 'tools/mp4-resource-calibration-lib.mjs')),
  };
  const checks = {
    guardHashMatchesM2Post: hashes.guard === expectedGuardHash,
    packageLockHashMatchesM2Post: hashes.lockfile === expectedLockHash,
    runtimeVersionMatchesExpected: runtime.version === EXPECTED_VERSION,
    runtimeEntryHashMatchesExpected: runtime.entrySha256 === EXPECTED_ENTRY_SHA256,
    mp4boxEntryHashMatchesM2: runtime.entrySha256 === EXPECTED_ENTRY_SHA256
      && artifacts['mp4box-parser-surface.json'].mp4box?.sha256 === runtime.entrySha256,
    artifactsHaveM2Round: evidenceFiles.slice(0, 7).every((name) => artifacts[name].round === 'B.89-R3.M2'),
    artifactMp4boxVersionsMatch: [artifacts['auxiliary-probes.json'].mp4box?.version, artifacts['auxiliary-summary.json'].mp4box?.version,
      artifacts['mp4box-parser-surface.json'].mp4box?.version, artifacts['mp4box-version-contract.json'].runtimeResolvedVersion,
      artifacts['resource-model-summary.json'].mp4box?.version].every((version) => version === EXPECTED_VERSION),
    versionContractVerified: artifacts['mp4box-version-contract.json'].verified === true,
    rawEvidenceSchemaValid: artifacts['auxiliary-probes.json'].schema === 1 && Array.isArray(artifacts['auxiliary-probes.json'].rawObservations),
    browserProfilesPresent: Array.isArray(artifacts['resource-model-run/browser-results.json']) && artifacts['resource-model-run/browser-results.json'].length === 3,
  };
  const m2RawEvidenceReusable = Object.values(checks).every((value) => value === true);
  return {
    schema: 1, round: 'B.89-R3.M3', m2Round: 'B.89-R3.M2',
    expectedM2PostHashes: { guard: expectedGuardHash, packageLock: expectedLockHash }, currentHashes: hashes,
    checks, mp4box: runtime, m2RawEvidenceReusable,
  };
}

function independentTrunFamiliesForPlan(rows) {
  return rows.filter((row) => row.family === 'trun');
}

function buildProbePlan(auxiliary) {
  const maxima = new Map(auxiliary.guardMaximums.map((row) => [`${row.family}::${row.variant}`, row.acceptedCount]));
  const plan = [];
  const add = (family, variant, counts, repetitions) => {
    for (const count of [...new Set(counts)].filter((item) => Number.isSafeInteger(item) && item > 0)) {
      for (let repetition = 1; repetition <= repetitions; repetition++) plan.push({ family, variant, count, repetition });
    }
  };
  const stscMax = maxima.get('stsc::entries');
  add('stsc', 'entries', [1, 1_000, 50_000, Math.floor(stscMax / 2), stscMax - 1, stscMax], 5);
  for (const family of ['ctts', 'co64', 'visited-box']) {
    const max = maxima.get(`${family}::${family === 'visited-box' ? 'btrt-objects' : 'entries'}`);
    const variant = family === 'visited-box' ? 'btrt-objects' : 'entries';
    add(family, variant, [1, 1_000, 50_000 <= max ? 50_000 : null, Math.floor(max / 2), max - 1, max], 3);
  }
  for (const variant of ['v0-roll-fixed', 'v1-roll-default-length-2', 'v1-roll-variable-length-2']) {
    const max = maxima.get(`sgpd::${variant}`);
    add('sgpd', variant, [1, Math.floor(max / 2), max], 3);
  }
  for (const fields of [0, 3, 4]) add('trun', `${fields}-optional-fields`, [1, 1_000, 50_000], 3);
  if (plan.length > MAX_NEW_ISOLATED_NODE_PROBES) fail(`Planned targeted jobs ${plan.length} exceed ${MAX_NEW_ISOLATED_NODE_PROBES}.`);
  return plan;
}

function runChild(job) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', PROBE, '--child', `${job.family}::${job.variant}`, String(job.count)], {
      cwd: FRONTEND_ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill(), 120_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`Probe ${job.family}/${job.variant}/${job.count} #${job.repetition} exited ${code ?? signal}: ${stderr.trim()}`));
      let row;
      try { row = JSON.parse(stdout); } catch { return reject(new Error(`Probe returned invalid JSON: ${job.family}/${job.variant}/${job.count} #${job.repetition}.`)); }
      const rows = [row];
      validateRawRows(rows.map((item) => ({ ...item, repetition: job.repetition })));
      if (row.family !== job.family || row.variant !== job.variant || row.count !== job.count) return reject(new Error('Probe result does not match its predeclared job.'));
      resolve({ ...row, repetition: job.repetition });
    });
  });
}

async function runTargetedProbes(auxiliary) {
  const plan = buildProbePlan(auxiliary);
  process.stdout.write(`planned targeted jobs: ${plan.length}\n`);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const rows = [];
  for (let index = 0; index < plan.length; index++) {
    const job = plan[index];
    const probeStart = performance.now();
    const row = await runChild(job);
    rows.push({ ...row, durationMs: Math.round(performance.now() - probeStart), source: 'fresh targeted probe' });
    process.stdout.write(`targeted probes ${index + 1}/${plan.length}\r`);
  }
  process.stdout.write('\n');
  const evidence = { schema: 1, round: 'B.89-R3.M3', source: 'fresh targeted probes', jobCount: rows.length,
    mp4box: currentMp4box(), selectionPolicy: 'stsc: six scale/boundary points x5; ctts/co64/visited-box: six points x3; three sgpd variants: three points x3; trun 0/3/4 fields at 1/1000/50000 x3; serial; no retries.', rows };
  writeJson(path.join(OUT, 'targeted-auxiliary-probes.json'), evidence);
  const summary = summarizeFreshProbes(rows);
  writeJson(path.join(OUT, 'targeted-auxiliary-summary.json'), summary);
  startedPhases.push({ name: 'targeted-fresh-probes', startedAt, finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start), status: summary.result });
  saveTimings();
  return summary;
}

function summarizeFreshProbes(rows) {
  const nonTrun = rows.filter((row) => row.family !== 'trun');
  const groups = new Map();
  for (const row of nonTrun) {
    const units = row.guardUsage.auxiliaryUnits - row.controlGuardUsage.auxiliaryUnits;
    const sampleDelta = row.guardUsage.declaredSamples - row.controlGuardUsage.declaredSamples;
    if (!isSafeCount(units) || sampleDelta !== 0) fail(`Fresh non-trun guard delta invalid for ${row.family}/${row.variant}/${row.count}.`);
    const residual = independentResidual(row);
    const key = `${row.family}\0${row.variant}\0${row.count}`;
    const list = groups.get(key) ?? [];
    list.push({ row, units, residualPerParser: residual.residual / row.measurementBatchSize, rawResidual: residual.rawResidual });
    groups.set(key, list);
  }
  const familyReports = new Map();
  for (const [key, group] of groups) {
    const [family, variant, countText] = key.split('\0');
    const units = group[0].units;
    if (group.length !== (family === 'stsc' ? 5 : 3) || group.some((item) => item.units !== units)) fail(`Fresh repetitions/units mismatch for ${family}/${variant}/${countText}.`);
    const familyKey = `${family}\0${variant}`;
    const points = familyReports.get(familyKey) ?? [];
    points.push({ count: Number(countText), units, residualBytes: Math.max(...group.map((item) => item.residualPerParser)), rawResidualBytes: Math.max(...group.map((item) => item.rawResidual)), repetitions: group.length });
    familyReports.set(familyKey, points);
  }
  const results = [...familyReports.entries()].map(([key, values]) => {
    const [family, variant] = key.split('\0');
    const maxSlope = maximumPositiveSecant([{ units: 0, residualBytes: 0 }, ...values.map((item) => ({ units: item.units, residualBytes: item.residualBytes }))]);
    return { family, variant, points: values.sort((a, b) => a.count - b.count), maxIndependentSlopeBytesPerUnit: maxSlope, marginBytesPerUnit: CHARGE_BYTES - maxSlope, result: maxSlope <= CHARGE_BYTES ? 'PASS' : 'FAIL' };
  });
  const trun = rows.filter((row) => row.family === 'trun');
  const trunComparisons = [];
  for (const count of [...new Set(trun.map((row) => row.count))]) {
    const baseline = trun.filter((row) => row.count === count && row.variant === '0-optional-fields');
    for (const target of trun.filter((row) => row.count === count && row.variant !== '0-optional-fields')) {
      const base = baseline.find((item) => item.repetition === target.repetition);
      if (!base || target.measurementBatchSize !== base.measurementBatchSize || target.guardUsage.declaredSamples !== base.guardUsage.declaredSamples) fail(`Fresh trun paired mismatch at ${count}/${target.variant}.`);
      const targetUnits = target.guardUsage.auxiliaryUnits - target.controlGuardUsage.auxiliaryUnits;
      const baseUnits = base.guardUsage.auxiliaryUnits - base.controlGuardUsage.auxiliaryUnits;
      const units = (targetUnits - baseUnits) * target.measurementBatchSize;
      const heap = (target.retainedMemoryDeltaBytes.heapUsed - target.controlRetainedMemoryDeltaBytes.heapUsed)
        - (base.retainedMemoryDeltaBytes.heapUsed - base.controlRetainedMemoryDeltaBytes.heapUsed);
      const metadata = (target.guardUsage.metadataBytes - target.controlGuardUsage.metadataBytes)
        - (base.guardUsage.metadataBytes - base.controlGuardUsage.metadataBytes);
      const raw = heap - metadata;
      if (!isSafeCount(units) || units === 0 || !Number.isSafeInteger(raw)) fail(`Fresh trun accounting invalid at ${count}/${target.variant}.`);
      trunComparisons.push({ count, optionalFields: Number(target.variant[0]), repetition: target.repetition, units, rawResidualBytes: raw, residualBytes: Math.max(0, raw), slopeBytesPerUnit: Math.max(0, raw) / units });
    }
  }
  const trunGroups = new Map();
  for (const row of trunComparisons) {
    const key = `${row.count}\0${row.optionalFields}`;
    const list = trunGroups.get(key) ?? [];
    list.push(row);
    trunGroups.set(key, list);
  }
  const trunResults = [...trunGroups.entries()].map(([key, values]) => {
    const [count, optionalFields] = key.split('\0').map(Number);
    const slope = Math.max(...values.map((item) => item.slopeBytesPerUnit));
    return { count, optionalFields, observations: values, maxIndependentSlopeBytesPerUnit: slope, marginBytesPerUnit: CHARGE_BYTES - slope, result: slope <= CHARGE_BYTES ? 'PASS' : 'FAIL' };
  });
  const all = [...results, ...trunResults];
  return { schema: 1, round: 'B.89-R3.M3', isolatedProbeCount: rows.length, nonTrunFamilies: results, trunComparisons: trunResults, worstStsc: results.find((item) => item.family === 'stsc') ?? null, chargeBytesPerUnit: CHARGE_BYTES, result: all.every((item) => item.result === 'PASS') ? 'PASS' : 'FAIL' };
}

export function co64Counterfactual(raw, independent) {
  const group = independent.nonTrunFamilies.find((item) => item.family === 'co64' && item.variant === 'entries');
  const byEntryCount = new Map();
  for (const row of raw.filter((item) => item.family === 'co64' && item.variant === 'entries')) {
    const entries = row.count - row.controlCount;
    const currentUnitsPerParser = row.guardUsage.auxiliaryUnits - row.controlGuardUsage.auxiliaryUnits;
    const batchUnits = row.units - row.controlUnits;
    if (!isSafeCount(entries) || !isSafeCount(currentUnitsPerParser) || !isSafeCount(batchUnits)
        || !isSafeCount(row.measurementBatchSize) || row.measurementBatchSize < 1
        || !isSafeCount(row.parsedCount) || !isSafeCount(row.controlParsedCount)
        || !isSafeCount(row.units) || !isSafeCount(row.controlUnits)) {
      fail('CO64 counterfactual has invalid counts, units, or batch size.');
    }
    if (currentUnitsPerParser !== entries * 7) fail('Unexpected current CO64 auxiliary-unit model.');
    if (batchUnits !== currentUnitsPerParser * row.measurementBatchSize
        || row.parsedCount !== row.count * row.measurementBatchSize
        || row.controlParsedCount !== row.controlCount * row.measurementBatchSize) {
      fail('CO64 parser batch totals do not match per-parser guard usage.');
    }
    if (entries === 0) continue;

    const oldUnitsPerParser = currentUnitsPerParser - entries;
    if (oldUnitsPerParser !== entries * 6 || oldUnitsPerParser <= 0) fail('Unexpected old CO64 counterfactual unit model.');
    const residualPerParser = independentResidual(row).residual / row.measurementBatchSize;
    const values = byEntryCount.get(entries) ?? [];
    values.push({
      count: entries,
      repetition: row.repetition,
      measurementBatchSize: row.measurementBatchSize,
      currentUnitsPerParser,
      oldUnitsPerParser,
      residualPerParserBytes: residualPerParser,
    });
    byEntryCount.set(entries, values);
  }
  const observations = [...byEntryCount.entries()].map(([count, values]) => ({
    count,
    rawRowsUsed: values.length,
    currentUnitsPerParser: values[0].currentUnitsPerParser,
    oldUnitsPerParser: values[0].oldUnitsPerParser,
    worstResidualPerParserBytes: Math.max(...values.map((value) => value.residualPerParserBytes)),
    batchSizes: [...new Set(values.map((value) => value.measurementBatchSize))].sort((a, b) => a - b),
  }));
  const points = [{ units: 0, residualBytes: 0 }, ...observations.map((item) => ({
    units: item.oldUnitsPerParser,
    residualBytes: item.worstResidualPerParserBytes,
  }))];
  const oldSlope = maximumPositiveSecant(points);
  const exceedsOldCharge = observations.some((item) => item.worstResidualPerParserBytes > item.oldUnitsPerParser * CHARGE_BYTES);
  return {
    currentSlopeBytesPerUnit: group?.maxIndependentSlopeBytesPerUnit ?? null,
    oldCounterfactualSlopeBytesPerUnit: oldSlope,
    oldChargeWouldFailRawOrSecant: oldSlope > CHARGE_BYTES || exceedsOldCharge,
    causalClaim: oldSlope > CHARGE_BYTES ? 'SUPPORTED_BY_INDEPENDENT_RAW_SECANT' : 'NOT_ESTABLISHED_AS_REQUIRED_BY_RAW_EVIDENCE',
    observations,
  };
}

function crossRuntimeReview() {
  const browser = json(path.join(M2, 'resource-model-run', 'browser-results.json'));
  const environment = json(path.join(M2, 'resource-model-run', 'environment.json'));
  const profiles = browser.map((row) => ({
    profile: row.caseId ?? 'unlabeled',
    browserVersion: row.browserVersion ?? null,
    mp4boxVersion: environment.mp4box?.version ?? null,
    measurementStatus: row.measurement?.status ?? null,
    method: row.measurement?.method ?? null,
    workerHeapBeforeBytes: row.measurement?.workerHeapBeforeBytes,
    workerHeapAfterParseBytes: row.measurement?.workerHeapAfterParseBytes,
    workerParserHeapDeltaBytes: row.measurement?.workerParserHeapDeltaBytes,
    workerHeapAfterReleaseBytes: row.measurement?.workerHeapAfterReleaseBytes,
    scopeLimitation: row.measurement?.scopeLimitation,
  }));
  const directHeapMeasurement = typeof performance.measureUserAgentSpecificMemory === 'function' ? 'AVAILABLE' : 'UNAVAILABLE';
  return {
    schema: 1, round: 'B.89-R3.M3', directHeapMeasurement,
    method: 'Existing M2 browser-worker corpus profiles re-reviewed; no Chromium heap run or privileged API was introduced by this Node process.',
    browserProfiles: profiles,
    contradictionObserved: profiles.some((item) => item.mp4boxVersion !== EXPECTED_VERSION || !Number.isFinite(item.workerParserHeapDeltaBytes) || item.workerParserHeapDeltaBytes < 0),
    limitation: 'Browser worker heap profiles corroborate tested browser parsing behavior but do not prove byte-identical Node/Chromium object layout or total browser/device memory bounds.',
  };
}

function saveBaseline(pre) {
  writeJson(path.join(OUT, 'baseline.json'), {
    schema: 1, round: 'B.89-R3.M3', capturedAt: new Date().toISOString(),
    git: { branch: 'frontend', head: '09ec464dd56ddbb55370ae2243ee89b5db85ee0', preExistingWorkingTree: true, preExistingFiles: [
      '.github/workflows/frontend-ci.yml', 'frontend/package-lock.json', 'frontend/package.json',
      'frontend/src/app/features/drive/workers/stream-transmux-resource-guard.ts',
      'frontend/src/app/features/drive/workers/stream-transmux-resource-guard.spec.ts',
      'frontend/src/app/features/drive/workers/stream-transmux-resource-guard.integration.spec.ts',
      'frontend/tools/mp4-resource-calibration-lib.mjs', 'frontend/tools/mp4-resource-calibration.mjs',
      'frontend/tools/mp4-resource-calibration.test.mjs', 'tools/quality/test_ci_native_portability.py',
      'frontend/tools/mp4-auxiliary-resource-probe.mjs', 'frontend/tools/mp4-auxiliary-resource-probe.test.mjs',
      'frontend/tools/mp4-parser-surface-inventory.mjs',
    ], diffCheck: 'PASS at task entry' }, preHashes: pre,
    m2Provenance: { guardHash: pre.guard, lockHash: pre.lock, mp4boxEntrySha256: pre.mp4boxEntry },
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const pre = {
    guard: 'b1d4d02dfff2c54898688ff3447d80d49a773053a3deef5fbebd73c01fe663e0',
    guardSpec: '6eda140c26fc597b4ae17da8a9e757e42a7a6d8c9f2a59e621097ea9ef0d515a',
    guardIntegrationSpec: '219cab2fd65c80a9067c3247148457fa050b93e6649018187d8316fe3edfb538',
    protocol: 'da2afe7332a22b11a23e68761d1291ab65d5bdc1a03b126213065885d3ea85f7',
    state: '8535a07011c9b680c96332af3a651166a3fc35ee5f0212b527b8ddf58d095326',
    probe: '0d6917212cb6e58b397203381749ec569148ae2f52963ba4a68436af6df231ba',
    probeTest: '57d9ab4dcec80dac9555d031d02f7b61dfc945dc286d3ce309ea95328c210e2c',
    inventory: '7d206a09098da255e7a692cba7dcebf5c402d4281f67800944f0383748860788',
    calibrationLib: '3b4e92385579a269bf43b091619d595b0d8a2bbc1ebbdff6250d91c1ca9b0db2',
    calibration: 'f6b25b8b0b9cda0de804bfa846a6c57b13005cf6d51d7b5d6c94d066bf471901',
    calibrationTest: '24bf5bd727185efcff94f6344570e4495152c5a7ffc0668c0cb012514d978bb3',
    packageJson: '107d0eacc04c0b46d38ddb7f64354863c0ba785b19fb95b8fc898432777e319c',
    lock: 'd0e9ed9e05491120e7109246b736c24ca91151e068c0333fd9662f2ac74a762e',
    ci: '3d193891b6e0d1410df1f0c49157bc28e8762388288c1a66b9bf91cf712a06f8',
    playwrightRunner: '60abd72229da1d65528f152c30f8463786bcdd037202f8ac6a30efa5a600b902',
    mp4boxEntry: EXPECTED_ENTRY_SHA256,
  };
  saveBaseline(pre);
  const provenanceResult = timed('provenance', provenance);
  writeJson(path.join(OUT, 'provenance.json'), provenanceResult);
  if (!provenanceResult.m2RawEvidenceReusable) fail('M2 provenance invalid; raw evidence cannot be reused. No probes were run.');
  const auxiliary = json(path.join(M2, 'auxiliary-probes.json'));
  validateRawRows(auxiliary.rawObservations);

  const independent = timed('independent-raw-recalculation', () => recalculateRawEvidence(auxiliary.rawObservations));
  independent.co64Counterfactual = co64Counterfactual(auxiliary.rawObservations, independent);
  writeJson(path.join(OUT, 'independent-auxiliary-recalculation.json'), independent);
  if (independent.result !== 'PASS' || independent.worstFamily !== 'stsc' || independent.worstSlope > CHARGE_BYTES) {
    writeJson(path.join(OUT, 'independent-ap01-audit.json'), { schema: 1, round: 'B.89-R3.M3', provenance: { m2Reusable: true }, auxiliary: { m2RawRecalculated: false, worstFamily: independent.worstFamily, worstSlopeBytesPerUnit: independent.worstSlope, charge: CHARGE_BYTES, findingCount: 1 }, decision: 'DO_NOT_RATIFY' });
    fail('Independent M2 raw recalculation failed or did not reproduce the expected worst-family result; stopped before fresh probes.');
  }

  const surface = timed('runtime-surface-and-safe-leaf-review', surfaceAudit);
  writeJson(path.join(OUT, 'independent-surface-audit.json'), surface);
  writeJson(path.join(OUT, 'safe-leaf-review.json'), { schema: 1, round: 'B.89-R3.M3', mp4boxVersion: EXPECTED_VERSION, leaves: surface.safeLeaves, handlerBoundary: surface.handlerBoundary });
  if (surface.result !== 'PASS') fail('Runtime parser surface or safe-leaf audit has a finding; stopped before heap probes.');

  const cross = timed('cross-runtime-evidence-review', crossRuntimeReview);
  writeJson(path.join(OUT, 'cross-runtime-review.json'), cross);
  if (cross.contradictionObserved) fail('M2 browser worker profiles contradict the current Node/runtime contract.');

  if (process.argv.includes('--preflight')) {
    writeJson(path.join(OUT, 'independent-ap01-audit.json'), {
      schema: 1, round: 'B.89-R3.M3', provenance: { m2Reusable: true },
      surface: { registryCounts: surface.registryCounts, findingCount: surface.findings.length + surface.safeLeaves.filter((item) => item.decision !== 'PASS').length + Number(surface.handlerBoundary.decision !== 'PASS') },
      auxiliary: { m2RawRecalculated: independent.result === 'PASS', freshProbeCount: 0, worstFamily: independent.worstFamily, worstSlopeBytesPerUnit: independent.worstSlope, charge: CHARGE_BYTES, findingCount: 0 },
      crossRuntime: { directHeapMeasurement: cross.directHeapMeasurement, contradictionObserved: cross.contradictionObserved },
      decision: 'PREFLIGHT_PASS_TARGETED_PROBES_PENDING',
    });
    process.stdout.write(`Preflight PASS: ${independent.rawObservationCount} raw rows; worst=${independent.worstFamily} ${independent.worstSlope} B/unit; surface=${surface.registryCounts.boxes}/${surface.registryCounts.sampleEntries}/${surface.registryCounts.sampleGroupEntries}; targeted probes pending.\n`);
    return;
  }

  const targeted = await runTargetedProbes(auxiliary);
  const freshPath = path.join(OUT, 'targeted-auxiliary-probes.json');
  const fresh = json(freshPath);
  const targetedStsc = targeted.worstStsc;
  const independentAudit = {
    schema: 1, round: 'B.89-R3.M3', provenance: { m2Reusable: true },
    surface: { registryCounts: surface.registryCounts, findingCount: surface.findings.length + surface.safeLeaves.filter((item) => item.decision !== 'PASS').length + Number(surface.handlerBoundary.decision !== 'PASS') },
    auxiliary: { m2RawRecalculated: true, freshProbeCount: fresh.jobCount, worstFamily: independent.worstFamily, worstSlopeBytesPerUnit: independent.worstSlope, charge: CHARGE_BYTES, freshStscWorstSlopeBytesPerUnit: targetedStsc?.maxIndependentSlopeBytesPerUnit ?? null, findingCount: targeted.result === 'PASS' ? 0 : 1 },
    crossRuntime: { directHeapMeasurement: cross.directHeapMeasurement, contradictionObserved: cross.contradictionObserved },
    decision: surface.findings.length === 0 && independent.result === 'PASS' && targeted.result === 'PASS' && !cross.contradictionObserved ? 'RATIFY_CANDIDATE' : 'DO_NOT_RATIFY',
  };
  writeJson(path.join(OUT, 'independent-ap01-audit.json'), independentAudit);
  process.stdout.write(`${JSON.stringify({ decision: independentAudit.decision, jobs: fresh.jobCount, worstM2: independent.worstSlope, worstStscFresh: targetedStsc?.maxIndependentSlopeBytesPerUnit, out: OUT }, null, 2)}\n`);
  if (independentAudit.decision !== 'RATIFY_CANDIDATE') process.exitCode = 1;
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT);
if (directRun) main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
