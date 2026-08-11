import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHeapSpaceStatistics } from 'node:v8';
import {
  assertExpectedMp4BoxVersion,
  FRONTEND_ROOT,
  REPOSITORY_ROOT,
  resolveMp4BoxVersion,
  writeJsonAtomic,
} from './mp4-resource-calibration-lib.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const OUTPUT = path.join(REPOSITORY_ROOT, '.quality', 'b89-r3m2-ap01', 'auxiliary-probes.json');
const SUMMARY_OUTPUT = path.join(REPOSITORY_ROOT, '.quality', 'b89-r3m2-ap01', 'auxiliary-summary.json');
const TABLE_COUNTS = [0, 1, 10, 100, 1_000, 10_000, 50_000];
const REPETITIONS = 3;
// Node reserves a large virtual heap per child; serialize to avoid Windows commit exhaustion.
const PROBE_CONCURRENCY = 1;
const BATCH_AUXILIARY_UNITS = 16_384;
const MAX_BATCH_PARSERS = 256;
const PROBE_TIMEOUT_MS = 120_000;
const CASES = [
  ...['stts', 'ctts', 'stsc', 'stco', 'co64', 'stss', 'sbgp', 'elst']
    .map((family) => ({ family, variant: 'entries', counts: TABLE_COUNTS })),
  { family: 'tfra', variant: 'entries', counts: TABLE_COUNTS.filter((count) => count > 0) },
  { family: 'sidx', variant: 'entries', counts: [1, 10, 100, 1_000, 10_000, 50_000, 65_535] },
  ...[
    { variant: 'v0-roll-fixed', version: 0, defaultLength: null, defaultIndex: null },
    { variant: 'v1-roll-default-length-2', version: 1, defaultLength: 2, defaultIndex: null },
    { variant: 'v1-roll-variable-length-2', version: 1, defaultLength: 0, defaultIndex: null },
  ].map((shape) => ({ family: 'sgpd', counts: TABLE_COUNTS, ...shape })),
  ...[0, 1, 2, 3, 4].map((fields) => ({ family: 'trun', variant: `${fields}-optional-fields`, fields, counts: TABLE_COUNTS })),
  ...['avc1', 'mp4a'].map((sampleType) => ({ family: 'stsd', variant: `${sampleType}-descriptions`, sampleType, counts: [1, 8, 32, 64] })),
  { family: 'ftyp', variant: 'compatible-brands', counts: [1, 8, 32, 64] },
  { family: 'styp', variant: 'compatible-brands', counts: [1, 8, 32, 64] },
  { family: 'avcC', variant: 'sps-only', counts: [1, 10, 31] },
  { family: 'avcC', variant: 'pps-only', counts: [1, 10, 100, 255] },
  { family: 'avcC', variant: 'mixed', counts: [1, 10, 100, 286] },
  { family: 'dref', variant: 'self-contained-url', counts: [0, 1] },
  { family: 'esds', variant: 'nested-descriptors', counts: [4, 6, 8] },
  ...['fr-FR', 'abcdefgh-12345678-abcdefgh-12345678-abcdefgh-12345678-12345678'].map((language) => ({
    family: 'elng', variant: `language-${language.length}-bytes`, language, counts: [0, 1, 8, 32, 64, 128],
  })),
  { family: 'visited-box', variant: 'btrt-objects', counts: TABLE_COUNTS.filter((count) => count > 0) },
];

const uint = (value, width = 4) => {
  const bytes = Buffer.alloc(width);
  width === 8 ? bytes.writeBigUInt64BE(BigInt(value)) : width === 2 ? bytes.writeUInt16BE(value) : bytes.writeUInt32BE(value);
  return bytes;
};
const full = (body, version = 0, flags = 0) => Buffer.concat([Buffer.from([version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]), body]);
const repeated = (count, factory) => Array.from({ length: count }, (_, index) => factory(index));
const repeatBytes = (count, width, write) => {
  const bytes = Buffer.alloc(count * width);
  for (let index = 0; index < count; index++) write(bytes, index * width, index);
  return bytes;
};
const repeatBuffer = (count, value) => {
  const bytes = Buffer.alloc(count * value.byteLength);
  for (let index = 0; index < count; index++) value.copy(bytes, index * value.byteLength);
  return bytes;
};

function descriptor(tag, body) {
  let size = body.byteLength;
  const encoded = [size & 0x7f];
  while ((size >>>= 7) > 0) encoded.unshift((size & 0x7f) | 0x80);
  return Buffer.concat([Buffer.from([tag, ...encoded]), body]);
}

function esdsPayload(count) {
  const sl = descriptor(6, Buffer.from([2]));
  const decoderSpecific = descriptor(5, Buffer.from([0x12, 0x10]));
  const decoderConfig = descriptor(4, Buffer.concat([
    Buffer.from([0x40, 0x15, 0, 0, 0]), uint(128_000), uint(128_000), decoderSpecific,
  ]));
  return full(descriptor(3, Buffer.concat([
    uint(1, 2), Buffer.from([0]), decoderConfig, sl,
    ...repeated(Math.max(0, count - 4), () => sl),
  ])));
}

function sgpdPayload(shape, count) {
  const body = [Buffer.from('roll')];
  if (shape.version >= 1) body.push(uint(shape.defaultLength));
  if (shape.version >= 2) body.push(uint(shape.defaultIndex));
  body.push(uint(count));
  const entryWidth = shape.defaultLength === 0 ? 6 : 2;
  body.push(repeatBytes(count, entryWidth, (bytes, offset) => {
    if (entryWidth === 6) bytes.writeUInt32BE(2, offset);
  }));
  return full(Buffer.concat(body), shape.version);
}

function avcCPayload(variant, count) {
  const spsCount = variant === 'pps-only' ? 0 : variant === 'sps-only' ? count : Math.min(count, 31);
  const ppsCount = variant === 'sps-only' ? 0 : variant === 'pps-only' ? count : count - spsCount;
  const parameterSet = (kind) => Buffer.from([0, 1, kind]);
  return Buffer.concat([
    Buffer.from([1, 66, 0, 30, 0xff, spsCount]),
    ...repeated(spsCount, () => parameterSet(0x67)),
    Buffer.from([ppsCount]),
    ...repeated(ppsCount, () => parameterSet(0x68)),
  ]);
}

function box(type, payload) {
  return Buffer.concat([uint(payload.byteLength + 8), Buffer.from(type, 'latin1'), payload]);
}

function payloadFor(plan, count) {
  switch (plan.family) {
    case 'stts':
    case 'ctts': return full(Buffer.concat([uint(count), repeatBytes(count, 8, (bytes, offset) => { bytes.writeUInt32BE(1, offset); bytes.writeUInt32BE(1, offset + 4); })]));
    case 'stsc': return full(Buffer.concat([uint(count), repeatBytes(count, 12, (bytes, offset, index) => { bytes.writeUInt32BE(index + 1, offset); bytes.writeUInt32BE(1, offset + 4); bytes.writeUInt32BE(1, offset + 8); })]));
    case 'stco': return full(Buffer.concat([uint(count), Buffer.alloc(count * 4)]));
    case 'co64': return full(Buffer.concat([uint(count), Buffer.alloc(count * 8)]));
    case 'stss': return full(Buffer.concat([uint(count), repeatBytes(count, 4, (bytes, offset, index) => bytes.writeUInt32BE(index + 1, offset))]));
    case 'sbgp': return full(Buffer.concat([Buffer.from('roll'), uint(count), repeatBytes(count, 8, (bytes, offset) => { bytes.writeUInt32BE(1, offset); bytes.writeUInt32BE(1, offset + 4); })]));
    case 'sgpd': return sgpdPayload(plan, count);
    case 'elst': return full(Buffer.concat([uint(count), repeatBytes(count, 12, (bytes, offset) => { bytes.writeUInt32BE(1, offset); bytes.writeUInt32BE(0x00010000, offset + 8); })]));
    case 'dref': return full(Buffer.concat([uint(count), ...repeated(count, () => box('url ', uint(1)))]));
    case 'tfra': return full(Buffer.concat([uint(1), Buffer.from([0, 0, 0, 0]), uint(count), repeatBytes(count, 11, (bytes, offset) => { bytes[offset + 8] = 1; bytes[offset + 9] = 1; bytes[offset + 10] = 1; })]));
    case 'sidx': return full(Buffer.concat([uint(1), uint(1), uint(0), uint(0), Buffer.alloc(2), Buffer.from([count >>> 8, count & 0xff]), repeatBytes(count, 12, () => {})]));
    case 'trun': return full(Buffer.concat([
      uint(count), Buffer.alloc(count * plan.fields * 4),
    ]), 0, ((1 << plan.fields) - 1) << 8);
    case 'ftyp':
    case 'styp': return Buffer.concat([Buffer.from('isom'), uint(0), repeatBytes(count, 4, (bytes, offset) => bytes.write('mp42', offset, 'ascii'))]);
    case 'stsd': {
      const fixedBytes = plan.sampleType === 'avc1' ? 78 : 28;
      return full(Buffer.concat([uint(count), ...repeated(count, () => box(plan.sampleType, Buffer.alloc(fixedBytes)))]));
    }
    case 'avcC': return avcCPayload(plan.variant, count);
    case 'esds': return esdsPayload(count);
    case 'elng': return full(Buffer.from(plan.language, 'ascii'));
    case 'visited-box': return Buffer.alloc(12);
    default: throw new Error(`Unknown MP4 auxiliary probe family ${plan.family}.`);
  }
}

function fullBoxBox(type, payload, version = 0, flags = 0) {
  return box(type, full(payload, version, flags));
}

function guardFixture(plan, count) {
  const tableFamilies = new Set(['stts', 'ctts', 'stsc', 'stco', 'co64', 'stss', 'sbgp', 'sgpd']);
  const sampleType = plan.family === 'stsd' ? plan.sampleType : plan.family === 'esds' ? 'mp4a' : 'avc1';
  const handler = sampleType === 'mp4a' ? 'soun' : 'vide';
  const fragmented = plan.family === 'trun';
  const trackCount = 1;
  const tracks = [];
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
    const id = trackIndex + 1;
    const language = plan.family === 'elng'
      ? repeatBuffer(count, fullBoxBox('elng', Buffer.from(plan.language, 'ascii')))
      : Buffer.alloc(0);
    const descriptions = plan.family === 'stsd' ? count : 1;
    const sampleEntryChildren = plan.family === 'avcC'
      ? box('avcC', payloadFor(plan, count))
      : plan.family === 'esds'
        ? box('esds', payloadFor(plan, count))
        : plan.family === 'visited-box'
          ? repeatBytes(count, 20, (bytes, offset) => { bytes.writeUInt32BE(20, offset); bytes.write('btrt', offset + 4, 'ascii'); })
          : Buffer.alloc(0);
    const sampleEntries = repeated(descriptions, () => box(sampleType, Buffer.concat([Buffer.alloc(sampleType === 'avc1' ? 78 : 28), sampleEntryChildren])));
    const stsd = plan.family === 'stsd'
      ? box('stsd', payloadFor(plan, count))
      : fullBoxBox('stsd', Buffer.concat([uint(1), sampleEntries[0]]));
    const stsz = fullBoxBox('stsz', Buffer.concat([uint(1), uint(fragmented ? 0 : 1)]));
    const stblBoxes = [stsd, stsz];
    if (tableFamilies.has(plan.family)) stblBoxes.push(box(plan.family, payloadFor(plan, count)));
    const minfBoxes = [fullBoxBox(handler === 'soun' ? 'smhd' : 'vmhd', Buffer.alloc(handler === 'soun' ? 4 : 8), 0, handler === 'soun' ? 0 : 1)];
    if (plan.family === 'dref' && count > 0) minfBoxes.push(box('dinf', box('dref', payloadFor(plan, count))));
    const minf = box('minf', Buffer.concat([...minfBoxes, box('stbl', Buffer.concat(stblBoxes))]));
    const hdlrPayload = Buffer.alloc(24);
    hdlrPayload.write(handler, 4, 'ascii');
    const mdia = box('mdia', Buffer.concat([fullBoxBox('hdlr', hdlrPayload), language, minf]));
    const tkhdPayload = Buffer.alloc(20);
    tkhdPayload.writeUInt32BE(id, 8);
    const trackBoxes = [fullBoxBox('tkhd', tkhdPayload)];
    if (plan.family === 'elst') trackBoxes.push(box('edts', box('elst', payloadFor(plan, count))));
    trackBoxes.push(mdia);
    tracks.push(box('trak', Buffer.concat(trackBoxes)));
  }
  const mvhd = fullBoxBox('mvhd', Buffer.alloc(100));
  const mvex = fragmented ? box('mvex', fullBoxBox('trex', Buffer.alloc(20))) : Buffer.alloc(0);
  const moov = box('moov', Buffer.concat([mvhd, ...tracks, mvex]));
  const ftyp = plan.family === 'ftyp' ? box('ftyp', payloadFor(plan, count)) : box('ftyp', Buffer.concat([Buffer.from('isom'), uint(0)]));
  const topLevel = [ftyp, moov];
  if (plan.family === 'styp') topLevel.push(box('styp', payloadFor(plan, count)));
  if (plan.family === 'sidx') topLevel.push(box('sidx', payloadFor(plan, count)));
  if (plan.family === 'tfra') topLevel.push(box('mfra', Buffer.concat([box('tfra', payloadFor(plan, count)), fullBoxBox('mfro', uint(0))])));
  if (fragmented) {
    const trun = box('trun', payloadFor(plan, count));
    const tfhd = fullBoxBox('tfhd', uint(1));
    topLevel.push(box('moof', Buffer.concat([fullBoxBox('mfhd', uint(1)), box('traf', Buffer.concat([tfhd, trun]))])));
  }
  return Buffer.concat(topLevel);
}

let productionGuardPromise;
function loadProductionGuard() {
  if (!productionGuardPromise) {
    productionGuardPromise = (async () => {
      const require = createRequire(path.join(FRONTEND_ROOT, 'package.json'));
      const ts = require('typescript');
      const sourcePath = path.join(FRONTEND_ROOT, 'src/app/features/drive/workers/stream-transmux-resource-guard.ts');
      const source = readFileSync(sourcePath, 'utf8');
      const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
      const code = Buffer.from(result.outputText).toString('base64');
      return import(`data:text/javascript;base64,${code}`);
    })();
  }
  return productionGuardPromise;
}

export async function inspectGuardFixture(plan, count) {
  const module = await loadProductionGuard();
  const fixture = guardFixture(plan, count);
  const input = fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength);
  return module.createMp4ResourceGuard().inspect(input, 0, { final: true });
}

function upperBoundFor(plan) {
  const metadataLimit = 8 * 1024 * 1024;
  if (plan.family === 'stsd') return 64;
  if (plan.family === 'ftyp' || plan.family === 'styp') return 64;
  if (plan.family === 'avcC') return plan.variant === 'sps-only' ? 31 : plan.variant === 'pps-only' ? 255 : 286;
  if (plan.family === 'dref') return 1;
  if (plan.family === 'esds') return 8;
  if (plan.family === 'elng') return 128;
  if (plan.family === 'visited-box') return 200_000;
  if (plan.family === 'sidx') return 65_535;
  if (plan.family === 'trun') return plan.fields === 0 ? 1_000_000 : Math.floor((metadataLimit - 32) / (plan.fields * 4));
  if (plan.family === 'tfra') return Math.floor((metadataLimit - 32) / 11);
  if (plan.family === 'sgpd') return Math.min(1_000_000, Math.floor((metadataLimit - 32) / (plan.defaultLength === 0 ? 6 : 2)));
  const widths = { stts: 8, ctts: 8, stsc: 12, stco: 4, co64: 8, stss: 4, sbgp: 8, elst: 12 };
  return Math.min(1_000_000, Math.floor((metadataLimit - 32) / widths[plan.family]));
}

function minimumCountFor(plan) {
  if (plan.family === 'stsd') return 1;
  if (plan.family === 'esds') return 4;
  return 0;
}

async function maximumGuardAcceptedCount(plan) {
  if (plan.family === 'avcC') {
    const acceptedCount = upperBoundFor(plan);
    const acceptedGuard = await inspectGuardFixture(plan, acceptedCount);
    const aboveGuard = await inspectGuardFixture(plan, acceptedCount + 1);
    if (acceptedGuard.decision !== 'append') throw new Error(`MP4Box field-width maximum rejected for ${plan.family}/${plan.variant}.`);
    return {
      acceptedCount,
      firstRejectedCount: aboveGuard.decision === 'reject' ? acceptedCount + 1 : null,
      boundaryKind: aboveGuard.decision === 'append' ? 'parser-field-width; following bytes are bounded avcC extension data' : 'guard-rejection',
      aboveLimitGuardDecision: aboveGuard.decision,
      aboveLimitGuardReason: aboveGuard.reason ?? null,
    };
  }
  let low = minimumCountFor(plan) - 1;
  let high = upperBoundFor(plan) + 1;
  let highResult = await inspectGuardFixture(plan, high);
  if (highResult.decision === 'append') {
    low = high;
    while (highResult.decision === 'append') {
      high *= 2;
      if (!Number.isSafeInteger(high)) throw new Error(`Cannot establish a safe rejected upper bound for ${plan.family}/${plan.variant}.`);
      highResult = await inspectGuardFixture(plan, high);
      if (highResult.decision === 'append') low = high;
    }
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const result = await inspectGuardFixture(plan, middle);
    if (result.decision === 'append') low = middle;
    else high = middle;
    globalThis.gc?.();
  }
  return { acceptedCount: low, firstRejectedCount: high, boundaryKind: 'guard-rejection', aboveLimitGuardDecision: 'reject' };
}

function streamFor(MP4Box, bytes) {
  const arrayBuffer = Buffer.isBuffer(bytes)
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    : bytes;
  const stream = new MP4Box.DataStream(arrayBuffer, 0, MP4Box.Endianness.BIG_ENDIAN);
  stream.getEndPosition = () => arrayBuffer.byteLength;
  return stream;
}

function countDescriptors(descriptorNode) {
  if (!descriptorNode || typeof descriptorNode !== 'object') return 0;
  let total = 1;
  for (const childDescriptor of descriptorNode.descs ?? []) total += countDescriptors(childDescriptor);
  return total;
}

function parserCount(plan, parser) {
  switch (plan.family) {
    case 'stts':
    case 'ctts': return parser.sample_counts.length;
    case 'stsc': return parser.first_chunk.length;
    case 'stco':
    case 'co64': return parser.chunk_offsets.length;
    case 'stss': return parser.sample_numbers.length;
    case 'sbgp': {
      if (parser.grouping_type !== 'roll' || parser.entries.some((entry) => entry.sample_count !== 1 || entry.group_description_index !== 1)) {
        throw new Error('sbgp probe did not materialize the requested roll entries.');
      }
      return parser.entries.length;
    }
    case 'sgpd': {
      if (parser.grouping_type !== 'roll' || parser.entries.some((entry) => entry.roll_distance !== 0)) {
        throw new Error('sgpd probe did not materialize only zero roll_distance entries.');
      }
      const defaultLength = plan.version === 1 ? plan.defaultLength : 0;
      if (parser.default_length !== defaultLength) throw new Error(`sgpd default_length ${parser.default_length} != ${defaultLength}.`);
      if (plan.version === 1 && parser.entries.some((entry) => entry.description_length !== 2)) {
        throw new Error('sgpd probe entry description lengths were not parsed as 2 bytes.');
      }
      return parser.entries.length;
    }
    case 'elst':
    case 'tfra': return parser.entries.length;
    case 'sidx': return parser.references.length;
    case 'trun': {
      const fields = [
        parser.sample_duration,
        parser.sample_size,
        parser.sample_flags,
        parser.sample_composition_time_offset,
      ];
      for (let index = 0; index < fields.length; index++) {
        const expected = index < plan.fields ? parser.sample_count : 0;
        if (fields[index].length !== expected) {
          throw new Error(`trun flag ${1 << (index + 8)} retained ${fields[index].length}; expected ${expected}.`);
        }
      }
      return parser.sample_count;
    }
    case 'ftyp':
    case 'styp': return parser.compatible_brands.length;
    case 'stsd': {
      if (parser.entries.some((entry) => entry.type !== plan.sampleType)) throw new Error(`stsd parser returned a non-${plan.sampleType} entry.`);
      return parser.entries.length;
    }
    case 'avcC': return parser.SPS.length + parser.PPS.length;
    case 'dref': {
      if (parser.entries.some((entry) => entry.type !== 'url ' || entry.flags !== 1)) throw new Error('dref did not parse a self-contained url entry.');
      return parser.entries.length;
    }
    case 'esds': return countDescriptors(parser.esd);
    case 'elng': return parser.extended_language === plan.language ? 1 : 0;
    case 'visited-box': {
      if (parser.bufferSizeDB !== 0 || parser.maxBitrate !== 0 || parser.avgBitrate !== 0) throw new Error('btrt parser fields did not match the zeroed fixture.');
      return 1;
    }
    default: throw new Error(`Missing parser verifier for ${plan.family}.`);
  }
}

function unitsForCount(plan, count) {
  switch (plan.family) {
    case 'trun': return count * plan.fields + (count > 0 ? plan.fields * 2 : 0);
    case 'stts': return count * 10;
    case 'ctts': return count * 8;
    case 'stsc': return count * 10;
    case 'stco': return count * 6;
    case 'co64': return count * 7;
    case 'stss': return count * 5;
    case 'sbgp': return count * 7;
    case 'elst': return count * 6;
    case 'tfra':
    case 'sidx': return count * 2;
    case 'avcC': return count * 6;
    case 'sgpd': return count * 11; // measured roll SampleGroupEntry retention plus the ordinary entry unit
    case 'stsd': return count * 20; // measured avc1/mp4a entry objects, each also visited
    case 'dref': return count * 10; // dref/dinf/url visits, reference entry, and empirically weighted parser retention
    case 'esds': return count * 8; // descriptor entry, parser node, and empirically weighted descriptor retention
    case 'elng': return count * 8; // parser instance/string plus one box-visit unit
    case 'visited-box': return count * 2;
    default: return count;
  }
}

export function measurementBatchSize(count, auxiliaryUnitsPerParserSet = count) {
  if (!Number.isSafeInteger(count) || count < 0
    || !Number.isSafeInteger(auxiliaryUnitsPerParserSet) || auxiliaryUnitsPerParserSet < 0) {
    throw new Error('Invalid auxiliary measurement count.');
  }
  return Math.max(1, Math.min(MAX_BATCH_PARSERS, Math.floor(BATCH_AUXILIARY_UNITS / Math.max(auxiliaryUnitsPerParserSet, 1))));
}

export function measurementBatchSizeForPlan(plan, count) {
  const sizingPlan = plan.family === 'trun' ? { ...plan, fields: 4 } : plan;
  const targetBatchSize = measurementBatchSize(count, unitsForCount(sizingPlan, count));
  const minimumBatchSize = count <= 64 ? 16 : count <= 50_000 ? 3 : 1;
  return Math.min(MAX_BATCH_PARSERS, Math.max(targetBatchSize, minimumBatchSize));
}

function parserUnits(plan, parser, count) {
  const units = unitsForCount(plan, count);
  if (plan.family === 'esds' && countDescriptors(parser.esd) !== count) {
    throw new Error(`esds materialized ${countDescriptors(parser.esd)} descriptors; expected ${count}.`);
  }
  return units;
}

function prepare(MP4Box, plan, count) {
  if (plan.family === 'visited-box' || plan.family === 'elng') {
    const payload = payloadFor(plan, Math.max(count, 1));
    const boxType = plan.family === 'elng' ? 'elng' : 'btrt';
    const Ctor = MP4Box.BoxParser.box[boxType];
    if (typeof Ctor !== 'function') throw new Error(`MP4Box 2.4.1 has no registered ${boxType} parser.`);
    const retained = new Array(count);
    const run = (batchSize = 1) => {
      const batch = new Array(count * batchSize);
      for (let index = 0; index < batch.length; index++) {
        const parser = new Ctor(payload.byteLength + 8);
        parser.hdr_size = 8;
        parser.start = 0;
        parser.parse(streamFor(MP4Box, payload));
        batch[index] = parser;
      }
      return batch;
    };
    const warmup = (batchSize = 1) => {
      for (let index = 0; index < batchSize * Math.min(count || 1, 128); index++) {
        const parser = new Ctor(payload.byteLength + 8);
        parser.hdr_size = 8;
        parser.start = 0;
        parser.parse(streamFor(MP4Box, payload));
      }
    };
    return {
      inputBytes: payload,
      run,
      warmup,
      count: (parsers) => parsers.reduce((sum, parser) => sum + parserCount(plan, parser), 0),
      units: (parsers) => parsers.reduce((sum, parser) => sum + parserUnits(plan, parser, 1), 0),
    };
  }

  const payload = payloadFor(plan, count);
  const Ctor = MP4Box.BoxParser.box[plan.family];
  if (typeof Ctor !== 'function') throw new Error(`MP4Box 2.4.1 has no registered ${plan.family} parser.`);
  const warmupCount = Math.min(count || 1, 1_000);
  const warmupPayload = payloadFor(plan, warmupCount);
  return {
    inputBytes: payload,
    run: (batchSize = 1) => {
      const batch = new Array(batchSize);
      for (let index = 0; index < batchSize; index++) {
        const parser = new Ctor(payload.byteLength + 8);
        parser.hdr_size = 8;
        parser.start = 0;
        parser.parse(streamFor(MP4Box, payload));
        batch[index] = parser;
      }
      return batch;
    },
    warmup: (batchSize = 1) => {
      for (let index = 0; index < batchSize; index++) {
        const warmParser = new Ctor(warmupPayload.byteLength + 8);
        warmParser.hdr_size = 8;
        warmParser.start = 0;
        warmParser.parse(streamFor(MP4Box, warmupPayload));
      }
    },
    count: (parsers) => parsers.reduce((sum, parser) => sum + parserCount(plan, parser), 0),
    units: (parsers) => parsers.reduce((sum, parser) => sum + parserUnits(plan, parser, count), 0),
  };
}

const collectGarbage = () => { for (let pass = 0; pass < 5; pass++) globalThis.gc(); };

export function snapshotV8HeapSpaces() {
  return Object.fromEntries(getHeapSpaceStatistics().map((space) => [space.space_name, {
    sizeBytes: space.space_size,
    usedBytes: space.space_used_size,
    availableBytes: space.space_available_size,
    physicalBytes: space.physical_space_size,
  }]));
}

export function diffV8HeapSpaces(before, after) {
  const fields = ['sizeBytes', 'usedBytes', 'availableBytes', 'physicalBytes'];
  return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].map((name) => [
    name,
    Object.fromEntries(fields.map((field) => [field, (after[name]?.[field] ?? 0) - (before[name]?.[field] ?? 0)])),
  ]));
}

async function child(plan, count, includeV8HeapSpaces = false) {
  if (typeof globalThis.gc !== 'function') throw new Error('Auxiliary probe child requires --expose-gc.');
  const require = createRequire(path.join(path.dirname(SCRIPT), '..', 'package.json'));
  const MP4Box = require('mp4box');
  const version = resolveMp4BoxVersion().version;
  assertExpectedMp4BoxVersion({ version });
  const guard = await inspectGuardFixture(plan, count);
  if (guard.decision !== 'append') throw new Error(`${plan.family}/${plan.variant} count=${count} rejected by production guard: ${guard.reason}.`);
  const controlCount = controlCountFor(plan);
  const batchSize = measurementBatchSizeForPlan(plan, count);
  const controlGuard = controlCount === count ? guard : await inspectGuardFixture(plan, controlCount);
  if (controlGuard.decision !== 'append') throw new Error(`${plan.family}/${plan.variant} control count=${controlCount} rejected by production guard.`);
  const guardAuxiliaryUnitsDelta = guard.usage.auxiliaryUnits - controlGuard.usage.auxiliaryUnits;
  const parserAuxiliaryUnitsDelta = unitsForCount(plan, count) - unitsForCount(plan, controlCount);
  const declaredSamplesDelta = guard.usage.declaredSamples - controlGuard.usage.declaredSamples;
  const expectedSamplesDelta = plan.family === 'trun' ? count - controlCount : 0;
  if (guardAuxiliaryUnitsDelta !== parserAuxiliaryUnitsDelta || declaredSamplesDelta !== expectedSamplesDelta) {
    throw new Error(`${plan.family}/${plan.variant} guard accounting mismatch: auxiliary=${guardAuxiliaryUnitsDelta}/${parserAuxiliaryUnitsDelta}, samples=${declaredSamplesDelta}/${expectedSamplesDelta}.`);
  }
  const measurePrepared = (prepared, expectedCount, retainedSlot) => {
    globalThis.__mp4AuxiliaryProbeInput = prepared.inputBytes;
    for (let repetition = 0; repetition < 3; repetition++) prepared.warmup(batchSize);
    collectGarbage();
    const v8HeapSpacesBefore = includeV8HeapSpaces ? snapshotV8HeapSpaces() : null;
    const before = process.memoryUsage();
    const retained = prepared.run(batchSize);
    globalThis.__mp4AuxiliaryProbeRetained[retainedSlot] = retained;
    collectGarbage();
    const after = process.memoryUsage();
    const v8HeapSpacesAfter = includeV8HeapSpaces ? snapshotV8HeapSpaces() : null;
    const parsedCount = prepared.count(retained);
    const units = prepared.units(retained);
    if (parsedCount !== expectedCount * batchSize) throw new Error(`${plan.family}/${plan.variant} parsed ${parsedCount} units; expected ${expectedCount * batchSize}.`);
    const memory = Object.fromEntries(MEMORY_FIELDS.map((key) => [key, after[key] - before[key]]));
    return {
      parsedCount, units, inputBytes: prepared.inputBytes.byteLength,
      retainedHeapUsedBytes: Math.max(0, memory.heapUsed), retainedMemoryDeltaBytes: memory,
      ...(includeV8HeapSpaces ? {
        v8HeapSpacesBefore,
        v8HeapSpacesAfter,
        v8HeapSpacesDelta: diffV8HeapSpaces(v8HeapSpacesBefore, v8HeapSpacesAfter),
      } : {}),
    };
  };
  globalThis.__mp4AuxiliaryProbeRetained = [null, null];
  let controlPrepared = prepare(MP4Box, plan, controlCount);
  const controlMeasurement = measurePrepared(controlPrepared, controlCount, 0);
  collectGarbage();
  const targetMeasurement = count === controlCount
    ? controlMeasurement
    : measurePrepared(prepare(MP4Box, plan, count), count, 1);
  process.stdout.write(`${JSON.stringify({
    schema: 1, family: plan.family, variant: plan.variant, count, measurementBatchSize: batchSize, units: targetMeasurement.units, version,
    parsedCount: targetMeasurement.parsedCount, parserVerified: true,
    controlCount, controlUnits: controlMeasurement.units, controlParsedCount: controlMeasurement.parsedCount,
    controlParserVerified: true, controlRetainedHeapUsedBytes: controlMeasurement.retainedHeapUsedBytes,
    controlRetainedMemoryDeltaBytes: controlMeasurement.retainedMemoryDeltaBytes,
    guardAccepted: true, guardUsage: guard.usage, controlGuardUsage: controlGuard.usage,
    inputBytes: targetMeasurement.inputBytes, retainedHeapUsedBytes: targetMeasurement.retainedHeapUsedBytes,
    retainedMemoryDeltaBytes: targetMeasurement.retainedMemoryDeltaBytes,
    ...(includeV8HeapSpaces ? {
      controlV8HeapSpacesBefore: controlMeasurement.v8HeapSpacesBefore,
      controlV8HeapSpacesAfter: controlMeasurement.v8HeapSpacesAfter,
      controlV8HeapSpacesDelta: controlMeasurement.v8HeapSpacesDelta,
      v8HeapSpacesBefore: targetMeasurement.v8HeapSpacesBefore,
      v8HeapSpacesAfter: targetMeasurement.v8HeapSpacesAfter,
      v8HeapSpacesDelta: targetMeasurement.v8HeapSpacesDelta,
    } : {}),
  })}\n`);
}

const MEMORY_FIELDS = ['heapUsed', 'heapTotal', 'arrayBuffers', 'external', 'rss'];
const GUARD_USAGE_FIELDS = ['declaredSamples', 'auxiliaryUnits', 'metadataBytes', 'visitedBoxes', 'estimatedBytes'];

function validGuardUsage(usage) {
  return Boolean(usage)
    && GUARD_USAGE_FIELDS.every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
    && ['classic', 'fragmented', 'unknown'].includes(usage.mode);
}

export function verifyParserCount(actual, expected, label = 'parser') {
  if (!Number.isSafeInteger(expected) || expected < 0 || !Number.isSafeInteger(actual) || actual !== expected) {
    throw new Error(`${label} materialized ${actual}; expected ${expected}.`);
  }
}

export function observedAuxiliaryResidual(heapDelta, metadataDelta) {
  if (!Number.isSafeInteger(heapDelta) || !Number.isSafeInteger(metadataDelta)) throw new Error('Unsafe heap or metadata delta.');
  const residual = heapDelta - metadataDelta;
  if (!Number.isSafeInteger(residual)) throw new Error('Unsafe auxiliary residual.');
  return Math.max(0, residual);
}

export function pairedAuxiliaryResidual(targetHeapDelta, controlHeapDelta, metadataDelta) {
  if (![targetHeapDelta, controlHeapDelta, metadataDelta].every(Number.isSafeInteger)) throw new Error('Unsafe paired auxiliary measurement.');
  const residual = targetHeapDelta - controlHeapDelta - metadataDelta;
  if (!Number.isSafeInteger(residual)) throw new Error('Unsafe paired auxiliary residual.');
  return residual;
}

export function maxPositiveSecantSlope(points) {
  if (!Array.isArray(points) || points.length < 2) throw new Error('At least two auxiliary measurements are required.');
  const ordered = [...points].sort((left, right) => left.units - right.units);
  const seenUnits = new Set();
  for (const point of ordered) {
    if (!Number.isSafeInteger(point.units) || point.units < 0
      || !Number.isFinite(point.residualBytes) || point.residualBytes < 0 || point.residualBytes > Number.MAX_SAFE_INTEGER) {
      throw new Error('Unsafe auxiliary measurement point.');
    }
    if (seenUnits.has(point.units)) throw new Error('Duplicate auxiliary unit count.');
    seenUnits.add(point.units);
  }
  let maximum = 0;
  for (let left = 0; left < ordered.length; left++) {
    for (let right = left + 1; right < ordered.length; right++) {
      const units = ordered[right].units - ordered[left].units;
      const bytes = ordered[right].residualBytes - ordered[left].residualBytes;
      if (!Number.isSafeInteger(units) || !Number.isFinite(bytes) || Math.abs(bytes) > Number.MAX_SAFE_INTEGER) {
        throw new Error('Unsafe auxiliary secant delta.');
      }
      maximum = Math.max(maximum, bytes / units);
    }
  }
  return maximum;
}

export function parseAuxiliaryProbeChild(stdout, status, { plan, count, expectedVersion = '2.4.1', stderr = '' }) {
  if (status !== 0) throw new Error(`Probe child failed for ${plan.family}/${plan.variant} count=${count}: ${String(stderr || stdout).trim()}`);
  let row;
  try { row = JSON.parse(stdout); } catch { throw new Error(`Probe child emitted incomplete JSON for ${plan.family}/${plan.variant}.`); }
  if (!row || row.schema !== 1 || row.family !== plan.family || row.variant !== plan.variant || row.count !== count) {
    throw new Error(`Probe child returned inconsistent identity for ${plan.family}/${plan.variant} count=${count}.`);
  }
  if (row.version !== expectedVersion) throw new Error(`Probe MP4Box version mismatch: ${row.version}; expected ${expectedVersion}.`);
  const expectedBatchSize = measurementBatchSizeForPlan(plan, count);
  if (row.measurementBatchSize !== expectedBatchSize) throw new Error(`Probe batch size mismatch: ${row.measurementBatchSize}; expected ${expectedBatchSize}.`);
  verifyParserCount(row.parsedCount, count * expectedBatchSize, `${plan.family}/${plan.variant}`);
  if (row.parserVerified !== true || row.guardAccepted !== true || !validGuardUsage(row.guardUsage)
    || !validGuardUsage(row.controlGuardUsage)
    || row.units !== unitsForCount(plan, count) * expectedBatchSize
    || !Number.isSafeInteger(row.inputBytes) || row.inputBytes < 0) {
    throw new Error(`Probe child returned incomplete parser or unit evidence for ${plan.family}/${plan.variant}.`);
  }
  if (!row.retainedMemoryDeltaBytes || MEMORY_FIELDS.some((key) => !Number.isFinite(row.retainedMemoryDeltaBytes[key]))) {
    throw new Error(`Probe emitted a non-finite or incomplete memory measurement for ${plan.family}/${plan.variant}.`);
  }
  if (!Number.isSafeInteger(row.retainedHeapUsedBytes) || row.retainedHeapUsedBytes < 0) {
    throw new Error(`Probe emitted an invalid normalized retained-heap measurement for ${plan.family}/${plan.variant}.`);
  }
  const expectedControlCount = controlCountFor(plan);
  if (row.controlCount !== expectedControlCount || row.controlUnits !== unitsForCount(plan, expectedControlCount) * expectedBatchSize
    || row.controlParserVerified !== true) {
    throw new Error(`Probe child returned incomplete paired-control evidence for ${plan.family}/${plan.variant}.`);
  }
  verifyParserCount(row.controlParsedCount, expectedControlCount * expectedBatchSize, `${plan.family}/${plan.variant} control`);
  if (!row.controlRetainedMemoryDeltaBytes
    || MEMORY_FIELDS.some((key) => !Number.isFinite(row.controlRetainedMemoryDeltaBytes[key]))) {
    throw new Error(`Probe emitted a non-finite or incomplete paired-control measurement for ${plan.family}/${plan.variant}.`);
  }
  if (!Number.isSafeInteger(row.controlRetainedHeapUsedBytes) || row.controlRetainedHeapUsedBytes < 0) {
    throw new Error(`Probe emitted an invalid normalized paired-control heap measurement for ${plan.family}/${plan.variant}.`);
  }
  return row;
}

export function validateAuxiliaryProbeRows(rows, plans, repetitions = REPETITIONS, expectedVersion = '2.4.1') {
  if (!Array.isArray(rows) || !Array.isArray(plans) || !Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error('Invalid auxiliary probe evidence set.');
  const byKey = new Map();
  const allowedGroups = new Set(plans.map((plan) => `${plan.family}\0${plan.variant}`));
  for (const row of rows) {
    if (!row || row.version !== expectedVersion || row.parserVerified !== true || row.guardAccepted !== true
      || !validGuardUsage(row.guardUsage) || !validGuardUsage(row.controlGuardUsage)) {
      throw new Error('Missing exact-version parser or production-guard verification.');
    }
    const plan = plans.find((candidate) => candidate.family === row.family && candidate.variant === row.variant);
    if (!Number.isSafeInteger(row.count) || row.count < 0) throw new Error('Negative or unsafe probe count/units/bytes.');
    const expectedControlCount = plan ? controlCountFor(plan) : -1;
    const expectedBatchSize = plan ? measurementBatchSizeForPlan(plan, row.count) : -1;
    if (row.measurementBatchSize !== expectedBatchSize
      || row.controlCount !== expectedControlCount
      || row.controlUnits !== (plan ? unitsForCount(plan, expectedControlCount) * expectedBatchSize : -1)
      || row.controlParserVerified !== true || row.controlParsedCount !== expectedControlCount * expectedBatchSize
      || row.parsedCount !== row.count * expectedBatchSize
      || row.units !== (plan ? unitsForCount(plan, row.count) * expectedBatchSize : -1)) {
      throw new Error('Missing or inconsistent paired auxiliary control evidence.');
    }
    if (!allowedGroups.has(`${row.family}\0${row.variant}`)) throw new Error('Unexpected auxiliary probe family or variant.');
    if (!Number.isSafeInteger(row.units) || row.units < 0
      || !Number.isSafeInteger(row.inputBytes) || row.inputBytes < 0) throw new Error('Negative or unsafe probe count/units/bytes.');
    if (!Number.isSafeInteger(row.repetition) || row.repetition < 1 || row.repetition > repetitions) throw new Error('Invalid probe repetition.');
    if (MEMORY_FIELDS.some((key) => !Number.isFinite(row.retainedMemoryDeltaBytes?.[key]))) throw new Error('Non-finite or incomplete memory observation.');
    if (MEMORY_FIELDS.some((key) => !Number.isFinite(row.controlRetainedMemoryDeltaBytes?.[key]))) throw new Error('Non-finite or incomplete paired-control memory observation.');
    if (!Number.isSafeInteger(row.retainedHeapUsedBytes) || row.retainedHeapUsedBytes < 0
      || !Number.isSafeInteger(row.controlRetainedHeapUsedBytes) || row.controlRetainedHeapUsedBytes < 0) {
      throw new Error('Invalid normalized retained-heap observation.');
    }
    const key = `${row.family}\0${row.variant}\0${row.count}\0${row.repetition}`;
    if (byKey.has(key)) throw new Error(`Duplicate auxiliary datapoint ${row.family}/${row.variant}/${row.count}/${row.repetition}.`);
    byKey.set(key, row);
  }
  for (const plan of plans) {
    for (const count of plan.counts) {
      for (let repetition = 1; repetition <= repetitions; repetition++) {
        if (!byKey.has(`${plan.family}\0${plan.variant}\0${count}\0${repetition}`)) {
          throw new Error(`Missing auxiliary control/datapoint ${plan.family}/${plan.variant}/${count}/${repetition}.`);
        }
      }
    }
  }
  return true;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(rows, maximums) {
  return CASES.map((plan) => {
    const familyRows = rows.filter((row) => row.family === plan.family && row.variant === plan.variant);
    const controlCount = controlCountFor(plan);
    const controls = familyRows.filter((row) => row.count === controlCount).sort((left, right) => left.repetition - right.repetition);
    const control = Object.fromEntries(MEMORY_FIELDS.map((key) => [
      key, median(controls.map((row) => row.retainedMemoryDeltaBytes[key])),
    ]));
    const maximum = maximums.find((item) => item.family === plan.family && item.variant === plan.variant);
    const counts = [...new Set([...plan.counts, ...(maximum ? [maximum.acceptedCount] : [])])];
    if (plan.family === 'trun') {
      return {
        family: plan.family,
        variant: plan.variant,
        sampleCountControl: controlCount,
        comparison: 'Cross-variant comparison against trun with zero optional per-sample fields at identical sample_count; do not interpret count-vs-zero as auxiliary-only because declared sample count changes.',
        repetitions: REPETITIONS,
        maxGuardAcceptedCount: maximum?.acceptedCount ?? null,
        firstRejectedCount: maximum?.firstRejectedCount ?? null,
        observations: counts.filter((count) => count !== controlCount).map((count) => {
          const samples = familyRows.filter((row) => row.count === count).sort((left, right) => left.repetition - right.repetition);
          return {
            count,
            repetitions: samples.length,
            auxiliaryUnits: median(samples.map((row) => row.units)),
            declaredSamples: median(samples.map((row) => row.guardUsage.declaredSamples)),
            metadataBytes: median(samples.map((row) => row.guardUsage.metadataBytes)),
            metrics: Object.fromEntries(MEMORY_FIELDS.map((key) => {
              const values = samples.map((row) => row.retainedMemoryDeltaBytes[key]);
              return [key, { min: Math.min(...values), median: median(values), max: Math.max(...values), range: Math.max(...values) - Math.min(...values) }];
            })),
          };
        }),
      };
    }
    const observations = counts.filter((count) => count !== controlCount).map((count) => {
      const samples = familyRows.filter((row) => row.count === count).sort((left, right) => left.repetition - right.repetition);
      const metrics = Object.fromEntries(MEMORY_FIELDS.map((key) => {
        const values = samples.map((row) => row.retainedMemoryDeltaBytes[key]);
        return [key, { min: Math.min(...values), median: median(values), max: Math.max(...values), range: Math.max(...values) - Math.min(...values) }];
      }));
      const perRowUnits = samples.map((row) => row.units - row.controlUnits);
      const perParserUnits = samples.map((row, index) => perRowUnits[index] / row.measurementBatchSize);
      if (new Set(perRowUnits).size !== 1 || new Set(perParserUnits).size !== 1) {
        throw new Error(`Inconsistent paired auxiliary units for ${plan.family}/${plan.variant} count=${count}.`);
      }
      const unitsDelta = perRowUnits[0];
      const perParserUnitsDelta = perParserUnits[0];
      const residualByRepetition = samples.map((row) => ({
        targetRepetition: row.repetition,
        controlRepetition: row.repetition,
        rawResidualBytes: pairedAuxiliaryResidual(
          row.retainedMemoryDeltaBytes.heapUsed,
          row.controlRetainedMemoryDeltaBytes.heapUsed,
          row.guardUsage.metadataBytes - row.controlGuardUsage.metadataBytes,
        ),
        residualBytes: observedAuxiliaryResidual(
          row.retainedMemoryDeltaBytes.heapUsed - row.controlRetainedMemoryDeltaBytes.heapUsed,
          row.guardUsage.metadataBytes - row.controlGuardUsage.metadataBytes,
        ),
        residualBytesPerParser: observedAuxiliaryResidual(
          row.retainedMemoryDeltaBytes.heapUsed - row.controlRetainedMemoryDeltaBytes.heapUsed,
          row.guardUsage.metadataBytes - row.controlGuardUsage.metadataBytes,
        ) / row.measurementBatchSize,
        auxiliaryUnits: row.units - row.controlUnits,
        perParserAuxiliaryUnitsDelta: (row.units - row.controlUnits) / row.measurementBatchSize,
        guardAuxiliaryUnitsDelta: (row.guardUsage.auxiliaryUnits - row.controlGuardUsage.auxiliaryUnits) * row.measurementBatchSize,
        declaredSamplesDelta: row.guardUsage.declaredSamples - row.controlGuardUsage.declaredSamples,
      }));
      for (const item of residualByRepetition) {
        if (item.auxiliaryUnits !== item.guardAuxiliaryUnitsDelta || item.declaredSamplesDelta !== 0
          || item.perParserAuxiliaryUnitsDelta !== perParserUnitsDelta) {
          throw new Error(`Probe accounting differs from production guard for ${plan.family}/${plan.variant} count=${count}.`);
        }
      }
      return {
        count,
        repetitions: samples.length,
        metadataDeltaBytes: median(samples.map((row) => row.guardUsage.metadataBytes - row.controlGuardUsage.metadataBytes)),
        auxiliaryUnitsDelta: unitsDelta,
        perParserAuxiliaryUnitsDelta: perParserUnitsDelta,
        maxObservedAuxiliaryResidualBytes: Math.max(...residualByRepetition.map((item) => item.residualBytes)),
        maxObservedAuxiliaryResidualBytesPerParser: Math.max(...residualByRepetition.map((item) => item.residualBytesPerParser)),
        measurementStatus: residualByRepetition.some((item) => item.rawResidualBytes > 0) ? 'MEASURED' : 'INCONCLUSIVE',
        maxControlSecantBytesPerUnit: unitsDelta > 0 ? Math.max(...residualByRepetition.map((item) => item.residualBytes / unitsDelta)) : null,
        passes64ByteCharge: residualByRepetition.some((item) => item.rawResidualBytes > 0)
          && residualByRepetition.every((item) => item.residualBytes <= 64 * item.auxiliaryUnits),
        residualByRepetition,
        metrics,
      };
    });
    const slopePoints = [
      { units: 0, residualBytes: 0 },
      ...observations.map((observation) => ({
        units: observation.perParserAuxiliaryUnitsDelta,
        residualBytes: observation.maxObservedAuxiliaryResidualBytesPerParser,
      })),
    ];
    return {
      family: plan.family,
      variant: plan.variant,
      controlCount,
      repetitions: REPETITIONS,
      maxGuardAcceptedCount: maximum?.acceptedCount ?? null,
      firstRejectedCount: maximum?.firstRejectedCount ?? null,
      maxTestedCount: Math.max(...counts),
      controlMedianBytes: control,
      observations,
      maxPairwisePositiveSlopeBytesPerUnit: maxPositiveSecantSlope(slopePoints),
    };
  });
}

function summarizeTrunComparisons(rows) {
  const variants = CASES.filter((plan) => plan.family === 'trun');
  const counts = [...new Set(variants.flatMap((plan) => plan.counts))].sort((left, right) => left - right).filter((count) => count > 0);
  return counts.map((count) => {
    const byFields = variants.map((plan) => ({
      fields: plan.fields,
      rows: rows.filter((row) => row.family === 'trun' && row.variant === plan.variant && row.count === count)
        .sort((left, right) => left.repetition - right.repetition),
    }));
    const baseline = byFields.find((item) => item.fields === 0);
    const comparisons = byFields.filter((item) => item.fields > 0).map((item) => {
      const residuals = item.rows.flatMap((row) => baseline.rows.map((base) => {
        if (!base || row.guardUsage.declaredSamples !== base.guardUsage.declaredSamples) {
          throw new Error(`trun sample-count control mismatch at sample_count=${count}, fields=${item.fields}.`);
        }
        const rowUnits = row.units - row.controlUnits;
        const baseUnits = base.units - base.controlUnits;
        const auxiliaryUnitsDelta = rowUnits - baseUnits;
        if (row.measurementBatchSize !== base.measurementBatchSize) {
          throw new Error(`trun measurement-batch mismatch at sample_count=${count}, fields=${item.fields}.`);
        }
        const batchSize = row.measurementBatchSize;
        const expectedUnitsDelta = (count * item.fields + (count > 0 ? item.fields * 2 : 0)) * batchSize;
        if (auxiliaryUnitsDelta !== ((row.guardUsage.auxiliaryUnits - row.controlGuardUsage.auxiliaryUnits)
          - (base.guardUsage.auxiliaryUnits - base.controlGuardUsage.auxiliaryUnits)) * batchSize
          || auxiliaryUnitsDelta !== expectedUnitsDelta) {
          throw new Error(`trun auxiliary accounting mismatch at sample_count=${count}, fields=${item.fields}.`);
        }
        const rowMetadataDelta = row.guardUsage.metadataBytes - row.controlGuardUsage.metadataBytes;
        const baseMetadataDelta = base.guardUsage.metadataBytes - base.controlGuardUsage.metadataBytes;
        return {
          targetRepetition: row.repetition,
          controlRepetition: base.repetition,
          metadataDeltaBytes: rowMetadataDelta - baseMetadataDelta,
          auxiliaryUnitsDelta,
          rawResidualBytes: pairedAuxiliaryResidual(
            row.retainedMemoryDeltaBytes.heapUsed - row.controlRetainedMemoryDeltaBytes.heapUsed,
            base.retainedMemoryDeltaBytes.heapUsed - base.controlRetainedMemoryDeltaBytes.heapUsed,
            rowMetadataDelta - baseMetadataDelta,
          ),
          residualBytes: observedAuxiliaryResidual(
            (row.retainedMemoryDeltaBytes.heapUsed - row.controlRetainedMemoryDeltaBytes.heapUsed)
              - (base.retainedMemoryDeltaBytes.heapUsed - base.controlRetainedMemoryDeltaBytes.heapUsed),
            rowMetadataDelta - baseMetadataDelta,
          ),
          residualBytesPerParser: observedAuxiliaryResidual(
            (row.retainedMemoryDeltaBytes.heapUsed - row.controlRetainedMemoryDeltaBytes.heapUsed)
              - (base.retainedMemoryDeltaBytes.heapUsed - base.controlRetainedMemoryDeltaBytes.heapUsed),
            rowMetadataDelta - baseMetadataDelta,
          ) / row.measurementBatchSize,
          measurementBatchSize: row.measurementBatchSize,
        };
      }));
      return {
        optionalFields: item.fields,
        repetitions: residuals.length,
        maxObservedAuxiliaryResidualBytes: Math.max(...residuals.map((entry) => entry.residualBytes)),
        maxObservedAuxiliaryResidualBytesPerParser: Math.max(...residuals.map((entry) => entry.residualBytesPerParser)),
        measurementStatus: residuals.some((entry) => entry.rawResidualBytes > 0) ? 'MEASURED' : 'INCONCLUSIVE',
        maxPositiveSlopeBytesPerUnit: Math.max(...residuals.map((entry) => entry.residualBytes / entry.auxiliaryUnitsDelta)),
        passes64ByteCharge: residuals.some((entry) => entry.rawResidualBytes > 0)
          && residuals.every((entry) => entry.residualBytes <= 64 * entry.auxiliaryUnitsDelta),
        residuals,
      };
    });
    const secantPoints = [
      { units: 0, residualBytes: 0 },
      ...comparisons.map((comparison) => ({
        units: count * comparison.optionalFields + 2 * comparison.optionalFields,
        residualBytes: comparison.maxObservedAuxiliaryResidualBytesPerParser,
      })),
    ];
    return {
      sampleCount: count,
      baselineOptionalFields: 0,
      maxPairwisePositiveSlopeBytesPerUnit: maxPositiveSecantSlope(secantPoints),
      comparisons,
    };
  });
}

function runChild(plan, count, repetition) {
  return new Promise((resolve, reject) => {
    const args = ['--expose-gc', SCRIPT, '--child', `${plan.family}::${plan.variant}`, String(count)];
    const childProcess = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      childProcess.kill();
      finish(new Error(`Probe timed out for ${plan.family}/${plan.variant} count=${count} after ${PROBE_TIMEOUT_MS} ms.`));
    }, PROBE_TIMEOUT_MS);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    childProcess.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    childProcess.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    childProcess.once('error', (error) => finish(error));
    childProcess.once('close', (status) => {
      try {
        finish(null, { ...parseAuxiliaryProbeChild(stdout, status, { plan, count, stderr }), repetition });
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function runJobs(jobs, concurrency = PROBE_CONCURRENCY, onProgress = () => {}) {
  const results = new Array(jobs.length);
  let nextJob = 0;
  let completed = 0;
  let failure = null;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (true) {
      if (failure) return;
      const index = nextJob++;
      if (index >= jobs.length) return;
      const job = jobs[index];
      try {
        results[index] = await runChild(job.plan, job.count, job.repetition);
        onProgress(++completed, jobs.length, job);
      } catch (error) {
        failure = error;
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return results;
}

function controlCountFor(plan) {
  return plan.family === 'esds' ? 4
    : ['stsd', 'ftyp', 'styp', 'avcC', 'sidx', 'tfra', 'visited-box'].includes(plan.family) ? 1
      : 0;
}

async function runParent() {
  const mp4box = assertExpectedMp4BoxVersion();
  const mp4boxEntry = path.resolve(FRONTEND_ROOT, mp4box.entry);
  const mp4boxEntrySha256 = createHash('sha256').update(readFileSync(mp4boxEntry)).digest('hex');
  const jobs = [];
  for (const plan of CASES) {
    for (const count of plan.counts) {
      for (let repetition = 1; repetition <= REPETITIONS; repetition++) jobs.push({ plan, count, repetition });
    }
  }
  process.stdout.write(`${jobs.length} isolated parser datapoints queued; concurrency=${PROBE_CONCURRENCY}.\n`);
  const rows = await runJobs(jobs, PROBE_CONCURRENCY, (completed, total) => {
    if (completed % 25 === 0 || completed === total) process.stdout.write(`Parser probes ${completed}/${total}\n`);
  });
  const maximums = [];
  for (const plan of CASES) {
    const boundary = await maximumGuardAcceptedCount(plan);
    const { acceptedCount, firstRejectedCount } = boundary;
    const acceptedGuard = await inspectGuardFixture(plan, acceptedCount);
    const rejectedGuard = firstRejectedCount === null ? null : await inspectGuardFixture(plan, firstRejectedCount);
    if (acceptedGuard.decision !== 'append' || (rejectedGuard && rejectedGuard.decision !== 'reject')) {
      throw new Error(`Guard/parser boundary search was not conclusive for ${plan.family}/${plan.variant}.`);
    }
    const result = {
      family: plan.family, variant: plan.variant, acceptedCount, firstRejectedCount,
      boundaryKind: boundary.boundaryKind, aboveLimitGuardDecision: boundary.aboveLimitGuardDecision,
      aboveLimitGuardReason: boundary.aboveLimitGuardReason ?? null,
      acceptedUsage: acceptedGuard.usage, rejectedReason: rejectedGuard?.reason ?? null,
    };
    maximums.push(result);
    if (!plan.counts.includes(acceptedCount)) {
      const measurements = await runJobs(Array.from({ length: REPETITIONS }, (_, index) => ({ plan, count: acceptedCount, repetition: index + 1 })), 1);
      rows.push(...measurements);
    }
    process.stdout.write(`Guard/parser maximum ${plan.family}/${plan.variant}: ${acceptedCount}; next=${firstRejectedCount ?? 'opaque bounded extension'} (${rejectedGuard?.reason ?? boundary.aboveLimitGuardDecision})\n`);
  }
  const evidencePlans = CASES.map((plan) => {
    const maximum = maximums.find((item) => item.family === plan.family && item.variant === plan.variant);
    return { ...plan, counts: [...new Set([...plan.counts, maximum.acceptedCount])] };
  });
  validateAuxiliaryProbeRows(rows, evidencePlans);
  const summaries = summarize(rows, maximums);
  const trunComparisons = summarizeTrunComparisons(rows);
  const resourceModelPassed = summaries.filter((family) => family.family !== 'trun')
    .every((family) => family.observations.every((observation) => observation.passes64ByteCharge))
    && trunComparisons.every((point) => point.comparisons.every((comparison) => comparison.passes64ByteCharge));
  const measurementStatus = resourceModelPassed ? 'PASS'
    : summaries.some((family) => family.observations.some((observation) => observation.measurementStatus === 'INCONCLUSIVE'))
      || trunComparisons.some((point) => point.comparisons.some((comparison) => comparison.measurementStatus === 'INCONCLUSIVE'))
      ? 'INCONCLUSIVE' : 'FAIL';
  const method = 'Each datapoint is one isolated Node process. Deterministic parser batches are capped at 256 instances and sized to target at most 16,384 modeled auxiliary units; trun variants at the same sample count share the batch size derived from the four-field shape. Repeated parser instances share the same immutable input buffer. Control and target inputs are prepared before measurement; each parser instance is warmed three times, then measured after five explicit full-GC cycles. The control parser batch remains strongly reachable while the target batch is measured against its post-control heap baseline, followed by five full-GC cycles. Three independent processes are used per standard and maximum-accepted point. The matrix is serial to avoid Windows commit pressure. Raw signed deltas are retained; no measurement is selectively retried.';
  const evidence = {
    schema: 1,
    round: 'B.89-R3.M2',
    command: 'npm run quality:mp4-resource:aux',
    environment: { node: process.version, platform: process.platform, arch: process.arch, cwd: 'frontend' },
    mp4box: { version: mp4box.version, entry: mp4box.entry, entrySha256: mp4boxEntrySha256 },
    method,
    limitations: ['This isolates MP4Box 2.4.1 parser constructors, not native decoder, GPU, browser, or end-to-end player memory.', 'The production guard acceptance decision is recorded separately; measurements do not imply that an unsupported structure is allowed.'],
    expectedVersion: '2.4.1',
    repetitions: REPETITIONS,
    rawObservations: rows,
    guardMaximums: maximums,
    families: summaries,
    trunSameSampleCountComparisons: trunComparisons,
    auxiliary64ByteChargeStatus: measurementStatus,
  };
  writeJsonAtomic(OUTPUT, evidence);
  writeJsonAtomic(SUMMARY_OUTPUT, {
    schema: 1, round: evidence.round, command: evidence.command, environment: evidence.environment,
    mp4box: evidence.mp4box, repetitions: REPETITIONS, chargedBytesPerAuxiliaryUnit: 64,
    safetyFactor: 1.1, method, result: measurementStatus,
    families: summaries, trunSameSampleCountComparisons: trunComparisons,
  });
  const passedFamilies = summaries.filter((family) => family.family !== 'trun'
    && family.observations.every((observation) => observation.passes64ByteCharge)).length;
  const trunPasses = trunComparisons.reduce((sum, point) => sum + point.comparisons.filter((comparison) => comparison.passes64ByteCharge).length, 0);
  const trunTotal = trunComparisons.reduce((sum, point) => sum + point.comparisons.length, 0);
  process.stdout.write(`${OUTPUT}\n${SUMMARY_OUTPUT}\n${rows.length} isolated parser observations recorded; non-trun family pass=${passedFamilies}/${summaries.length - 5}, trun comparisons=${trunPasses}/${trunTotal}, overall=${measurementStatus}.\n`);
  if (!resourceModelPassed) process.exitCode = 1;
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT);
if (directRun && process.argv[2] === '--child') {
  const [family, variant] = process.argv[3].split('::');
  const plan = CASES.find((candidate) => candidate.family === family && candidate.variant === variant);
  if (!plan) throw new Error(`Unknown auxiliary probe case ${process.argv[3]}.`);
  child(plan, Number(process.argv[4]), process.argv.includes('--m4-v8-spaces'))
    .catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
} else if (directRun) runParent().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
