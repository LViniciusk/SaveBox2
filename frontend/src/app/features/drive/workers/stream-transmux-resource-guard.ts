const CLASSIC = { fixedBytes: 627_543.8931219638, bytesPerSample: 336.86621068780363 };
const FRAGMENTED = { fixedBytes: 1_885_267.7263535133, bytesPerSample: 204.19742736464866 };
const AUXILIARY_UNIT_BYTES = 64;
const AUXILIARY_UNITS_PER_VISITED_BOX = 2;
// Additional units are calibrated against retained MP4Box 2.4.1 heap, not guessed from box size.
const ESDS_EXTRA_UNITS_PER_DESCRIPTOR = 5;
const SBGP_EXTRA_UNITS_PER_ENTRY = 6;
const ELST_EXTRA_UNITS_PER_ENTRY = 5;
const TFRA_EXTRA_UNITS_PER_ENTRY = 1;
const SIDX_EXTRA_UNITS_PER_REFERENCE = 1;
const AVCC_EXTRA_UNITS_PER_PARAMETER_SET = 5;
const DREF_EXTRA_UNITS_PER_ENTRY = 3;
const TRUN_EXTRA_UNITS_PER_FIELD_ARRAY = 2;
const SGPD_EXTRA_UNITS_PER_ENTRY = 10;
const STSD_EXTRA_UNITS_PER_ENTRY = 17;
const ELNG_EXTRA_UNITS_PER_BOX = 6;
const HDLR_EXTRA_UNITS_PER_64_NAME_BYTES = 1;
const MAX_EXTENDED_LANGUAGE_BYTES = 63;
const SAFETY_FACTOR = 1.1;
const DEFAULT_PER_PARSER_BUDGET = 93_113_499;
const DEFAULT_MAX_AGGREGATE_BUDGET = 279_340_497;
const DEFAULT_MAX_METADATA_BOX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_METADATA_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_VISITED_BOXES = 200_000;
const DEFAULT_MAX_TABLE_ENTRIES = 1_000_000;
const DEFAULT_MAX_SAMPLE_DESCRIPTIONS = 64;
const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_TRACKS = 128;
const MAX_ESDS_DESCRIPTORS = 8;
const MAX_FILE_BRANDS = 64;

const SUPPORTED_CONTAINERS = new Set([
  'trak', 'mdia', 'minf', 'stbl', 'traf', 'mvex', 'edts', 'dinf', 'udta', 'meta', 'ilst',
]);
const CONTAINER_PARENTS: Readonly<Record<string, string>> = Object.freeze({
  trak: 'moov', mdia: 'trak', minf: 'mdia', stbl: 'minf', traf: 'moof',
  mvex: 'moov', edts: 'trak', dinf: 'minf', udta: 'moov', meta: 'udta', ilst: 'meta',
});
const METADATA_BOXES = new Set(['moov', 'moof', 'mfra', 'sidx', 'ftyp', 'styp']);
const OPAQUE_TOP_LEVEL_BOXES = new Set(['free']);
const OPAQUE_NESTED_BOX_PARENTS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts', 'dinf',
  'udta', 'meta', 'ilst', 'avc1', 'mp4a',
]);
const SAFE_FIXED_OR_SIZE_BOUNDED_BOXES = new Set([
  'mvhd', 'tkhd', 'mdhd', 'vmhd', 'smhd', 'mfhd', 'tfhd', 'tfdt', 'trex', 'mfro',
  'btrt', 'pasp', 'data',
]);
const AUXILIARY_TABLE_WIDTHS = new Map<string, number>([
  ['stts', 8], ['ctts', 8], ['stsc', 12], ['stco', 4], ['co64', 8], ['stss', 4],
]);
const AUXILIARY_TABLE_EXTRA_UNITS_PER_ENTRY = new Map<string, number>([
  ['stts', 9], ['ctts', 7], ['stsc', 9], ['stco', 5], ['co64', 6], ['stss', 4],
]);
const SUPPORTED_SGPD_GROUP_TYPES = new Set(['roll']);
const SUPPORTED_ILST_ITEMS = new Set(['©too']);
const SAFE_LEAF_PARENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  mvhd: ['moov'], tkhd: ['trak'], mdhd: ['mdia'],
  vmhd: ['minf'], smhd: ['minf'], mfhd: ['moof'], tfhd: ['traf'], tfdt: ['traf'],
  trex: ['mvex'], mfro: ['mfra'], btrt: ['avc1', 'mp4a'], pasp: ['avc1'],
  data: ['©too'],
});

export type Mp4ResourceFailure = 'invalid-structure' | 'unsupported-structure' | 'resource-limit';
type Mp4ResourceMode = 'classic' | 'fragmented' | 'unknown';

export interface Mp4ResourceGuardOptions {
  perParserBudgetBytes: number;
  maxMetadataBoxBytes: number;
  maxMetadataBytes: number;
  maxVisitedBoxes: number;
  maxTableEntries: number;
  maxSampleDescriptions: number;
  maxDepth: number;
  maxTracks: number;
}

interface Mp4ResourceSnapshot {
  declaredSamples: number;
  auxiliaryUnits: number;
  metadataBytes: number;
  visitedBoxes: number;
  estimatedBytes: number;
  mode: Mp4ResourceMode;
}

interface Mp4ResourceInspection {
  decision: 'append' | 'reject';
  complete: boolean;
  pendingBytes: number;
  retainedBytes: number;
  usage: Mp4ResourceSnapshot;
  reason?: Mp4ResourceFailure;
}

export interface Mp4ResourceGuard {
  readonly usage: Mp4ResourceSnapshot;
  inspect(
    input: ArrayBuffer,
    absoluteOffset: number,
    options?: { final?: boolean; supplemental?: boolean; canonical?: boolean },
  ): Mp4ResourceInspection;
  finish(): Mp4ResourceInspection;
}

interface BoxHeader {
  type: string;
  size: number;
  headerBytes: number;
  end: number;
}

interface TrackInfo {
  id: number | null;
  handler: string | null;
  sampleTypes: string[];
  tableSamples: number;
  hasSampleTable: boolean;
  hasSampleDescription: boolean;
  fragmentSamples: number;
}

interface FragmentInfo {
  trackId: number | null;
  samples: number;
  truns: number;
}

interface ScanContext {
  track?: TrackInfo;
  fragment?: FragmentInfo;
}

interface ScanDelta {
  tracks: TrackInfo[];
  fragments: FragmentInfo[];
  tableSamples: number;
  fragmentSamples: number;
  auxiliaryEntries: number;
  additionalAuxiliaryUnits: number;
  perSampleFields: number;
  visitedBoxes: number;
  metadataBytes: number;
  hasMvex: boolean;
}

interface TopLevelRange {
  start: number;
  end: number;
  type: string;
  canonicalBytes?: Uint8Array<ArrayBuffer>;
}

class ScanFailure extends Error {
  readonly reason: Mp4ResourceFailure;

  constructor(reason: Mp4ResourceFailure) {
    super(reason);
    this.reason = reason;
  }
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new ScanFailure('invalid-structure');
  return result;
}

function checkedMultiply(left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) throw new ScanFailure('invalid-structure');
  return result;
}

function checkedEnd(start: number, size: number): number {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || size > Number.MAX_SAFE_INTEGER - start) {
    throw new ScanFailure('invalid-structure');
  }
  return start + size;
}

function typeAt(bytes: Uint8Array<ArrayBuffer>, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function readHeader(bytes: Uint8Array<ArrayBuffer>, offset: number, parentEnd: number, final: boolean): BoxHeader | null {
  if (offset < 0 || offset > parentEnd) throw new ScanFailure('invalid-structure');
  if (parentEnd - offset < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const shortSize = view.getUint32(offset);
  const type = typeAt(bytes, offset + 4);
  let headerBytes = 8;
  let size = shortSize;
  if (shortSize === 1) {
    if (parentEnd - offset < 16) return null;
    const largeSize = view.getBigUint64(offset + 8);
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new ScanFailure('invalid-structure');
    size = Number(largeSize);
    headerBytes = 16;
  } else if (shortSize === 0) {
    if (!final) throw new ScanFailure('unsupported-structure');
    size = parentEnd - offset;
  }
  if (size < headerBytes) throw new ScanFailure('invalid-structure');
  const end = checkedEnd(offset, size);
  if (end > parentEnd) {
    if (parentEnd === bytes.byteLength && !final) return { type, size, headerBytes, end };
    throw new ScanFailure('invalid-structure');
  }
  return { type, size, headerBytes, end };
}

function readFullBox(bytes: Uint8Array<ArrayBuffer>, box: BoxHeader, offset: number): { version: number; flags: number } {
  if (offset + 4 > box.end) throw new ScanFailure('invalid-structure');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const raw = view.getUint32(offset);
  return { version: raw >>> 24, flags: raw & 0x00ff_ffff };
}

function findHandlerNameTerminator(bytes: Uint8Array<ArrayBuffer>, start: number, end: number): number {
  for (let index = start; index < end; index++) {
    if (bytes[index] === 0) return index;
  }
  return -1;
}

function scanExtendedLanguage(bytes: Uint8Array<ArrayBuffer>, box: BoxHeader, payload: number): void {
  const { version, flags } = readFullBox(bytes, box, payload);
  const start = payload + 4;
  const length = box.end - start;
  if (version !== 0 || flags !== 0 || length < 2 || length > MAX_EXTENDED_LANGUAGE_BYTES) {
    throw new ScanFailure('unsupported-structure');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let subtag = 0;
  let subtagLength = 0;
  for (let offset = start; offset < box.end; offset++) {
    const code = view.getUint8(offset);
    if (code === 0x2d) {
      if (subtagLength < (subtag === 0 ? 2 : 1)) throw new ScanFailure('invalid-structure');
      subtag++;
      subtagLength = 0;
      continue;
    }
    const alpha = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
    const alphanumeric = alpha || (code >= 0x30 && code <= 0x39);
    if ((!alphanumeric || (subtag === 0 && !alpha)) || ++subtagLength > 8) {
      throw new ScanFailure('unsupported-structure');
    }
  }
  if (subtagLength < (subtag === 0 ? 2 : 1)) throw new ScanFailure('invalid-structure');
}

function readCount(bytes: Uint8Array<ArrayBuffer>, box: BoxHeader, offset: number): number {
  if (offset + 4 > box.end) throw new ScanFailure('invalid-structure');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function brandCount(box: BoxHeader): number {
  const payloadBytes = box.size - box.headerBytes;
  if (payloadBytes < 8 || (payloadBytes - 8) % 4 !== 0) throw new ScanFailure('invalid-structure');
  return (payloadBytes - 8) / 4;
}

function scanAvcConfiguration(
  bytes: Uint8Array<ArrayBuffer>,
  box: BoxHeader,
  options: Mp4ResourceGuardOptions,
  delta: ScanDelta,
): void {
  const payload = box.end - box.size + box.headerBytes;
  if (payload + 7 > box.end) throw new ScanFailure('invalid-structure');
  let cursor = payload + 6;
  const spsCount = bytes[payload + 5] & 0x1f;
  let count = spsCount;
  for (let index = 0; index < spsCount; index++) {
    if (cursor + 2 > box.end) throw new ScanFailure('invalid-structure');
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(cursor);
    cursor = checkedEnd(cursor + 2, length);
    if (cursor > box.end) throw new ScanFailure('invalid-structure');
  }
  if (cursor >= box.end) throw new ScanFailure('invalid-structure');
  const ppsCount = bytes[cursor++];
  count = checkedAdd(count, ppsCount);
  for (let index = 0; index < ppsCount; index++) {
    if (cursor + 2 > box.end) throw new ScanFailure('invalid-structure');
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(cursor);
    cursor = checkedEnd(cursor + 2, length);
    if (cursor > box.end) throw new ScanFailure('invalid-structure');
  }
  if (count > options.maxTableEntries) throw new ScanFailure('resource-limit');
  delta.auxiliaryEntries = checkedAdd(delta.auxiliaryEntries, count);
  delta.additionalAuxiliaryUnits = checkedAdd(delta.additionalAuxiliaryUnits, checkedMultiply(count, AVCC_EXTRA_UNITS_PER_PARAMETER_SET));
}

function scanEsdsDescriptors(
  bytes: Uint8Array<ArrayBuffer>,
  start: number,
  end: number,
  depth: number,
  options: Mp4ResourceGuardOptions,
  delta: ScanDelta,
  descriptorState: { count: number },
  parentTag: number | null,
): void {
  if (depth > options.maxDepth) throw new ScanFailure('resource-limit');
  let offset = start;
  while (offset < end) {
    if (parentTag === null && offset !== start) throw new ScanFailure('unsupported-structure');
    const tag = bytes[offset++];
    const allowedTag = parentTag === null
      ? tag === 3
      : parentTag === 3
        ? tag === 4 || tag === 6
        : parentTag === 4 && tag === 5;
    if (!allowedTag) throw new ScanFailure('unsupported-structure');
    let size = 0;
    let sizeBytes = 0;
    let hasMore = true;
    while (hasMore) {
      if (offset >= end || sizeBytes === 4) throw new ScanFailure('invalid-structure');
      const byte = bytes[offset++];
      size = size * 128 + (byte & 0x7f);
      hasMore = (byte & 0x80) !== 0;
      sizeBytes++;
    }
    const bodyStart = offset;
    const bodyEnd = checkedEnd(bodyStart, size);
    if (bodyEnd > end) throw new ScanFailure('invalid-structure');
    delta.visitedBoxes = checkedAdd(delta.visitedBoxes, 1);
    if (delta.visitedBoxes > options.maxVisitedBoxes) throw new ScanFailure('resource-limit');
    delta.auxiliaryEntries = checkedAdd(delta.auxiliaryEntries, 1);
    delta.additionalAuxiliaryUnits = checkedAdd(delta.additionalAuxiliaryUnits, ESDS_EXTRA_UNITS_PER_DESCRIPTOR);
    descriptorState.count = checkedAdd(descriptorState.count, 1);
    if (descriptorState.count > MAX_ESDS_DESCRIPTORS || delta.auxiliaryEntries > options.maxTableEntries) {
      throw new ScanFailure('resource-limit');
    }

    let childStart: number | null = null;
    if (tag === 3) {
      if (size < 3) throw new ScanFailure('invalid-structure');
      let cursor = bodyStart + 3;
      const flags = bytes[bodyStart + 2];
      if (flags & 0x80) cursor += 2;
      if (flags & 0x40) {
        if (cursor >= bodyEnd) throw new ScanFailure('invalid-structure');
        cursor += 1 + bytes[cursor];
      }
      if (flags & 0x20) cursor += 2;
      if (cursor > bodyEnd) throw new ScanFailure('invalid-structure');
      childStart = cursor;
    } else if (tag === 4) {
      if (size < 13) throw new ScanFailure('invalid-structure');
      childStart = bodyStart + 13;
    }
    if (childStart !== null && childStart < bodyEnd) {
      scanEsdsDescriptors(bytes, childStart, bodyEnd, depth + 1, options, delta, descriptorState, tag);
    }
    offset = bodyEnd;
  }
  if (offset !== end) throw new ScanFailure('invalid-structure');
}

function createScanDelta(): ScanDelta {
  return {
    tracks: [], fragments: [], tableSamples: 0, fragmentSamples: 0,
    auxiliaryEntries: 0, additionalAuxiliaryUnits: 0, perSampleFields: 0, visitedBoxes: 0, metadataBytes: 0, hasMvex: false,
  };
}

function scanMetadataBox(
  bytes: Uint8Array<ArrayBuffer>,
  options: Mp4ResourceGuardOptions,
  existingTrackIds: ReadonlySet<number>,
): ScanDelta {
  const top = readHeader(bytes, 0, bytes.byteLength, true);
  if (!top || top.end !== bytes.byteLength || !METADATA_BOXES.has(top.type)) throw new ScanFailure('invalid-structure');
  const delta = createScanDelta();
  delta.visitedBoxes = 1;
  delta.metadataBytes = top.size;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (top.type === 'ftyp' || top.type === 'styp') {
    const brands = brandCount(top);
    if (brands > MAX_FILE_BRANDS || brands > options.maxTableEntries) throw new ScanFailure('resource-limit');
    delta.auxiliaryEntries = brands;
    return delta;
  }

  if (top.type === 'sidx') {
    const { version } = readFullBox(bytes, top, top.headerBytes);
    if (version > 1) throw new ScanFailure('unsupported-structure');
    const countOffset = top.headerBytes + (version === 0 ? 22 : 30);
    if (countOffset + 2 > top.end) throw new ScanFailure('invalid-structure');
    const count = view.getUint16(countOffset);
    if (top.headerBytes + (version === 0 ? 24 : 32) + checkedMultiply(count, 12) !== top.size) throw new ScanFailure('invalid-structure');
    if (count > options.maxTableEntries) throw new ScanFailure('resource-limit');
    delta.auxiliaryEntries = count;
    delta.additionalAuxiliaryUnits = checkedMultiply(count, SIDX_EXTRA_UNITS_PER_REFERENCE);
    return delta;
  }

  const visit = (start: number, end: number, depth: number, context: ScanContext, parentType: string): void => {
    if (depth > options.maxDepth) throw new ScanFailure('resource-limit');
    let offset = start;
    while (offset < end) {
      delta.visitedBoxes = checkedAdd(delta.visitedBoxes, 1);
      if (delta.visitedBoxes > options.maxVisitedBoxes) throw new ScanFailure('resource-limit');
      const child = readHeader(bytes, offset, end, true);
      if (!child || child.end <= offset) throw new ScanFailure('invalid-structure');
      const payload = offset + child.headerBytes;

      if (child.type === 'trak' && parentType === 'moov') {
        if (delta.tracks.length >= options.maxTracks) throw new ScanFailure('resource-limit');
        const track: TrackInfo = { id: null, handler: null, sampleTypes: [], tableSamples: 0, hasSampleTable: false, hasSampleDescription: false, fragmentSamples: 0 };
        delta.tracks.push(track);
        visit(payload, child.end, depth + 1, { track }, child.type);
      } else if (child.type === 'traf' && parentType === 'moof') {
        const fragment: FragmentInfo = { trackId: null, samples: 0, truns: 0 };
        delta.fragments.push(fragment);
        visit(payload, child.end, depth + 1, { fragment }, child.type);
      } else if (SUPPORTED_CONTAINERS.has(child.type) && CONTAINER_PARENTS[child.type] === parentType) {
        if (child.type === 'mvex') delta.hasMvex = true;
        const childrenStart = child.type === 'meta' ? payload + 4 : payload;
        if (childrenStart > child.end) throw new ScanFailure('invalid-structure');
        if (child.type === 'meta') {
          const { version, flags } = readFullBox(bytes, child, payload);
          if (version !== 0 || flags !== 0) throw new ScanFailure('unsupported-structure');
        }
        visit(childrenStart, child.end, depth + 1, context, child.type);
      } else if (parentType === 'ilst' && SUPPORTED_ILST_ITEMS.has(child.type)) {
        visit(payload, child.end, depth + 1, {}, child.type);
      } else if (child.type === 'free' && OPAQUE_NESTED_BOX_PARENTS.has(parentType)) {
        // Its payload is already included in the enclosing metadata byte budget.
      } else if (child.type === 'avcC' && parentType === 'avc1') {
        scanAvcConfiguration(bytes, child, options, delta);
      } else if (child.type === 'tkhd' && parentType === 'trak' && context.track) {
        const { version } = readFullBox(bytes, child, payload);
        if (version > 1) throw new ScanFailure('unsupported-structure');
        const idOffset = payload + (version === 1 ? 20 : 12);
        if (idOffset + 4 > child.end) throw new ScanFailure('invalid-structure');
        context.track.id = view.getUint32(idOffset);
      } else if (child.type === 'hdlr' && (parentType === 'mdia' || parentType === 'meta')) {
        const { version, flags } = readFullBox(bytes, child, payload);
        if (version !== 0 || (parentType === 'meta' && flags !== 0)) throw new ScanFailure('unsupported-structure');
        const fixedEnd = checkedAdd(payload, 24);
        if (fixedEnd > child.end) throw new ScanFailure('invalid-structure');
        if (fixedEnd < child.end) {
          const terminator = findHandlerNameTerminator(bytes, fixedEnd, child.end);
          if (terminator === -1) throw new ScanFailure('unsupported-structure');
          const nameBytes = terminator - fixedEnd + 1;
          delta.additionalAuxiliaryUnits = checkedAdd(
            delta.additionalAuxiliaryUnits,
            checkedMultiply(Math.ceil(nameBytes / 64), HDLR_EXTRA_UNITS_PER_64_NAME_BYTES),
          );
        }
        if (parentType === 'mdia' && context.track) context.track.handler = typeAt(bytes, payload + 8);
      } else if (child.type === 'elng' && parentType === 'mdia') {
        scanExtendedLanguage(bytes, child, payload);
        delta.additionalAuxiliaryUnits = checkedAdd(delta.additionalAuxiliaryUnits, ELNG_EXTRA_UNITS_PER_BOX);
      } else if (child.type === 'tfhd' && parentType === 'traf' && context.fragment) {
        readFullBox(bytes, child, payload);
        context.fragment.trackId = readCount(bytes, child, payload + 4);
      } else if (child.type === 'esds' && parentType === 'mp4a') {
        const { version } = readFullBox(bytes, child, payload);
        if (version !== 0) throw new ScanFailure('unsupported-structure');
        scanEsdsDescriptors(bytes, payload + 4, child.end, depth + 1, options, delta, { count: 0 }, null);
      } else if (child.type === 'stsz' && parentType === 'stbl' && context.track) {
        if (context.track.hasSampleTable) throw new ScanFailure('invalid-structure');
        readFullBox(bytes, child, payload);
        const sampleSize = readCount(bytes, child, payload + 4);
        const count = readCount(bytes, child, payload + 8);
        const expected = child.headerBytes + 12 + (sampleSize === 0 ? checkedMultiply(count, 4) : 0);
        if (expected !== child.size) throw new ScanFailure('invalid-structure');
        if (count > options.maxTableEntries) throw new ScanFailure('resource-limit');
        context.track.tableSamples = count;
        context.track.hasSampleTable = true;
        delta.tableSamples = checkedAdd(delta.tableSamples, count);
      } else if (child.type === 'stz2' && parentType === 'stbl' && context.track) {
        if (context.track.hasSampleTable) throw new ScanFailure('invalid-structure');
        const { version } = readFullBox(bytes, child, payload);
        if (version !== 0 || payload + 12 > child.end) throw new ScanFailure('unsupported-structure');
        const fieldSize = view.getUint8(payload + 7);
        const count = view.getUint32(payload + 8);
        if (![4, 8, 16].includes(fieldSize)) throw new ScanFailure('unsupported-structure');
        const sampleBytes = Math.ceil((count * fieldSize) / 8);
        if (!Number.isSafeInteger(sampleBytes) || child.headerBytes + 12 + sampleBytes !== child.size) throw new ScanFailure('invalid-structure');
        if (count > options.maxTableEntries) throw new ScanFailure('resource-limit');
        context.track.tableSamples = count;
        context.track.hasSampleTable = true;
        delta.tableSamples = checkedAdd(delta.tableSamples, count);
      } else if (child.type === 'trun' && parentType === 'traf' && context.fragment) {
        const { version, flags } = readFullBox(bytes, child, payload);
        if (version > 1 || (flags & ~0x000f05) !== 0) throw new ScanFailure('unsupported-structure');
        const count = readCount(bytes, child, payload + 4);
        const fixedFields = Number((flags & 1) !== 0) + Number((flags & 4) !== 0);
        const sampleFields = Number((flags & 0x100) !== 0) + Number((flags & 0x200) !== 0) + Number((flags & 0x400) !== 0) + Number((flags & 0x800) !== 0);
        const expected = child.headerBytes + 8 + fixedFields * 4 + checkedMultiply(count, sampleFields * 4);
        if (expected !== child.size) throw new ScanFailure('invalid-structure');
        if (count > options.maxTableEntries) throw new ScanFailure('resource-limit');
        context.fragment.samples = checkedAdd(context.fragment.samples, count);
        context.fragment.truns = checkedAdd(context.fragment.truns, 1);
        delta.fragmentSamples = checkedAdd(delta.fragmentSamples, count);
        delta.perSampleFields = checkedAdd(delta.perSampleFields, checkedMultiply(count, sampleFields));
        if (count > 0) {
          delta.additionalAuxiliaryUnits = checkedAdd(
            delta.additionalAuxiliaryUnits,
            checkedMultiply(sampleFields, TRUN_EXTRA_UNITS_PER_FIELD_ARRAY),
          );
        }
      } else if (child.type === 'stsd' && parentType === 'stbl' && context.track) {
        readFullBox(bytes, child, payload);
        const count = readCount(bytes, child, payload + 4);
        if (count > options.maxSampleDescriptions || count > options.maxTableEntries) throw new ScanFailure('resource-limit');
        let entryOffset = payload + 8;
        for (let index = 0; index < count; index++) {
          const entry = readHeader(bytes, entryOffset, child.end, true);
          if (!entry || entry.end <= entryOffset) throw new ScanFailure('invalid-structure');
          const fixedSampleEntryBytes = entry.type === 'avc1' ? 78 : entry.type === 'mp4a' ? 28 : 0;
          if (fixedSampleEntryBytes === 0 || entry.headerBytes + fixedSampleEntryBytes > entry.size) {
            throw new ScanFailure('unsupported-structure');
          }
          if (entry.type === 'mp4a') {
            const audioVersionOffset = entryOffset + entry.headerBytes + 8;
            if (audioVersionOffset + 2 > entry.end || view.getUint16(audioVersionOffset) !== 0) {
              throw new ScanFailure('unsupported-structure');
            }
          }
          context.track.sampleTypes.push(entry.type);
          delta.visitedBoxes = checkedAdd(delta.visitedBoxes, 1);
          if (delta.visitedBoxes > options.maxVisitedBoxes) throw new ScanFailure('resource-limit');
          const childBoxesStart = entryOffset + entry.headerBytes + fixedSampleEntryBytes;
          visit(childBoxesStart, entry.end, depth + 1, context, entry.type);
          entryOffset = entry.end;
        }
        if (entryOffset !== child.end) throw new ScanFailure('invalid-structure');
        context.track.hasSampleDescription = true;
        delta.auxiliaryEntries = checkedAdd(delta.auxiliaryEntries, count);
        delta.additionalAuxiliaryUnits = checkedAdd(delta.additionalAuxiliaryUnits, checkedMultiply(count, STSD_EXTRA_UNITS_PER_ENTRY));
      } else if (AUXILIARY_TABLE_WIDTHS.has(child.type) && parentType === 'stbl' && context.track) {
        const { version } = readFullBox(bytes, child, payload);
        if ((child.type === 'ctts' && version > 1) || (child.type !== 'ctts' && version !== 0)) throw new ScanFailure('unsupported-structure');
        const count = readCount(bytes, child, payload + 4);
        const width = AUXILIARY_TABLE_WIDTHS.get(child.type)!;
        if (child.headerBytes + 8 + checkedMultiply(count, width) !== child.size) throw new ScanFailure('invalid-structure');
        if (count > options.maxTableEntries) throw new ScanFailure('resource-limit');
        delta.auxiliaryEntries = checkedAdd(delta.auxiliaryEntries, count);
        delta.additionalAuxiliaryUnits = checkedAdd(
          delta.additionalAuxiliaryUnits,
          checkedMultiply(count, AUXILIARY_TABLE_EXTRA_UNITS_PER_ENTRY.get(child.type)!),
        );
      } else if (child.type === 'sbgp' && parentType === 'stbl' && context.track) {
        const { version } = readFullBox(bytes, child, payload);
        if (version > 1) throw new ScanFailure('unsupported-structure');
        if (typeAt(bytes, payload + 4) !== 'roll') throw new ScanFailure('unsupported-structure');
        const countOffset = payload + (version === 1 ? 12 : 8);
        const expected = child.headerBytes + (version === 1 ? 16 : 12) + checkedMultiply(readCount(bytes, child, countOffset), 8);
        const count = readCount(bytes, child, countOffset);
        if (expected !== child.size) throw new ScanFailure('invalid-structure');
        if (count > options.maxTableEntries) throw new ScanFailure('resource-limit');
        delta.auxiliaryEntries = checkedAdd(delta.auxiliaryEntries, count);
        delta.additionalAuxiliaryUnits = checkedAdd(delta.additionalAuxiliaryUnits, checkedMultiply(count, SBGP_EXTRA_UNITS_PER_ENTRY));
      } else if (child.type === 'sgpd' && parentType === 'stbl' && context.track) {
        const { version } = readFullBox(bytes, child, payload);
        if (version > 1) throw new ScanFailure('unsupported-structure');
        const groupOffset = payload + 4;
        if (groupOffset + 4 > child.end) throw new ScanFailure('invalid-structure');
        const groupingType = typeAt(bytes, groupOffset);
        if (!SUPPORTED_SGPD_GROUP_TYPES.has(groupingType)) {
          throw new ScanFailure('unsupported-structure');
        }
        let cursor = groupOffset + 4;
        let defaultLength = 0;
        if (version >= 1) {
          if (cursor + (version >= 2 ? 8 : 4) > child.end) throw new ScanFailure('invalid-structure');
          defaultLength = view.getUint32(cursor);
          cursor += version >= 2 ? 8 : 4;
        }
        const count = readCount(bytes, child, cursor);
        cursor += 4;
        if (count > options.maxTableEntries) throw new ScanFailure('resource-limit');
        if (version === 0) {
          if (cursor + checkedMultiply(count, 2) !== child.end) throw new ScanFailure('unsupported-structure');
        } else if (defaultLength > 0) {
          if (defaultLength !== 2) throw new ScanFailure('unsupported-structure');
          cursor += checkedMultiply(count, defaultLength);
          if (cursor !== child.end) throw new ScanFailure('invalid-structure');
        } else {
          for (let index = 0; index < count; index++) {
            if (cursor + 4 > child.end) throw new ScanFailure('invalid-structure');
            const length = view.getUint32(cursor);
            if (length !== 2) throw new ScanFailure('unsupported-structure');
            cursor = checkedEnd(cursor + 4, length);
            if (cursor > child.end) throw new ScanFailure('invalid-structure');
          }
          if (cursor !== child.end) throw new ScanFailure('invalid-structure');
        }
        delta.auxiliaryEntries = checkedAdd(delta.auxiliaryEntries, count);
        delta.additionalAuxiliaryUnits = checkedAdd(delta.additionalAuxiliaryUnits, checkedMultiply(count, SGPD_EXTRA_UNITS_PER_ENTRY));
      } else if (child.type === 'elst' && parentType === 'edts') {
        const { version } = readFullBox(bytes, child, payload);
        if (version > 1) throw new ScanFailure('unsupported-structure');
        const count = readCount(bytes, child, payload + 4);
        const width = version === 1 ? 20 : 12;
        if (child.headerBytes + 8 + checkedMultiply(count, width) !== child.size) throw new ScanFailure('invalid-structure');
        if (count > options.maxTableEntries) throw new ScanFailure('resource-limit');
        delta.auxiliaryEntries = checkedAdd(delta.auxiliaryEntries, count);
        delta.additionalAuxiliaryUnits = checkedAdd(delta.additionalAuxiliaryUnits, checkedMultiply(count, ELST_EXTRA_UNITS_PER_ENTRY));
      } else if (child.type === 'dref' && parentType === 'dinf') {
        const { version } = readFullBox(bytes, child, payload);
        if (version !== 0) throw new ScanFailure('unsupported-structure');
        const count = readCount(bytes, child, payload + 4);
        if (count !== 1 || count > options.maxTableEntries || count > options.maxVisitedBoxes - delta.visitedBoxes) {
          throw new ScanFailure('resource-limit');
        }
        let cursor = payload + 8;
        for (let index = 0; index < count; index++) {
          const entry = readHeader(bytes, cursor, child.end, true);
          if (!entry || entry.end <= cursor) throw new ScanFailure('invalid-structure');
          if (entry.type !== 'url ' || entry.size !== entry.headerBytes + 4) throw new ScanFailure('unsupported-structure');
          const entryFullBox = readFullBox(bytes, entry, cursor + entry.headerBytes);
          if (entryFullBox.version !== 0 || entryFullBox.flags !== 1) throw new ScanFailure('unsupported-structure');
          cursor = entry.end;
        }
        if (cursor !== child.end) throw new ScanFailure('invalid-structure');
        delta.visitedBoxes = checkedAdd(delta.visitedBoxes, count);
        delta.auxiliaryEntries = checkedAdd(delta.auxiliaryEntries, count);
        delta.additionalAuxiliaryUnits = checkedAdd(delta.additionalAuxiliaryUnits, checkedMultiply(count, DREF_EXTRA_UNITS_PER_ENTRY));
      } else if (child.type === 'tfra' && parentType === 'mfra') {
        const { version } = readFullBox(bytes, child, payload);
        if (version > 1 || payload + 16 > child.end) throw new ScanFailure('unsupported-structure');
        const sizes = view.getUint8(payload + 11);
        const width = (version === 1 ? 16 : 8) + ((sizes >>> 4) & 3) + 1 + ((sizes >>> 2) & 3) + 1 + (sizes & 3) + 1;
        const count = readCount(bytes, child, payload + 12);
        if (child.headerBytes + 16 + checkedMultiply(count, width) !== child.size) throw new ScanFailure('invalid-structure');
        if (count > options.maxTableEntries) throw new ScanFailure('resource-limit');
        delta.auxiliaryEntries = checkedAdd(delta.auxiliaryEntries, count);
        delta.additionalAuxiliaryUnits = checkedAdd(delta.additionalAuxiliaryUnits, checkedMultiply(count, TFRA_EXTRA_UNITS_PER_ENTRY));
      } else if (SAFE_FIXED_OR_SIZE_BOUNDED_BOXES.has(child.type) && SAFE_LEAF_PARENTS[child.type]?.includes(parentType)) {
        if (child.type === 'data' && !SUPPORTED_ILST_ITEMS.has(parentType)) throw new ScanFailure('unsupported-structure');
        if (child.type === 'data' && child.size < child.headerBytes + 8) throw new ScanFailure('invalid-structure');
      } else {
        throw new ScanFailure('unsupported-structure');
      }
      offset = child.end;
    }
    if (offset !== end) throw new ScanFailure('invalid-structure');
  };

  const payloadStart = top.headerBytes;
  visit(payloadStart, top.end, 1, {}, top.type);
  const trackIds = new Set(existingTrackIds);
  for (const track of delta.tracks) {
    if (!Number.isSafeInteger(track.id) || track.id === null || track.id <= 0 || trackIds.has(track.id)) throw new ScanFailure('invalid-structure');
    trackIds.add(track.id);
    if (track.handler !== 'vide' && track.handler !== 'soun') throw new ScanFailure('unsupported-structure');
    if (!track.hasSampleDescription || !track.hasSampleTable) throw new ScanFailure('unsupported-structure');
    if (track.sampleTypes.length === 0 || track.sampleTypes.some((sampleType) => sampleType !== (track.handler === 'vide' ? 'avc1' : 'mp4a'))) {
      throw new ScanFailure('unsupported-structure');
    }
  }
  if (top.type === 'moof') {
    for (const fragment of delta.fragments) {
      if (fragment.trackId === null || !trackIds.has(fragment.trackId)) throw new ScanFailure('unsupported-structure');
    }
  }
  return delta;
}

function estimateBytes(samples: number, auxiliaryUnits: number, metadataBytes: number, mode: Mp4ResourceMode): number {
  const model = mode === 'classic' ? CLASSIC : FRAGMENTED;
  const estimate = Math.ceil((model.fixedBytes + model.bytesPerSample * samples + AUXILIARY_UNIT_BYTES * auxiliaryUnits + metadataBytes) * SAFETY_FACTOR);
  if (!Number.isSafeInteger(estimate) || estimate < 0) throw new ScanFailure('invalid-structure');
  return estimate;
}

class ResourceGuard implements Mp4ResourceGuard {
  private readonly options: Mp4ResourceGuardOptions;
  private readonly ranges: TopLevelRange[] = [];
  private readonly tracks = new Map<number, TrackInfo>();
  private canonicalRetainedBytes = 0;
  private pendingMetadata: Uint8Array<ArrayBuffer> | null = null;
  private pendingMetadataOffset = 0;
  private pendingHeader: Uint8Array<ArrayBuffer> | null = null;
  private pendingHeaderOffset = 0;
  private expectedOffset: number | null = null;
  private declaredSamples = 0;
  private auxiliaryEntries = 0;
  private additionalAuxiliaryUnits = 0;
  private perSampleFields = 0;
  private metadataBytes = 0;
  private visitedBoxes = 0;
  private fragmentedInit = false;
  private hasClassicSamples = false;
  private hasFragmentSamples = false;
  private previousEstimate: number;
  private failure: Mp4ResourceFailure | null = null;

  constructor(options: Partial<Mp4ResourceGuardOptions>) {
    this.options = {
      perParserBudgetBytes: options.perParserBudgetBytes ?? DEFAULT_PER_PARSER_BUDGET,
      maxMetadataBoxBytes: options.maxMetadataBoxBytes ?? DEFAULT_MAX_METADATA_BOX_BYTES,
      maxMetadataBytes: options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES,
      maxVisitedBoxes: options.maxVisitedBoxes ?? DEFAULT_MAX_VISITED_BOXES,
      maxTableEntries: options.maxTableEntries ?? DEFAULT_MAX_TABLE_ENTRIES,
      maxSampleDescriptions: options.maxSampleDescriptions ?? DEFAULT_MAX_SAMPLE_DESCRIPTIONS,
      maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxTracks: options.maxTracks ?? DEFAULT_MAX_TRACKS,
    };
    for (const value of Object.values(this.options)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid MP4 resource guard limits.');
    }
    this.previousEstimate = estimateBytes(0, 0, 0, 'fragmented');
  }

  get usage(): Mp4ResourceSnapshot {
    return this.snapshot();
  }

  inspect(
    input: ArrayBuffer,
    absoluteOffset: number,
    options: { final?: boolean; supplemental?: boolean; canonical?: boolean } = {},
  ): Mp4ResourceInspection {
    if (this.failure) return this.result('reject', true, this.failure);
    try {
      if (!(input instanceof ArrayBuffer) || input.byteLength === 0 || !Number.isSafeInteger(absoluteOffset) || absoluteOffset < 0) {
        throw new ScanFailure('invalid-structure');
      }
      checkedEnd(absoluteOffset, input.byteLength);
      const bytes = new Uint8Array(input);
      if (options.supplemental) {
        this.scanSupplemental(bytes, absoluteOffset);
      } else {
        this.scanInput(bytes, absoluteOffset, options.final ?? false, options.canonical ?? false);
      }
      this.checkBudget();
      if (options.final && (this.pendingMetadata || this.pendingHeader)) throw new ScanFailure('invalid-structure');
      return this.result('append', !this.pendingMetadata && !this.pendingHeader, null);
    } catch (error) {
      const reason = error instanceof ScanFailure ? error.reason : 'invalid-structure';
      this.failure = reason;
      return this.result('reject', false, reason);
    }
  }

  finish(): Mp4ResourceInspection {
    if (this.pendingMetadata || this.pendingHeader) {
      this.failure = 'invalid-structure';
      return this.result('reject', false, this.failure);
    }
    return this.result('append', true, this.failure);
  }

  private scanSupplemental(bytes: Uint8Array<ArrayBuffer>, absoluteOffset: number): void {
    if (this.pendingMetadata || this.pendingHeader) throw new ScanFailure('invalid-structure');
    const header = readHeader(bytes, 0, bytes.byteLength, true);
    if (!header || header.type !== 'moov' || header.end !== bytes.byteLength) throw new ScanFailure('unsupported-structure');
    const existing = this.ranges[this.rangeIndex(absoluteOffset)];
    const previous = this.ranges[this.rangeIndex(absoluteOffset) - 1];
    if ((previous && previous.end > absoluteOffset) || (existing && existing.start < absoluteOffset + header.size)) {
      if (!existing?.canonicalBytes || !this.equalBytes(existing.canonicalBytes, bytes)) throw new ScanFailure('invalid-structure');
      if (existing.start !== absoluteOffset || existing.end !== absoluteOffset + header.size || existing.type !== 'moov') {
        throw new ScanFailure('invalid-structure');
      }
      return;
    }
    this.processMetadata(bytes, absoluteOffset, header);
  }

  private scanInput(bytes: Uint8Array<ArrayBuffer>, absoluteOffset: number, final: boolean, canonical: boolean): void {
    const inputEnd = checkedEnd(absoluteOffset, bytes.byteLength);
    if (this.expectedOffset === null && absoluteOffset !== 0) throw new ScanFailure('invalid-structure');
    if (this.expectedOffset !== null && absoluteOffset !== this.expectedOffset && !this.isFullyCovered(absoluteOffset, inputEnd)) {
      throw new ScanFailure('invalid-structure');
    }
    let cursor = absoluteOffset;
    let sourceOffset = 0;

    if (this.pendingMetadata) {
      if (absoluteOffset !== this.expectedOffset || absoluteOffset !== this.pendingMetadataOffset + this.pendingMetadata.byteLength) {
        throw new ScanFailure('invalid-structure');
      }
      const pendingHeader = readHeader(this.pendingMetadata, 0, this.pendingMetadata.byteLength, false);
      if (!pendingHeader) throw new ScanFailure('invalid-structure');
      if (pendingHeader.size > this.options.maxMetadataBoxBytes) throw new ScanFailure('resource-limit');
      const missing = pendingHeader.size - this.pendingMetadata.byteLength;
      const take = Math.min(missing, bytes.byteLength);
      const combined = new Uint8Array(this.pendingMetadata.byteLength + take);
      combined.set(this.pendingMetadata);
      combined.set(bytes.subarray(0, take), this.pendingMetadata.byteLength);
      if (combined.byteLength > this.options.maxMetadataBoxBytes) throw new ScanFailure('resource-limit');
      if (combined.byteLength < pendingHeader.size) {
        if (final) throw new ScanFailure('invalid-structure');
        this.pendingMetadata = combined;
        this.expectedOffset = inputEnd;
        return;
      }
      const completeHeader = readHeader(combined, 0, combined.byteLength, true);
      if (!completeHeader) throw new ScanFailure('invalid-structure');
      this.processMetadata(combined, this.pendingMetadataOffset, completeHeader);
      this.pendingMetadata = null;
      this.pendingMetadataOffset = 0;
      cursor += take;
      sourceOffset += take;
    }

    if (this.pendingHeader) {
      if (absoluteOffset !== this.expectedOffset || absoluteOffset !== this.pendingHeaderOffset + this.pendingHeader.byteLength) throw new ScanFailure('invalid-structure');
      const needed = this.pendingHeader.byteLength < 8
        ? 8 - this.pendingHeader.byteLength
        : new DataView(this.pendingHeader.buffer, this.pendingHeader.byteOffset, this.pendingHeader.byteLength).getUint32(0) === 1
          ? 16 - this.pendingHeader.byteLength
          : 8 - this.pendingHeader.byteLength;
      const take = Math.min(needed, bytes.byteLength);
      const combined = new Uint8Array(this.pendingHeader.byteLength + take);
      combined.set(this.pendingHeader);
      combined.set(bytes.subarray(0, take), this.pendingHeader.byteLength);
      const first = readHeader(combined, 0, combined.byteLength, false);
      if (!first) {
        if (final) throw new ScanFailure('invalid-structure');
        this.pendingHeader = combined;
        this.expectedOffset = inputEnd;
        return;
      }
      this.pendingHeader = null;
      const boxStart = this.pendingHeaderOffset;
      const boxEnd = checkedEnd(boxStart, first.size);
      const fullHeaderBytes = combined.byteLength;
      if (METADATA_BOXES.has(first.type)) {
        if (first.size > this.options.maxMetadataBoxBytes) throw new ScanFailure('resource-limit');
        const restNeeded = first.size - fullHeaderBytes;
        const extra = Math.min(restNeeded, bytes.byteLength - take);
        const whole = new Uint8Array(fullHeaderBytes + extra);
        whole.set(combined);
        whole.set(bytes.subarray(take, take + extra), fullHeaderBytes);
        if (whole.byteLength < first.size) {
          if (final) throw new ScanFailure('invalid-structure');
          this.pendingMetadata = whole;
          this.pendingMetadataOffset = boxStart;
          this.expectedOffset = inputEnd;
          return;
        }
        this.processMetadata(whole, boxStart, first);
        cursor = boxEnd;
        sourceOffset = cursor - absoluteOffset;
      } else {
        this.recordOpaqueTopLevel(first, boxStart);
        cursor = Math.min(inputEnd, boxEnd);
        sourceOffset = cursor - absoluteOffset;
      }
    }

    while (cursor < inputEnd) {
      const covering = this.findCoveringRange(cursor);
      if (covering) {
        if (final && covering.end > inputEnd) throw new ScanFailure('invalid-structure');
        const overlapEnd = Math.min(inputEnd, covering.end);
        if (covering.type === 'moov') this.compareKnownMoov(covering, bytes, cursor, overlapEnd, absoluteOffset, canonical);
        else if (covering.type === 'moof') throw new ScanFailure('invalid-structure');
        sourceOffset += overlapEnd - cursor;
        cursor = overlapEnd;
        continue;
      }

      const remaining = inputEnd - cursor;
      if (remaining < 8) {
        if (final) throw new ScanFailure('invalid-structure');
        this.pendingHeader = bytes.slice(sourceOffset);
        this.pendingHeaderOffset = cursor;
        this.expectedOffset = inputEnd;
        return;
      }
      const relative = cursor - absoluteOffset;
      const header = readHeader(bytes, relative, bytes.byteLength, final);
      if (!header) {
        if (final) throw new ScanFailure('invalid-structure');
        this.pendingHeader = bytes.slice(relative);
        this.pendingHeaderOffset = cursor;
        this.expectedOffset = inputEnd;
        return;
      }
      const boxEnd = checkedEnd(cursor, header.size);
      if (METADATA_BOXES.has(header.type)) {
        if (header.size > this.options.maxMetadataBoxBytes) throw new ScanFailure('resource-limit');
        if (boxEnd > inputEnd) {
          if (final) throw new ScanFailure('invalid-structure');
          this.pendingMetadata = bytes.slice(relative);
          this.pendingMetadataOffset = cursor;
          this.expectedOffset = inputEnd;
          return;
        }
        const data = bytes.subarray(relative, relative + header.size);
        this.processMetadata(data, cursor, header);
      } else {
        this.recordOpaqueTopLevel(header, cursor);
        if (header.type === 'mdat' && boxEnd > inputEnd && final) throw new ScanFailure('invalid-structure');
      }

      const consumedEnd = Math.min(boxEnd, inputEnd);
      const consumed = consumedEnd - cursor;
      cursor = consumedEnd;
      sourceOffset += consumed;
      if (boxEnd > inputEnd) {
        this.expectedOffset = inputEnd;
        return;
      }
    }
    this.expectedOffset = inputEnd;
  }

  private processMetadata(bytes: Uint8Array<ArrayBuffer>, absoluteOffset: number, header: BoxHeader): void {
    const index = this.rangeIndex(absoluteOffset);
    const existing = this.ranges[index];
    if (existing) {
      if (existing.start === absoluteOffset && existing.end === absoluteOffset + header.size && existing.type === header.type) {
        if (header.type !== 'moov' || !existing.canonicalBytes || !this.equalBytes(existing.canonicalBytes, bytes)) {
          throw new ScanFailure('invalid-structure');
        }
        return;
      }
    }
    const previous = this.ranges[index - 1];
    if ((previous && previous.end > absoluteOffset) || (existing && existing.start < absoluteOffset + header.size)) {
      throw new ScanFailure('invalid-structure');
    }

    const existingIds = new Set(this.tracks.keys());
    const delta = scanMetadataBox(bytes, this.options, existingIds);
    const visitedBoxes = checkedAdd(this.visitedBoxes, delta.visitedBoxes);
    if (visitedBoxes > this.options.maxVisitedBoxes) throw new ScanFailure('resource-limit');
    if (header.type === 'moov') {
      if (this.tracks.size > 0 || delta.tracks.length === 0) throw new ScanFailure('invalid-structure');
      for (const track of delta.tracks) this.tracks.set(track.id!, track);
      this.fragmentedInit = delta.hasMvex;
    } else if (delta.tracks.length > 0) {
      throw new ScanFailure('invalid-structure');
    }

    for (const fragment of delta.fragments) {
      const track = fragment.trackId === null ? undefined : this.tracks.get(fragment.trackId);
      if (!track) throw new ScanFailure('unsupported-structure');
      track.fragmentSamples = checkedAdd(track.fragmentSamples, fragment.samples);
      this.hasFragmentSamples ||= fragment.samples > 0;
    }
    this.declaredSamples = checkedAdd(this.declaredSamples, checkedAdd(delta.tableSamples, delta.fragmentSamples));
    this.auxiliaryEntries = checkedAdd(this.auxiliaryEntries, delta.auxiliaryEntries);
    this.additionalAuxiliaryUnits = checkedAdd(this.additionalAuxiliaryUnits, delta.additionalAuxiliaryUnits);
    this.perSampleFields = checkedAdd(this.perSampleFields, delta.perSampleFields);
    this.visitedBoxes = visitedBoxes;
    this.metadataBytes = checkedAdd(this.metadataBytes, delta.metadataBytes);
    this.hasClassicSamples ||= delta.tableSamples > 0;
    if (this.metadataBytes > this.options.maxMetadataBytes) throw new ScanFailure('resource-limit');
    const canonicalBytes = header.type === 'moov' ? bytes.slice() : undefined;
    this.addRange({
      start: absoluteOffset,
      end: absoluteOffset + header.size,
      type: header.type,
      ...(canonicalBytes ? { canonicalBytes } : {}),
    });
    if (canonicalBytes) this.canonicalRetainedBytes = checkedAdd(this.canonicalRetainedBytes, canonicalBytes.byteLength);
  }

  private compareKnownMoov(range: TopLevelRange, bytes: Uint8Array<ArrayBuffer>, start: number, end: number, inputStart: number, canonical: boolean): void {
    if (canonical || !range.canonicalBytes) return;
    const expected = range.canonicalBytes;
    const expectedOffset = start - range.start;
    const actualOffset = start - inputStart;
    const length = end - start;
    for (let index = 0; index < length; index++) {
      if (bytes[actualOffset + index] !== expected[expectedOffset + index]) throw new ScanFailure('invalid-structure');
    }
  }

  private equalBytes(left: Uint8Array<ArrayBuffer>, right: Uint8Array<ArrayBuffer>): boolean {
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
    return true;
  }

  private findCoveringRange(offset: number): TopLevelRange | undefined {
    const index = this.rangeIndex(offset + 1) - 1;
    const range = this.ranges[index];
    return range && range.start <= offset && offset < range.end ? range : undefined;
  }

  private isFullyCovered(start: number, end: number): boolean {
    let cursor = start;
    while (cursor < end) {
      const range = this.findCoveringRange(cursor);
      if (!range) return false;
      cursor = Math.min(end, range.end);
    }
    return true;
  }

  private rangeIndex(start: number): number {
    let low = 0;
    let high = this.ranges.length;
    while (low < high) {
      const middle = low + ((high - low) >>> 1);
      if (this.ranges[middle].start < start) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private recordOpaqueTopLevel(header: BoxHeader, absoluteOffset: number): void {
    const end = checkedEnd(absoluteOffset, header.size);
    if (header.type === 'mdat') {
      this.addVisited(1);
      this.addRange({ start: absoluteOffset, end, type: header.type });
      return;
    }
    if (!OPAQUE_TOP_LEVEL_BOXES.has(header.type)) throw new ScanFailure('unsupported-structure');
    if (header.size > this.options.maxMetadataBoxBytes) throw new ScanFailure('resource-limit');
    const metadataBytes = checkedAdd(this.metadataBytes, header.size);
    if (metadataBytes > this.options.maxMetadataBytes) throw new ScanFailure('resource-limit');
    this.addVisited(1);
    this.addRange({ start: absoluteOffset, end, type: header.type });
    this.metadataBytes = metadataBytes;
  }

  private addRange(range: TopLevelRange): void {
    const index = this.rangeIndex(range.start);
    const previous = this.ranges[index - 1];
    const next = this.ranges[index];
    if ((previous && previous.end > range.start) || (next && next.start < range.end)) {
      throw new ScanFailure('invalid-structure');
    }
    if (index === this.ranges.length) this.ranges.push(range);
    else this.ranges.splice(index, 0, range);
  }

  private addVisited(count: number): void {
    this.visitedBoxes = checkedAdd(this.visitedBoxes, count);
    if (this.visitedBoxes > this.options.maxVisitedBoxes) throw new ScanFailure('resource-limit');
  }

  private checkBudget(): void {
    if (this.hasClassicSamples && (this.hasFragmentSamples || this.fragmentedInit)) throw new ScanFailure('unsupported-structure');
    const mode: Mp4ResourceMode = this.hasFragmentSamples || this.fragmentedInit ? 'fragmented' : this.hasClassicSamples ? 'classic' : 'unknown';
    const conservativeMode = mode === 'classic' ? 'classic' : 'fragmented';
    const auxiliaryUnits = checkedAdd(
      checkedAdd(this.auxiliaryEntries, this.perSampleFields),
      checkedAdd(checkedMultiply(this.visitedBoxes, AUXILIARY_UNITS_PER_VISITED_BOX), this.additionalAuxiliaryUnits),
    );
    const estimate = Math.max(this.previousEstimate, estimateBytes(this.declaredSamples, auxiliaryUnits, this.metadataBytes, conservativeMode));
    this.previousEstimate = estimate;
    if (estimate > this.options.perParserBudgetBytes) throw new ScanFailure('resource-limit');
  }

  private snapshot(): Mp4ResourceSnapshot {
    const mode: Mp4ResourceMode = this.hasClassicSamples && (this.hasFragmentSamples || this.fragmentedInit)
      ? 'unknown'
      : this.hasFragmentSamples || this.fragmentedInit
        ? 'fragmented'
        : this.hasClassicSamples
          ? 'classic'
          : 'unknown';
    return {
      declaredSamples: this.declaredSamples,
      auxiliaryUnits: checkedAdd(
        checkedAdd(this.auxiliaryEntries, this.perSampleFields),
        checkedAdd(checkedMultiply(this.visitedBoxes, AUXILIARY_UNITS_PER_VISITED_BOX), this.additionalAuxiliaryUnits),
      ),
      metadataBytes: this.metadataBytes,
      visitedBoxes: this.visitedBoxes,
      estimatedBytes: this.previousEstimate,
      mode,
    };
  }

  private result(decision: 'append' | 'reject', complete: boolean, reason: Mp4ResourceFailure | null): Mp4ResourceInspection {
    const pendingBytes = (this.pendingMetadata?.byteLength ?? 0) + (this.pendingHeader?.byteLength ?? 0);
    return {
      decision,
      complete,
      pendingBytes,
      retainedBytes: pendingBytes + this.canonicalRetainedBytes,
      usage: this.snapshot(),
      ...(reason ? { reason } : {}),
    };
  }
}

export function createMp4ResourceGuard(options: Partial<Mp4ResourceGuardOptions> = {}): Mp4ResourceGuard {
  return new ResourceGuard(options);
}

export const MP4_RESOURCE_GUARD_DEFAULTS = Object.freeze({
  perParserBudgetBytes: DEFAULT_PER_PARSER_BUDGET,
  aggregateBudgetBytes: DEFAULT_MAX_AGGREGATE_BUDGET,
  maxMetadataBoxBytes: DEFAULT_MAX_METADATA_BOX_BYTES,
  maxMetadataBytes: DEFAULT_MAX_METADATA_BYTES,
  maxVisitedBoxes: DEFAULT_MAX_VISITED_BOXES,
});
