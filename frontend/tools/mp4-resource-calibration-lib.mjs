import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FRONTEND_ROOT = path.resolve(TOOL_DIR, '..');
export const REPOSITORY_ROOT = path.resolve(FRONTEND_ROOT, '..');
export const OUTPUT_ROOT = path.join(REPOSITORY_ROOT, '.quality', 'mp4-resource-calibration');
export const FIXTURE_ROOT = path.join(OUTPUT_ROOT, 'fixtures');
export const KASUMI_CHUNK_SIZE = 4 * 1024 * 1024;
export const EXPECTED_MP4BOX_VERSION = '2.4.1';

const caseOf = (id, mode, moov, fps, videoFrames, options = {}) => ({
  id,
  mode,
  moov,
  fps,
  videoFrames,
  audioTracks: options.audioTracks ?? 0,
  candidate: options.candidate ?? false,
  multipleCandidates: options.multipleCandidates ?? false,
});

export const CALIBRATION_CASES = Object.freeze([
  caseOf('classic-faststart-v30-10k', 'classic', 'head', 30, 10_000),
  caseOf('classic-faststart-v30-50k', 'classic', 'head', 30, 50_000, { candidate: true, multipleCandidates: true }),
  caseOf('classic-faststart-v30-100k', 'classic', 'head', 30, 100_000, { candidate: true, multipleCandidates: true }),
  caseOf('classic-faststart-v30-200k', 'classic', 'head', 30, 200_000, { candidate: true, multipleCandidates: true }),
  caseOf('classic-tail-v30-10k', 'classic', 'tail', 30, 10_000),
  caseOf('classic-tail-v30-50k', 'classic', 'tail', 30, 50_000, { candidate: true }),
  caseOf('classic-faststart-v24-10k', 'classic', 'head', 24, 10_000),
  caseOf('classic-faststart-v60-50k', 'classic', 'head', 60, 50_000),
  caseOf('classic-av-v30-10k', 'classic', 'head', 30, 10_000, { audioTracks: 1 }),
  caseOf('classic-av-v30-50k', 'classic', 'head', 30, 50_000, { audioTracks: 1, candidate: true, multipleCandidates: true }),
  caseOf('classic-multitrack-v30-10k', 'classic', 'head', 30, 10_000, { audioTracks: 2 }),
  caseOf('fragmented-v30-10k', 'fragmented', 'fragmented', 30, 10_000),
  caseOf('fragmented-v30-50k', 'fragmented', 'fragmented', 30, 50_000, { candidate: true, multipleCandidates: true }),
  caseOf('fragmented-v30-100k', 'fragmented', 'fragmented', 30, 100_000, { candidate: true, multipleCandidates: true }),
  caseOf('fragmented-av-v30-10k', 'fragmented', 'fragmented', 30, 10_000, { audioTracks: 1 }),
  caseOf('fragmented-av-v30-50k', 'fragmented', 'fragmented', 30, 50_000, { audioTracks: 1, candidate: true, multipleCandidates: true }),
]);

export function validateManifest(cases) {
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('Manifest must contain cases.');
  const ids = new Set();
  for (const item of cases) {
    if (!item || !/^[a-z0-9-]+$/.test(item.id)) throw new Error('Invalid fixture ID.');
    if (ids.has(item.id)) throw new Error(`Duplicate fixture ID: ${item.id}`);
    ids.add(item.id);
    if (!['classic', 'fragmented'].includes(item.mode)) throw new Error(`Invalid mode for ${item.id}.`);
    if (!['head', 'tail', 'fragmented'].includes(item.moov)) throw new Error(`Invalid moov placement for ${item.id}.`);
    if ((item.mode === 'fragmented') !== (item.moov === 'fragmented')) throw new Error(`Mode/moov mismatch for ${item.id}.`);
    if (!Number.isFinite(item.fps) || item.fps <= 0) throw new Error(`Invalid fps for ${item.id}.`);
    if (!Number.isSafeInteger(item.videoFrames) || item.videoFrames <= 0 || item.videoFrames > 200_000) {
      throw new Error(`Invalid or over-budget frame count for ${item.id}.`);
    }
    if (!Number.isInteger(item.audioTracks) || item.audioTracks < 0 || item.audioTracks > 2) {
      throw new Error(`Invalid audio track count for ${item.id}.`);
    }
  }
  return cases;
}

export function buildManifest(cases = CALIBRATION_CASES) {
  validateManifest(cases);
  return {
    schema: 1,
    fixture: {
      width: 64,
      height: 64,
      videoCodec: 'libx264',
      audioCodec: 'aac',
      audioSampleRate: 48_000,
      audioLayout: ['stereo', 'mono'],
      fragmentKeyframeIntervalSeconds: 20,
      kasumiInputChunkBytes: KASUMI_CHUNK_SIZE,
    },
    cases: cases.map((item) => ({ ...item, filename: `${item.id}.mp4` })),
  };
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('median requires a non-empty list of finite numbers.');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarize(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('Cannot summarize no values.');
  return { min: Math.min(...values), median: median(values), max: Math.max(...values) };
}

export function linearFit(points) {
  if (!Array.isArray(points) || points.length < 2) throw new Error('linearFit requires at least two points.');
  if (points.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))) {
    throw new Error('linearFit requires finite coordinates.');
  }
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  let totalSquares = 0;
  for (const { x, y } of points) {
    numerator += (x - meanX) * (y - meanY);
    denominator += (x - meanX) ** 2;
    totalSquares += (y - meanY) ** 2;
  }
  if (denominator === 0) throw new Error('linearFit requires distinct x values.');
  const slope = numerator / denominator;
  const intercept = meanY - slope * meanX;
  const residuals = points.map(({ x, y }) => y - (slope * x + intercept));
  const residualSquares = residuals.reduce((sum, residual) => sum + residual ** 2, 0);
  return {
    slopeBytesPerSample: slope,
    interceptBytes: intercept,
    rSquared: totalSquares === 0 ? 1 : 1 - residualSquares / totalSquares,
    maxAbsoluteResidualBytes: Math.max(...residuals.map(Math.abs)),
  };
}

const MP4_CONTAINER_PARENTS = Object.freeze({
  trak: 'moov', mdia: 'trak', minf: 'mdia', stbl: 'minf', traf: 'moof',
  mvex: 'moov', edts: 'trak', dinf: 'minf', udta: 'moov', meta: 'udta', ilst: 'meta',
});
const MP4_SAFE_LEAF_PARENTS = Object.freeze({
  mvhd: ['moov'], tkhd: ['trak'], mdhd: ['mdia'], hdlr: ['mdia', 'meta'],
  vmhd: ['minf'], smhd: ['minf'], mfhd: ['moof'], tfhd: ['traf'], tfdt: ['traf'],
  trex: ['mvex'], mfro: ['mfra'], btrt: ['avc1', 'mp4a'], pasp: ['avc1'], data: ['©too'],
});
const MP4_OPAQUE_NESTED_BOX_PARENTS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts', 'dinf',
  'udta', 'meta', 'ilst', 'avc1', 'mp4a',
]);
const MP4_AUXILIARY_TABLE_TYPES = new Map([
  ['stts', 8], ['ctts', 8], ['stsc', 12], ['stco', 4], ['co64', 8], ['stss', 4],
]);
const MP4_AUXILIARY_TABLE_EXTRA_UNITS_PER_ENTRY = new Map([
  ['stts', 9], ['ctts', 7], ['stsc', 9], ['stco', 5], ['co64', 6], ['stss', 4],
]);
const MP4_SUPPORTED_SGPD_GROUP_TYPES = new Set(['roll']);
const MP4_SUPPORTED_ILST_ITEMS = new Set(['©too']);
const MP4_MAX_FILE_BRANDS = 64;
const MP4_MAX_ESDS_DESCRIPTORS = 8;
const MP4_AUXILIARY_UNITS_PER_VISITED_BOX = 2;
const MP4_ESDS_EXTRA_UNITS_PER_DESCRIPTOR = 5;
const MP4_SBGP_EXTRA_UNITS_PER_ENTRY = 6;
const MP4_ELST_EXTRA_UNITS_PER_ENTRY = 5;
const MP4_TFRA_EXTRA_UNITS_PER_ENTRY = 1;
const MP4_SIDX_EXTRA_UNITS_PER_REFERENCE = 1;
const MP4_AVCC_EXTRA_UNITS_PER_PARAMETER_SET = 5;
const MP4_DREF_EXTRA_UNITS_PER_ENTRY = 3;
const MP4_TRUN_EXTRA_UNITS_PER_FIELD_ARRAY = 2;
const MP4_SGPD_EXTRA_UNITS_PER_ENTRY = 10;
const MP4_STSD_EXTRA_UNITS_PER_ENTRY = 17;
const MP4_ELNG_EXTRA_UNITS_PER_BOX = 6;
const MP4_MAX_EXTENDED_LANGUAGE_BYTES = 63;

function checkedAdd(left, right, label) {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Unsafe MP4 resource ${label}.`);
  return value;
}

function checkedMultiply(left, right, label) {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Unsafe MP4 resource ${label}.`);
  return value;
}

function readBoxHeader(view, offset, parentEnd) {
  if (offset < 0 || parentEnd - offset < 8) throw new Error('Truncated MP4 box header.');
  const shortSize = view.getUint32(offset);
  const type = String.fromCharCode(view.getUint8(offset + 4), view.getUint8(offset + 5), view.getUint8(offset + 6), view.getUint8(offset + 7));
  let headerBytes = 8;
  let size = shortSize;
  if (shortSize === 1) {
    if (parentEnd - offset < 16) throw new Error('Truncated extended MP4 box header.');
    const extended = view.getBigUint64(offset + 8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('MP4 extended box size exceeds safe integer range.');
    size = Number(extended);
    headerBytes = 16;
  } else if (shortSize === 0) {
    size = parentEnd - offset;
  }
  if (size < headerBytes || size > parentEnd - offset) throw new Error(`Invalid MP4 box bounds for ${type}.`);
  return { type, offset, size, headerBytes, end: offset + size };
}

function fullBoxVersionAndFlags(view, box) {
  if (box.size < box.headerBytes + 4) throw new Error(`Truncated full box ${box.type}.`);
  const full = view.getUint32(box.offset + box.headerBytes);
  return { version: full >>> 24, flags: full & 0x00ff_ffff };
}

function readDeclaredCount(view, box, countOffset, itemBytes, fixedBytes) {
  const minimumEnd = box.offset + fixedBytes;
  if (minimumEnd > box.end) throw new Error(`Truncated ${box.type} count.`);
  const count = view.getUint32(countOffset);
  const entriesBytes = checkedMultiply(count, itemBytes, `${box.type} entry bytes`);
  if (fixedBytes + entriesBytes !== box.size) throw new Error(`Inconsistent ${box.type} entry length.`);
  return count;
}

/**
 * Bounded structural preflight for the metadata boxes that MP4Box expands into
 * sample/index structures. It skips mdat payloads and never allocates by any
 * declared sample or table-entry count.
 */
export function scanMp4ResourceMetadata(input, {
  maxVisitedBoxes = 200_000,
  maxTableEntries = 1_000_000,
  maxMetadataBytes = 64 * 1024 * 1024,
  maxSampleDescriptions = 64,
  maxDepth = 16,
  maxTracks = 128,
} = {}) {
  if (!(input instanceof Uint8Array)) throw new TypeError('MP4 preflight input must be bytes.');
  if (!Number.isSafeInteger(maxVisitedBoxes) || maxVisitedBoxes < 1 ||
      !Number.isSafeInteger(maxTableEntries) || maxTableEntries < 1 ||
      !Number.isSafeInteger(maxMetadataBytes) || maxMetadataBytes < 1 ||
      !Number.isSafeInteger(maxSampleDescriptions) || maxSampleDescriptions < 1 ||
      !Number.isSafeInteger(maxDepth) || maxDepth < 1 ||
      !Number.isSafeInteger(maxTracks) || maxTracks < 1) throw new Error('Invalid MP4 preflight limits.');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const tracks = [];
  const fragments = [];
  const topLevel = [];
  const uncharacterized = [];
  let visitedBoxes = 0;
  let moovCount = 0;
  let moofCount = 0;
  let metadataBytes = 0;
  let auxiliaryEntryCount = 0;
  let additionalAuxiliaryUnits = 0;
  const auxiliaryEntryCountsByType = {};
  let perSampleFieldUnits = 0;

  const addReason = (reason) => { if (!uncharacterized.includes(reason)) uncharacterized.push(reason); };
  const addAuxiliaryEntries = (type, count) => {
    auxiliaryEntryCount = checkedAdd(auxiliaryEntryCount, count, 'auxiliary table entries');
    auxiliaryEntryCountsByType[type] = checkedAdd(auxiliaryEntryCountsByType[type] ?? 0, count, `${type} entries`);
  };
  const scanAvcConfiguration = (box) => {
    let cursor = box.offset + box.headerBytes;
    if (cursor + 7 > box.end) throw new Error('Truncated avcC configuration record.');
    const spsCount = view.getUint8(cursor + 5) & 0x1f;
    let count = spsCount;
    cursor += 6;
    for (let index = 0; index < spsCount; index++) {
      if (cursor + 2 > box.end) throw new Error('Truncated avcC SPS length.');
      const length = view.getUint16(cursor);
      cursor += 2 + length;
      if (cursor > box.end) throw new Error('Invalid avcC SPS bounds.');
    }
    if (cursor >= box.end) throw new Error('Missing avcC PPS count.');
    const ppsCount = view.getUint8(cursor++);
    count = checkedAdd(count, ppsCount, 'avcC parameter sets');
    for (let index = 0; index < ppsCount; index++) {
      if (cursor + 2 > box.end) throw new Error('Truncated avcC PPS length.');
      const length = view.getUint16(cursor);
      cursor += 2 + length;
      if (cursor > box.end) throw new Error('Invalid avcC PPS bounds.');
    }
    if (cursor !== box.end) addReason('avcc-trailing-data');
    if (count > maxTableEntries) addReason('avcc-parameter-set-limit-exceeded');
    addAuxiliaryEntries('avcC', count);
    additionalAuxiliaryUnits = checkedAdd(additionalAuxiliaryUnits,
      checkedMultiply(count, MP4_AVCC_EXTRA_UNITS_PER_PARAMETER_SET, 'avcC weighted units'), 'additional auxiliary units');
  };
  const scanEsdsDescriptors = (start, end, depth, parentTag = null, descriptorState = { count: 0 }) => {
    if (depth > maxDepth) throw new Error('MP4 descriptor nesting limit exceeded.');
    let cursor = start;
    while (cursor < end) {
      if (parentTag === null && cursor !== start) addReason('multiple-esds-root-descriptors');
      const tag = view.getUint8(cursor++);
      const allowedTags = parentTag === null ? [3] : parentTag === 3 ? [4, 6] : parentTag === 4 ? [5] : [];
      if (!allowedTags.includes(tag)) addReason(`unsupported-esds-descriptor:${tag}`);
      let length = 0;
      let lengthBytes = 0;
      let continued = true;
      while (continued) {
        if (cursor >= end || lengthBytes === 4) throw new Error('Invalid ES descriptor length.');
        const value = view.getUint8(cursor++);
        length = length * 128 + (value & 0x7f);
        continued = (value & 0x80) !== 0;
        lengthBytes++;
      }
      const bodyStart = cursor;
      const bodyEnd = checkedAdd(bodyStart, length, 'ES descriptor end');
      if (bodyEnd > end) throw new Error('ES descriptor exceeds its parent.');
      if (++descriptorState.count > MP4_MAX_ESDS_DESCRIPTORS) addReason('esds-descriptor-limit-exceeded');
      if (++visitedBoxes > maxVisitedBoxes) throw new Error('MP4 metadata box-count limit exceeded.');
      addAuxiliaryEntries('esds-descriptor', 1);
      additionalAuxiliaryUnits = checkedAdd(additionalAuxiliaryUnits, MP4_ESDS_EXTRA_UNITS_PER_DESCRIPTOR, 'esds weighted units');
      let nestedStart = null;
      if (tag === 3) {
        if (length < 3) throw new Error('Truncated ES_Descriptor.');
        let position = bodyStart + 3;
        const flags = view.getUint8(bodyStart + 2);
        if (flags & 0x80) position += 2;
        if (flags & 0x40) {
          if (position >= bodyEnd) throw new Error('Truncated ES_Descriptor URL.');
          position += 1 + view.getUint8(position);
        }
        if (flags & 0x20) position += 2;
        if (position > bodyEnd) throw new Error('Invalid ES_Descriptor optional fields.');
        nestedStart = position;
      } else if (tag === 4) {
        if (length < 13) throw new Error('Truncated DecoderConfigDescriptor.');
        nestedStart = bodyStart + 13;
      }
      if (nestedStart !== null && nestedStart < bodyEnd) scanEsdsDescriptors(nestedStart, bodyEnd, depth + 1, tag, descriptorState);
      cursor = bodyEnd;
    }
  };
  const visit = (start, end, depth, context, parentType) => {
    if (depth > maxDepth) throw new Error('MP4 metadata nesting limit exceeded.');
    let offset = start;
    while (offset < end) {
      if (++visitedBoxes > maxVisitedBoxes) throw new Error('MP4 metadata box-count limit exceeded.');
      const box = readBoxHeader(view, offset, end);
      if (box.end <= offset) throw new Error('MP4 metadata scanner made no progress.');

      if (box.type === 'trak' && parentType === 'moov') {
        if (tracks.length >= maxTracks) throw new Error('MP4 track-count limit exceeded.');
        const track = { id: null, handler: null, tableSamples: 0, fragmentSamples: 0, hasSampleTable: false, hasSampleDescription: false, sampleEntryTypes: [], trunCount: 0 };
        tracks.push(track);
        visit(box.offset + box.headerBytes, box.end, depth + 1, { ...context, track }, box.type);
      } else if (box.type === 'traf' && parentType === 'moof') {
        const fragment = { trackId: null, sampleCount: 0, trunCount: 0 };
        fragments.push(fragment);
        visit(box.offset + box.headerBytes, box.end, depth + 1, { ...context, fragment }, box.type);
      } else if (MP4_CONTAINER_PARENTS[box.type] === parentType) {
        if (box.type === 'moov') moovCount++;
        if (box.type === 'moof') moofCount++;
        const childrenStart = box.offset + box.headerBytes + (box.type === 'meta' ? 4 : 0);
        if (childrenStart > box.end) throw new Error(`Truncated ${box.type} container.`);
        if (box.type === 'meta') {
          const { version, flags } = fullBoxVersionAndFlags(view, box);
          if (version !== 0 || flags !== 0) addReason('unsupported-meta-fullbox');
        }
        visit(childrenStart, box.end, depth + 1, context, box.type);
      } else if (box.type === 'tkhd' && parentType === 'trak' && context.track) {
        const { version } = fullBoxVersionAndFlags(view, box);
        const idOffset = box.offset + box.headerBytes + (version === 1 ? 20 : 12);
        if (idOffset + 4 > box.end) throw new Error('Truncated tkhd track ID.');
        context.track.id = view.getUint32(idOffset);
      } else if (box.type === 'hdlr' && (parentType === 'mdia' || parentType === 'meta')) {
        fullBoxVersionAndFlags(view, box);
        const handlerOffset = box.offset + box.headerBytes + 8;
        if (box.offset + box.headerBytes + 24 > box.end) throw new Error('Truncated hdlr handler type.');
        if (parentType === 'mdia' && context.track) context.track.handler = String.fromCharCode(view.getUint8(handlerOffset), view.getUint8(handlerOffset + 1), view.getUint8(handlerOffset + 2), view.getUint8(handlerOffset + 3));
      } else if (box.type === 'elng' && parentType === 'mdia') {
        const { version, flags } = fullBoxVersionAndFlags(view, box);
        const languageOffset = box.offset + box.headerBytes + 4;
        const languageLength = box.end - languageOffset;
        if (version !== 0 || flags !== 0 || languageLength < 2 || languageLength > MP4_MAX_EXTENDED_LANGUAGE_BYTES) {
          addReason('unsupported-elng-layout');
        } else {
          let subtag = 0;
          let subtagLength = 0;
          for (let index = languageOffset; index < box.end; index++) {
            const code = view.getUint8(index);
            if (code === 0x2d) {
              if (subtagLength < (subtag === 0 ? 2 : 1)) throw new Error('Invalid elng language subtag.');
              subtag++;
              subtagLength = 0;
            } else {
              const alpha = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
              const alphanumeric = alpha || (code >= 0x30 && code <= 0x39);
              if ((!alphanumeric || (subtag === 0 && !alpha)) || ++subtagLength > 8) addReason('unsupported-elng-language-tag');
            }
          }
          if (subtagLength < (subtag === 0 ? 2 : 1)) throw new Error('Invalid elng language subtag.');
          additionalAuxiliaryUnits = checkedAdd(additionalAuxiliaryUnits, MP4_ELNG_EXTRA_UNITS_PER_BOX, 'elng weighted units');
        }
      } else if (box.type === 'tfhd' && parentType === 'traf' && context.fragment) {
        fullBoxVersionAndFlags(view, box);
        const idOffset = box.offset + box.headerBytes + 4;
        if (idOffset + 4 > box.end) throw new Error('Truncated tfhd track ID.');
        context.fragment.trackId = view.getUint32(idOffset);
      } else if (box.type === 'stsz' && parentType === 'stbl' && context.track) {
        if (context.track.hasSampleTable) throw new Error('Duplicate sample-size declaration in track.');
        fullBoxVersionAndFlags(view, box);
        const fixedSampleSize = view.getUint32(box.offset + box.headerBytes + 4);
        const countOffset = box.offset + box.headerBytes + 8;
        const count = view.getUint32(countOffset);
        if (fixedSampleSize === 0) {
          const required = checkedAdd(box.headerBytes + 12, checkedMultiply(count, 4, 'stsz sample sizes'), 'stsz length');
          if (required !== box.size) throw new Error('Inconsistent stsz sample-size length.');
        } else if (box.size !== box.headerBytes + 12) {
          throw new Error('Inconsistent constant-size stsz length.');
        }
        context.track.tableSamples = count;
        context.track.hasSampleTable = true;
      } else if (box.type === 'stz2' && parentType === 'stbl' && context.track) {
        if (context.track.hasSampleTable) throw new Error('Duplicate sample-size declaration in track.');
        fullBoxVersionAndFlags(view, box);
        const fieldSizeOffset = box.offset + box.headerBytes + 7;
        const countOffset = box.offset + box.headerBytes + 8;
        if (countOffset + 4 > box.end) throw new Error('Truncated stz2 sample count.');
        const fieldSize = view.getUint8(fieldSizeOffset);
        const count = view.getUint32(countOffset);
        if (![4, 8, 16].includes(fieldSize)) throw new Error('Unsupported stz2 field size.');
        const sampleBytes = Math.ceil(count * fieldSize / 8);
        if (!Number.isSafeInteger(sampleBytes) || box.headerBytes + 12 + sampleBytes !== box.size) throw new Error('Inconsistent stz2 sample-size length.');
        context.track.tableSamples = count;
        context.track.hasSampleTable = true;
      } else if (box.type === 'trun' && parentType === 'traf' && context.fragment) {
        const { flags } = fullBoxVersionAndFlags(view, box);
        const countOffset = box.offset + box.headerBytes + 4;
        if (countOffset + 4 > box.end) throw new Error('Truncated trun sample count.');
        const count = view.getUint32(countOffset);
        let fixedFields = 0;
        if (flags & 0x000001) fixedFields++;
        if (flags & 0x000004) fixedFields++;
        let perSampleFields = 0;
        for (const flag of [0x000100, 0x000200, 0x000400, 0x000800]) if (flags & flag) perSampleFields++;
        const fixedBytes = box.headerBytes + 8 + fixedFields * 4;
        const perSampleBytes = checkedMultiply(count, perSampleFields * 4, 'trun sample fields');
        if (fixedBytes + perSampleBytes !== box.size) throw new Error('Inconsistent trun field length.');
        context.fragment.sampleCount = checkedAdd(context.fragment.sampleCount, count, 'trun sample count');
        context.fragment.trunCount++;
        perSampleFieldUnits = checkedAdd(perSampleFieldUnits, checkedMultiply(count, perSampleFields, 'trun field units'), 'trun field units');
        if (count > 0) {
          additionalAuxiliaryUnits = checkedAdd(additionalAuxiliaryUnits,
            checkedMultiply(perSampleFields, MP4_TRUN_EXTRA_UNITS_PER_FIELD_ARRAY, 'trun field-array units'), 'additional auxiliary units');
        }
      } else if (box.type === 'stsd' && parentType === 'stbl' && context.track) {
        fullBoxVersionAndFlags(view, box);
        const countOffset = box.offset + box.headerBytes + 4;
        if (countOffset + 4 > box.end) throw new Error('Truncated stsd entry count.');
        const count = view.getUint32(countOffset);
        if (count > maxSampleDescriptions) addReason('sample-description-limit-exceeded');
        let entryOffset = countOffset + 4;
        if (count > Math.floor((box.end - entryOffset) / 8)) throw new Error('Inconsistent stsd entry count.');
        for (let index = 0; index < count && index < maxSampleDescriptions; index++) {
          const entry = readBoxHeader(view, entryOffset, box.end);
          context.track.sampleEntryTypes.push(entry.type);
          const fixedBytes = entry.type === 'avc1' ? 78 : entry.type === 'mp4a' ? 28 : 0;
          if (fixedBytes === 0 || entry.headerBytes + fixedBytes > entry.size) {
            addReason(`unsupported-sample-entry:${entry.type}`);
          } else {
            if (entry.type === 'mp4a' && view.getUint16(entry.offset + entry.headerBytes + 8) !== 0) addReason('unsupported-audio-sample-entry-version');
            if (++visitedBoxes > maxVisitedBoxes) throw new Error('MP4 metadata box-count limit exceeded.');
            visit(entry.offset + entry.headerBytes + fixedBytes, entry.end, depth + 1, context, entry.type);
          }
          entryOffset = entry.end;
        }
        if (count <= maxSampleDescriptions && entryOffset !== box.end) throw new Error('Inconsistent stsd entry boundary.');
        context.track.hasSampleDescription = true;
        addAuxiliaryEntries('stsd', count);
        additionalAuxiliaryUnits = checkedAdd(additionalAuxiliaryUnits, checkedMultiply(count, MP4_STSD_EXTRA_UNITS_PER_ENTRY, 'stsd weighted units'), 'additional auxiliary units');
      } else if (box.type === 'sbgp' && parentType === 'stbl' && context.track) {
        const { version } = fullBoxVersionAndFlags(view, box);
        if (version > 1) addReason('unsupported-sbgp-version');
        const groupingTypeOffset = box.offset + box.headerBytes + 4;
        if (groupingTypeOffset + 4 > box.end) throw new Error('Truncated sbgp grouping type.');
        const groupingType = String.fromCharCode(view.getUint8(groupingTypeOffset), view.getUint8(groupingTypeOffset + 1), view.getUint8(groupingTypeOffset + 2), view.getUint8(groupingTypeOffset + 3));
        if (groupingType !== 'roll') addReason(`unsupported-sbgp-group:${groupingType}`);
        const countOffset = box.offset + box.headerBytes + (version === 1 ? 12 : 8);
        const fixedBytes = box.headerBytes + (version === 1 ? 16 : 12);
        const count = readDeclaredCount(view, box, countOffset, 8, fixedBytes);
        if (count > maxTableEntries) addReason('sbgp-entry-limit-exceeded');
        addAuxiliaryEntries('sbgp', count);
        additionalAuxiliaryUnits = checkedAdd(additionalAuxiliaryUnits,
          checkedMultiply(count, MP4_SBGP_EXTRA_UNITS_PER_ENTRY, 'sbgp weighted units'), 'additional auxiliary units');
      } else if (box.type === 'sgpd' && parentType === 'stbl' && context.track) {
        const { version } = fullBoxVersionAndFlags(view, box);
        if (version > 1) addReason('unsupported-sgpd-version');
        const groupingTypeOffset = box.offset + box.headerBytes + 4;
        if (groupingTypeOffset + 4 > box.end) throw new Error('Truncated sgpd grouping type.');
        const groupingType = String.fromCharCode(view.getUint8(groupingTypeOffset), view.getUint8(groupingTypeOffset + 1), view.getUint8(groupingTypeOffset + 2), view.getUint8(groupingTypeOffset + 3));
        if (!MP4_SUPPORTED_SGPD_GROUP_TYPES.has(groupingType)) addReason(`unsupported-sgpd-group:${groupingType}`);
        let cursor = groupingTypeOffset + 4;
        let defaultLength = 0;
        if (version >= 1) {
          if (cursor + (version >= 2 ? 8 : 4) > box.end) throw new Error('Truncated sgpd version fields.');
          defaultLength = view.getUint32(cursor);
          cursor += 4;
          if (version >= 2) cursor += 4;
        } else if (version !== 0) {
          addReason('unsupported-sgpd-version');
        }
        if (cursor + 4 > box.end) throw new Error('Truncated sgpd entry count.');
        const count = view.getUint32(cursor);
        cursor += 4;
        if (count > maxTableEntries) addReason('sgpd-entry-limit-exceeded');
        else if (version === 0) {
          if (groupingType !== 'roll' || cursor + checkedMultiply(count, 2, 'sgpd entries') !== box.end) addReason(`unsupported-sgpd-layout:${groupingType}`);
          else cursor = box.end;
        } else if (defaultLength > 0) {
          if (defaultLength !== 2) addReason('unsupported-sgpd-entry-width');
          cursor += checkedMultiply(count, defaultLength, 'sgpd entries');
          if (cursor !== box.end) throw new Error('Inconsistent sgpd entry length.');
        } else {
          for (let index = 0; index < count; index++) {
            if (cursor + 4 > box.end) throw new Error('Truncated sgpd variable entry length.');
            const descriptionLength = view.getUint32(cursor);
            if (descriptionLength !== 2) addReason('unsupported-sgpd-entry-width');
            cursor += 4 + descriptionLength;
            if (cursor > box.end) throw new Error('Inconsistent sgpd variable entry length.');
          }
          if (cursor !== box.end) throw new Error('Inconsistent sgpd variable entry boundary.');
        }
        addAuxiliaryEntries('sgpd', count);
        additionalAuxiliaryUnits = checkedAdd(additionalAuxiliaryUnits, checkedMultiply(count, MP4_SGPD_EXTRA_UNITS_PER_ENTRY, 'sgpd weighted units'), 'additional auxiliary units');
      } else if (MP4_AUXILIARY_TABLE_TYPES.has(box.type) && parentType === 'stbl' && context.track) {
        fullBoxVersionAndFlags(view, box);
        const entryBytes = MP4_AUXILIARY_TABLE_TYPES.get(box.type);
        const countOffset = box.offset + box.headerBytes + 4;
        const count = readDeclaredCount(view, box, countOffset, entryBytes, box.headerBytes + 8);
        addAuxiliaryEntries(box.type, count);
        additionalAuxiliaryUnits = checkedAdd(additionalAuxiliaryUnits,
          checkedMultiply(count, MP4_AUXILIARY_TABLE_EXTRA_UNITS_PER_ENTRY.get(box.type), `${box.type} weighted units`), 'additional auxiliary units');
      } else if (box.type === 'elst' && parentType === 'edts') {
        const { version } = fullBoxVersionAndFlags(view, box);
        if (version > 1) addReason('unsupported-elst-version');
        const countOffset = box.offset + box.headerBytes + 4;
        const count = readDeclaredCount(view, box, countOffset, version === 1 ? 20 : 12, box.headerBytes + 8);
        addAuxiliaryEntries('elst', count);
        additionalAuxiliaryUnits = checkedAdd(additionalAuxiliaryUnits,
          checkedMultiply(count, MP4_ELST_EXTRA_UNITS_PER_ENTRY, 'elst weighted units'), 'additional auxiliary units');
      } else if (box.type === 'dref' && parentType === 'dinf') {
        const { version } = fullBoxVersionAndFlags(view, box);
        if (version !== 0) addReason('unsupported-dref-version');
        const countOffset = box.offset + box.headerBytes + 4;
        if (countOffset + 4 > box.end) throw new Error('Truncated dref entry count.');
        const count = view.getUint32(countOffset);
        let entryOffset = countOffset + 4;
        if (count !== 1 || count > maxTableEntries || count > Math.floor((box.end - entryOffset) / 8)) addReason('dref-entry-limit-exceeded');
        else {
          for (let index = 0; index < count; index++) {
            const entry = readBoxHeader(view, entryOffset, box.end);
            if (entry.type !== 'url ' || entry.size !== 12) addReason(`unsupported-dref-entry:${entry.type}`);
            else {
              const { version, flags } = fullBoxVersionAndFlags(view, entry);
              if (version !== 0 || flags !== 1) addReason('unsupported-dref-url-mode');
            }
            if (++visitedBoxes > maxVisitedBoxes) throw new Error('MP4 metadata box-count limit exceeded.');
            entryOffset = entry.end;
          }
          if (entryOffset !== box.end) throw new Error('Inconsistent dref entry boundary.');
        }
        addAuxiliaryEntries('dref', count);
        additionalAuxiliaryUnits = checkedAdd(additionalAuxiliaryUnits,
          checkedMultiply(count, MP4_DREF_EXTRA_UNITS_PER_ENTRY, 'dref weighted units'), 'additional auxiliary units');
      } else if (box.type === 'tfra' && parentType === 'mfra') {
        const { version } = fullBoxVersionAndFlags(view, box);
        if (version > 1) addReason('unsupported-tfra-version');
        const sizesOffset = box.offset + box.headerBytes + 11;
        const countOffset = box.offset + box.headerBytes + 12;
        if (countOffset + 4 > box.end) throw new Error('Truncated tfra entry count.');
        const sizes = view.getUint8(sizesOffset);
        const entryBytes = (version === 1 ? 16 : 8) + ((sizes >>> 4) & 3) + 1 + ((sizes >>> 2) & 3) + 1 + (sizes & 3) + 1;
        const count = readDeclaredCount(view, box, countOffset, entryBytes, box.headerBytes + 16);
        addAuxiliaryEntries('tfra', count);
        additionalAuxiliaryUnits = checkedAdd(additionalAuxiliaryUnits,
          checkedMultiply(count, MP4_TFRA_EXTRA_UNITS_PER_ENTRY, 'tfra weighted units'), 'additional auxiliary units');
      } else if (box.type === 'avcC' && parentType === 'avc1') {
        scanAvcConfiguration(box);
      } else if (box.type === 'free' && MP4_OPAQUE_NESTED_BOX_PARENTS.has(parentType)) {
        // The enclosing metadata-byte budget accounts for this opaque payload.
      } else if (box.type === 'esds' && parentType === 'mp4a') {
        const { version } = fullBoxVersionAndFlags(view, box);
        if (version !== 0) addReason('unsupported-esds-version');
        scanEsdsDescriptors(box.offset + box.headerBytes + 4, box.end, depth + 1);
      } else if (parentType === 'ilst' && MP4_SUPPORTED_ILST_ITEMS.has(box.type)) {
        visit(box.offset + box.headerBytes, box.end, depth + 1, {}, box.type);
      } else if (MP4_SAFE_LEAF_PARENTS[box.type]?.includes(parentType)) {
        if (box.type === 'data' && box.size < box.headerBytes + 8) throw new Error('Truncated QuickTime data box.');
      } else {
        addReason(`unsupported-nested-box:${box.type}:parent:${parentType}`);
      }
      if (context.topLevel && topLevel.length < 64) topLevel.push({ type: box.type, offset: box.offset, size: box.size });
      offset = box.end;
    }
    if (offset !== end) throw new Error('MP4 box sequence does not end at its parent boundary.');
  };

  // Top-level parsing is separate so mdat payloads are skipped without inspection.
  let offset = 0;
  while (offset < input.byteLength) {
    if (++visitedBoxes > maxVisitedBoxes) throw new Error('MP4 metadata box-count limit exceeded.');
    const box = readBoxHeader(view, offset, input.byteLength);
    if (topLevel.length < 64) topLevel.push({ type: box.type, offset: box.offset, size: box.size });
    if (box.type === 'moov') {
      moovCount++;
      metadataBytes = checkedAdd(metadataBytes, box.size, 'metadata bytes');
      visit(box.offset + box.headerBytes, box.end, 1, {}, box.type);
    } else if (box.type === 'moof') {
      moofCount++;
      metadataBytes = checkedAdd(metadataBytes, box.size, 'metadata bytes');
      visit(box.offset + box.headerBytes, box.end, 1, {}, box.type);
    } else if (box.type === 'mfra') {
      metadataBytes = checkedAdd(metadataBytes, box.size, 'metadata bytes');
      visit(box.offset + box.headerBytes, box.end, 1, {}, box.type);
    } else if (box.type === 'ftyp' || box.type === 'styp') {
      metadataBytes = checkedAdd(metadataBytes, box.size, 'metadata bytes');
      const payloadBytes = box.size - box.headerBytes;
      if (payloadBytes < 8 || (payloadBytes - 8) % 4 !== 0) throw new Error(`Invalid ${box.type} brand table.`);
      const brandCount = (payloadBytes - 8) / 4;
      if (brandCount > MP4_MAX_FILE_BRANDS) addReason(`${box.type}-brand-limit-exceeded`);
      addAuxiliaryEntries(box.type, brandCount);
    } else if (box.type === 'sidx') {
      metadataBytes = checkedAdd(metadataBytes, box.size, 'metadata bytes');
      const { version } = fullBoxVersionAndFlags(view, box);
      if (version > 1) addReason('unsupported-sidx-version');
      const countOffset = box.offset + box.headerBytes + (version === 0 ? 22 : 30);
      if (countOffset + 2 > box.end) throw new Error('Truncated sidx reference count.');
      const count = view.getUint16(countOffset);
      const expectedBytes = box.headerBytes + (version === 0 ? 24 : 32) + checkedMultiply(count, 12, 'sidx references');
      if (expectedBytes !== box.size) throw new Error('Inconsistent sidx reference table.');
      addAuxiliaryEntries('sidx', count);
      additionalAuxiliaryUnits = checkedAdd(additionalAuxiliaryUnits,
        checkedMultiply(count, MP4_SIDX_EXTRA_UNITS_PER_REFERENCE, 'sidx weighted units'), 'additional auxiliary units');
    } else if (box.type === 'free') {
      metadataBytes = checkedAdd(metadataBytes, box.size, 'metadata bytes');
    } else if (box.type !== 'mdat') {
      addReason(`unsupported-top-level-box:${box.type}`);
    }
    offset = box.end;
  }
  if (moovCount !== 1) addReason(moovCount === 0 ? 'missing-moov' : 'multiple-moov-boxes');
  const tracksById = new Map();
  for (const track of tracks) {
    if (!Number.isSafeInteger(track.id) || track.id <= 0 || !track.handler) {
      addReason('track-identity-or-handler-unavailable');
      continue;
    }
    if (tracksById.has(track.id)) addReason('duplicate-track-id');
    tracksById.set(track.id, track);
    if (!['vide', 'soun'].includes(track.handler)) addReason(`unsupported-track-handler:${track.handler}`);
    if (!track.hasSampleDescription) addReason('sample-description-unavailable');
    if (track.handler === 'vide' && track.sampleEntryTypes.some((type) => type !== 'avc1')) addReason('sample-entry-handler-mismatch');
    if (track.handler === 'soun' && track.sampleEntryTypes.some((type) => type !== 'mp4a')) addReason('sample-entry-handler-mismatch');
  }
  for (const fragment of fragments) {
    const track = tracksById.get(fragment.trackId);
    if (!track) {
      addReason('fragment-track-unresolved');
      continue;
    }
    track.fragmentSamples = checkedAdd(track.fragmentSamples, fragment.sampleCount, 'fragment sample count');
    track.trunCount = checkedAdd(track.trunCount, fragment.trunCount, 'trun count');
  }
  for (const track of tracks) {
    if (!track.hasSampleTable && track.fragmentSamples === 0) addReason('track-sample-count-uncharacterized');
  }
  const declaredSamples = tracks.reduce((sum, track) => checkedAdd(sum, checkedAdd(track.tableSamples, track.fragmentSamples, 'track sample count'), 'total sample count'), 0);
  const modes = new Set(tracks.flatMap((track) => [track.tableSamples > 0 ? 'classic' : null, track.fragmentSamples > 0 ? 'fragmented' : null].filter(Boolean)));
  const mode = modes.size > 1 ? 'hybrid' : (modes.values().next().value ?? 'unknown');
  const trackRows = tracks.map((track) => ({
    id: track.id,
    handler: track.handler,
    tableSamples: track.tableSamples,
    fragmentSamples: track.fragmentSamples,
    declaredSamples: checkedAdd(track.tableSamples, track.fragmentSamples, 'track samples'),
    hasSampleTable: track.hasSampleTable,
    sampleEntryTypes: track.sampleEntryTypes,
    trunCount: track.trunCount,
  }));
  if (metadataBytes > maxMetadataBytes) addReason('metadata-bytes-limit-exceeded');
  const auxiliaryUnits = checkedAdd(
    checkedAdd(auxiliaryEntryCount, perSampleFieldUnits, 'auxiliary units'),
    checkedAdd(checkedMultiply(visitedBoxes, MP4_AUXILIARY_UNITS_PER_VISITED_BOX, 'visited-box units'), additionalAuxiliaryUnits, 'weighted auxiliary units'),
    'auxiliary units',
  );
  const structuralUnits = checkedAdd(declaredSamples, auxiliaryUnits, 'structural units');
  if (declaredSamples === 0) addReason('no-declared-samples');
  return {
    schema: 1,
    status: uncharacterized.length === 0 && ['classic', 'fragmented'].includes(mode) ? 'characterized' : 'uncharacterized',
    reasons: uncharacterized,
    fileBytes: input.byteLength,
    mode,
    tracks: trackRows,
    trackCount: trackRows.length,
    declaredSamples,
    auxiliaryEntryCount,
    additionalAuxiliaryUnits,
    auxiliaryEntryCountsByType,
    perSampleFieldUnits,
    auxiliaryUnits,
    metadataBytes,
    structuralUnits,
    visitedBoxes,
    moovCount,
    moofCount,
    topLevel,
  };
}

export function fitPreExpansionResourceModel(caseResults, mode, { holdoutCaseIds = [], safetyFactor = 1.1, auxiliaryUnitBytes = 64 } = {}) {
  if (!['classic', 'fragmented'].includes(mode)) throw new Error('Resource model mode must be classic or fragmented.');
  if (!Number.isFinite(safetyFactor) || safetyFactor < 1) throw new Error('Resource model safety factor must be at least 1.');
  if (!Number.isSafeInteger(auxiliaryUnitBytes) || auxiliaryUnitBytes < 0) throw new Error('Auxiliary resource charge must be a non-negative safe integer.');
  const heldOut = new Set(holdoutCaseIds);
  const rows = caseResults.filter((item) => item.status === 'completed' && item.mode === mode && !heldOut.has(item.caseId));
  const points = rows.map((item) => ({
    caseId: item.caseId,
    samples: item.declaredSamples ?? item.sampleCount,
    auxiliaryUnits: item.auxiliaryUnits ?? (item.auxiliaryEntryCount ?? 0) + (item.perSampleFieldUnits ?? 0)
      + (item.visitedBoxes ?? 0) * MP4_AUXILIARY_UNITS_PER_VISITED_BOX + (item.additionalAuxiliaryUnits ?? 0),
    metadataBytes: item.metadataBytes ?? 0,
    bytes: item.observedParserHeapBytes ?? item.parserIndexHeapBytes?.max,
  }));
  if (points.length < 2 || points.some(({ samples, auxiliaryUnits, metadataBytes, bytes }) => !Number.isSafeInteger(samples) || samples <= 0 || !Number.isSafeInteger(auxiliaryUnits) || auxiliaryUnits < 0 || !Number.isSafeInteger(metadataBytes) || metadataBytes < 0 || !Number.isSafeInteger(bytes) || bytes < 0)) {
    throw new Error('Resource model needs at least two valid measured cases.');
  }
  const adjusted = points.map((point) => ({
    ...point,
    adjustedBytes: point.bytes - auxiliaryUnitBytes * point.auxiliaryUnits - point.metadataBytes,
  }));
  let bytesPerSample = 0;
  for (let left = 0; left < adjusted.length; left++) {
    for (let right = left + 1; right < adjusted.length; right++) {
      const deltaSamples = adjusted[right].samples - adjusted[left].samples;
      if (deltaSamples !== 0) bytesPerSample = Math.max(bytesPerSample, (adjusted[right].adjustedBytes - adjusted[left].adjustedBytes) / deltaSamples);
    }
  }
  if (!Number.isFinite(bytesPerSample) || bytesPerSample < 0) throw new Error('Resource model could not derive a valid upper-bound slope.');
  const fixedBytes = Math.max(0, ...adjusted.map(({ samples, adjustedBytes }) => adjustedBytes - bytesPerSample * samples));
  return {
    schema: 1,
    mode,
    fixedBytes,
    bytesPerSample,
    auxiliaryUnitBytes,
    safetyFactor,
    trainingCaseIds: points.map((point) => point.caseId),
    holdoutCaseIds: [...heldOut],
    definition: 'ceil((fixedBytes + bytesPerSample * declaredSamples + auxiliaryUnitBytes * (auxiliary entries + per-sample trun fields + visitedBoxes) + metadataBytes) * safetyFactor)',
  };
}

export function estimateParserMemory(model, metadata) {
  if (!model || !['classic', 'fragmented'].includes(model.mode) || !metadata || metadata.status !== 'characterized' || metadata.mode !== model.mode) {
    throw new Error('Cannot estimate an uncharacterized or mismatched MP4 structure.');
  }
  const samples = metadata.declaredSamples ?? metadata.sampleCount;
  const auxiliaryUnits = metadata.auxiliaryUnits ?? (metadata.auxiliaryEntryCount ?? 0) + (metadata.perSampleFieldUnits ?? 0)
    + (metadata.visitedBoxes ?? 0) * MP4_AUXILIARY_UNITS_PER_VISITED_BOX + (metadata.additionalAuxiliaryUnits ?? 0);
  const metadataBytes = metadata.metadataBytes ?? 0;
  if (!Number.isSafeInteger(samples) || samples < 0 || !Number.isSafeInteger(auxiliaryUnits) || auxiliaryUnits < 0 || !Number.isSafeInteger(metadataBytes) || metadataBytes < 0) throw new Error('Invalid MP4 structural-unit count.');
  const raw = (model.fixedBytes + model.bytesPerSample * samples + (model.auxiliaryUnitBytes ?? 0) * auxiliaryUnits + metadataBytes) * model.safetyFactor;
  if (!Number.isFinite(raw) || raw < 0 || raw > Number.MAX_SAFE_INTEGER) throw new Error('MP4 resource estimate exceeds safe integer range.');
  return Math.ceil(raw);
}

export function validateResourceModel(model, observations) {
  const rows = observations.map((item) => {
    const observedBytes = item.observedParserHeapBytes ?? item.parserIndexHeapBytes?.max;
    try {
      const estimatedBytes = estimateParserMemory(model, {
        status: 'characterized', mode: model.mode,
        declaredSamples: item.declaredSamples ?? item.sampleCount,
        auxiliaryUnits: item.auxiliaryUnits ?? (Number.isSafeInteger(item.structuralUnits) ? item.structuralUnits - (item.declaredSamples ?? item.sampleCount ?? 0) : undefined),
        auxiliaryEntryCount: item.auxiliaryEntryCount,
        perSampleFieldUnits: item.perSampleFieldUnits,
        metadataBytes: item.metadataBytes,
        visitedBoxes: item.visitedBoxes,
      });
      return { caseId: item.caseId, estimatedBytes, observedBytes, marginBytes: estimatedBytes - observedBytes };
    } catch (error) {
      return { caseId: item.caseId, estimatedBytes: null, observedBytes, marginBytes: null, error: error.message };
    }
  });
  const underestimates = rows.filter((row) => !Number.isSafeInteger(row.observedBytes) || !Number.isSafeInteger(row.estimatedBytes) || row.marginBytes < 0);
  return { status: underestimates.length ? 'not-ratified' : 'validated-on-supplied-corpus', underestimates, cases: rows };
}

export function classifyResourceAcceptance({ estimatedBytes, budgetBytes }) {
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0 || !Number.isSafeInteger(budgetBytes) || budgetBytes < 0) return 'reject';
  return estimatedBytes <= budgetBytes ? 'accept' : 'reject';
}

export function aggregateLiveParserCosts(estimatedBytes) {
  if (!Array.isArray(estimatedBytes) || estimatedBytes.length === 0) throw new Error('At least one live parser estimate is required.');
  const owners = new Set();
  return estimatedBytes.reduce((sum, parser) => {
    if (!parser || typeof parser.id !== 'string' || parser.id.length === 0 || owners.has(parser.id) ||
        !Number.isSafeInteger(parser.estimatedBytes) || parser.estimatedBytes < 0) throw new Error('Invalid or duplicate live parser estimate.');
    owners.add(parser.id);
    return checkedAdd(sum, parser.estimatedBytes, 'aggregate live-parser estimate');
  }, 0);
}

export function deriveResourcePolicies(caseResults) {
  return [50_000, 100_000, 200_000].map((targetSamples, index) => {
    const eligible = caseResults.filter((item) => item.status === 'completed' && item.sampleCount <= targetSamples);
    const edge = eligible.reduce((best, item) =>
      !best || item.parserIndexHeapBytes.max > best.parserIndexHeapBytes.max ? item : best, null);
    const multiRows = eligible.flatMap((item) => (item.multipleCandidates ?? []).map((measurement) => ({ item, measurement })));
    const candidateRows = eligible.flatMap((item) => (item.candidate ?? []).map((measurement) => ({ item, measurement })));
    const rows = multiRows.length ? multiRows : candidateRows;
    const combined = rows.reduce((best, row) =>
      !best || row.measurement.combinedParserHeapBytes > best.bytes
        ? { bytes: row.measurement.combinedParserHeapBytes, caseId: row.item.caseId,
          candidateCount: row.measurement.candidateCount ?? 1,
          bootstrapBytes: row.measurement.candidateBootstrapBytes ?? row.item.candidate?.[0]?.candidateBootstrapBytes ?? null }
        : best, null);
    const budget = edge?.parserIndexHeapBytes.max ?? null;
    const completed = caseResults.filter((item) => item.status === 'completed');
    const accepted = completed.filter((item) => budget !== null && item.parserIndexHeapBytes.max <= budget);
    const rejected = completed.filter((item) => budget !== null && item.parserIndexHeapBytes.max > budget);
    const largestAccepted = accepted.reduce((best, item) => !best || item.sampleCount > best.sampleCount ? item : best, null);
    const firstRejected = rejected.reduce((best, item) => !best || item.sampleCount < best.sampleCount ? item : best, null);
    return {
      name: ['A — conservative', 'B — balanced', 'C — permissive'][index],
      targetObservedEffectiveSamples: targetSamples,
      scope: 'selection tier is MP4Box index sample objects across all tracks; acceptance is classified by measured per-parser heap bytes',
      perParserIndexBudgetBytes: budget,
      derivedFromCase: edge?.caseId ?? null,
      aggregateLiveParserIndexBudgetBytes: combined?.bytes ?? null,
      aggregateDerivedFromCase: combined?.caseId ?? null,
      simultaneouslyMeasuredCandidates: combined?.candidateCount ?? null,
      candidateBootstrapBytesAtAggregateCase: combined?.bootstrapBytes ?? null,
      observedCorpusAccepted: accepted.map((item) => item.caseId),
      observedCorpusRejected: rejected.map((item) => item.caseId),
      largestObservedCorpusAccepted: largestAccepted ? { caseId: largestAccepted.caseId, sampleCount: largestAccepted.sampleCount } : null,
      firstObservedCaseRejected: firstRejected ? { caseId: firstRejected.caseId, sampleCount: firstRejected.sampleCount } : null,
      headroomAssumption: 'maximum observed heap delta across independent child-process repetitions; no decoder/MSE/GPU or device headroom is included',
      knownLimitation: 'applies only to measured corpus and MP4Box 2.4.1; not production authority',
    };
  });
}

export function requireExplicitGc(gc = globalThis.gc) {
  if (typeof gc !== 'function') throw new Error('Run Node with --expose-gc.');
  return gc;
}

export function resolveMp4BoxVersion() {
  const frontendRequire = createRequire(path.join(FRONTEND_ROOT, 'package.json'));
  const entry = frontendRequire.resolve('mp4box');
  const packageJson = path.resolve(path.dirname(entry), '..', 'package.json');
  const metadata = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
  return { version: metadata.version, entry: path.relative(FRONTEND_ROOT, entry).replaceAll(path.sep, '/') };
}

export function assertExpectedMp4BoxVersion(resolved = resolveMp4BoxVersion()) {
  if (resolved.version !== EXPECTED_MP4BOX_VERSION) {
    throw new Error(`MP4Box ${EXPECTED_MP4BOX_VERSION} is required; resolved ${resolved.version}.`);
  }
  return resolved;
}

export function parseChildOutput(stdout, status = 0) {
  if (status !== 0) throw new Error(`Calibration child exited with status ${status}.`);
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error('Calibration child returned invalid JSON.');
  }
  if (!result || result.schema !== 1 || typeof result.caseId !== 'string' ||
      !Number.isFinite(result.sampleCount) || !Number.isFinite(result.indexHeapBytes)) {
    throw new Error('Calibration child JSON is missing required fields.');
  }
  return result;
}

export function writeJsonAtomic(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w' });
  fs.renameSync(temporary, filename);
}
