import { BoxParser } from 'mp4box';
import {
  createMp4ResourceGuard,
  MP4_RESOURCE_GUARD_DEFAULTS,
  type Mp4ResourceGuardOptions,
} from './stream-transmux-resource-guard';

type Bytes = Uint8Array<ArrayBuffer>;

const view32 = (value: number): Bytes => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};

function join(...parts: Bytes[]): Bytes {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function box(type: string, payload: Bytes = new Uint8Array()): Bytes {
  return join(view32(payload.byteLength + 8), new Uint8Array([...type].map((character) => character.charCodeAt(0) & 0xff)), payload);
}

function ftyp(): Bytes {
  return box('ftyp', join(new TextEncoder().encode('isom'), view32(0)));
}

function fullBox(type: string, payload: Bytes = new Uint8Array(), version = 0, flags = 0): Bytes {
  const header = new Uint8Array(4);
  header[0] = version;
  header[1] = (flags >>> 16) & 0xff;
  header[2] = (flags >>> 8) & 0xff;
  header[3] = flags & 0xff;
  return box(type, join(header, payload));
}

function handlerPayload(handler: string, name = new Uint8Array(), version = 0, flags = 0): Bytes {
  const payload = new Uint8Array(24 + name.byteLength);
  payload[0] = version;
  payload[1] = (flags >>> 16) & 0xff;
  payload[2] = (flags >>> 8) & 0xff;
  payload[3] = flags & 0xff;
  payload.set(new TextEncoder().encode(handler), 8);
  payload.set(name, 24);
  return payload;
}

function largeSizeBox(bytes: Bytes): Bytes {
  const result = new Uint8Array(bytes.byteLength + 8);
  const view = new DataView(result.buffer);
  view.setUint32(0, 1);
  result.set(bytes.subarray(4, 8), 4);
  view.setBigUint64(8, BigInt(result.byteLength));
  result.set(bytes.subarray(8), 16);
  return result;
}

function stsz(count: number, fixedSize = 1, declaredTableBytes?: number): Bytes {
  const payload = join(view32(fixedSize), view32(count));
  if (fixedSize === 0) {
    const table = new Uint8Array(declaredTableBytes ?? count * 4);
    return fullBox('stsz', join(payload, table));
  }
  return fullBox('stsz', payload);
}

function stz2(count: number, fieldSize = 4): Bytes {
  const fixed = new Uint8Array(8);
  fixed[3] = fieldSize;
  new DataView(fixed.buffer).setUint32(4, count);
  return fullBox('stz2', join(fixed, new Uint8Array(Math.ceil((count * fieldSize) / 8))));
}

function track(
  id: number,
  samples: Bytes,
  handler: 'vide' | 'soun' | 'meta' = 'vide',
  entryChildren: Bytes = new Uint8Array(),
  minfChildren: Bytes = new Uint8Array(),
  mdiaChildren: Bytes = new Uint8Array(),
  sampleEntryType = handler === 'soun' ? 'mp4a' : 'avc1',
  hdlrBoxOverride?: Bytes,
): Bytes {
  const tkhd = new Uint8Array(20);
  new DataView(tkhd.buffer).setUint32(8, id);
  const hdlr = new Uint8Array(24);
  hdlr.set(new TextEncoder().encode(handler), 8);
  const entry = box(sampleEntryType, join(new Uint8Array(sampleEntryType === 'avc1' ? 78 : sampleEntryType === 'mp4a' ? 28 : 0), entryChildren));
  const stbl = box('stbl', join(fullBox('stsd', join(view32(1), entry)), samples));
  const minf = box('minf', join(box(handler === 'soun' ? 'smhd' : 'vmhd', new Uint8Array(8)), minfChildren, stbl));
  const mdia = box('mdia', join(hdlrBoxOverride ?? box('hdlr', hdlr), mdiaChildren, minf));
  return box('trak', join(fullBox('tkhd', tkhd), mdia));
}

function moov(
  samples: Bytes[],
  ids = samples.map((_, index) => index + 1),
  fragmented = false,
  handlers?: ('vide' | 'soun' | 'meta')[],
  entryChildren = new Uint8Array(),
  minfChildren = new Uint8Array(),
  mdiaChildren = new Uint8Array(),
  sampleEntryTypes?: string[],
  hdlrBoxes?: Bytes[],
): Bytes {
  const tracks = samples.map((table, index) => track(
    ids[index], table, handlers?.[index] ?? 'vide', entryChildren, minfChildren,
    mdiaChildren, sampleEntryTypes?.[index], hdlrBoxes?.[index],
  ));
  const mvex = fragmented ? box('mvex') : new Uint8Array();
  return box('moov', join(fullBox('mvhd', new Uint8Array(16)), ...tracks, mvex));
}

function trun(count: number, perSampleFields = 0, physicalCount = count): Bytes {
  const fieldFlags = [0x100, 0x200, 0x400, 0x800].slice(0, perSampleFields);
  const flags = fieldFlags.reduce((sum, flag) => sum | flag, 0);
  const fixed = join(view32(count), new Uint8Array(physicalCount * perSampleFields * 4));
  return fullBox('trun', fixed, 0, flags);
}

function fragmented(samples: number[]): Bytes {
  const init = moov([stsz(0)], [1], true);
  const fragments = samples.map((count) => box('moof', box('traf', join(fullBox('tfhd', view32(1)), trun(count)))));
  return join(init, ...fragments);
}

function buffer(bytes: Bytes): ArrayBuffer {
  return bytes.slice().buffer;
}

function makeGuard(overrides: Partial<Mp4ResourceGuardOptions> = {}) {
  return createMp4ResourceGuard(overrides);
}

function inspect(bytes: Bytes, offset = 0, options: { final?: boolean; supplemental?: boolean; canonical?: boolean } = {}) {
  return makeGuard().inspect(buffer(bytes), offset, options);
}

describe('stream-transmux-resource-guard (B89-R2A)', () => {
  it('matches the ratified classic and fragmented estimator coefficients and Policy C budgets', () => {
    const classic = createMp4ResourceGuard().inspect(buffer(join(ftyp(), moov([stsz(7)]))), 0, { final: true });
    expect(classic.decision).toBe('append');
    expect(classic.usage.mode).toBe('classic');
    expect(classic.usage.estimatedBytes).toBe(Math.max(
      Math.ceil(1_885_267.7263535133 * 1.1),
      Math.ceil((
      627_543.8931219638
      + 336.86621068780363 * classic.usage.declaredSamples
      + 64 * classic.usage.auxiliaryUnits
      + classic.usage.metadataBytes
      ) * 1.1),
    ));

    const fragmentedResult = createMp4ResourceGuard().inspect(buffer(fragmented([7])), 0, { final: true });
    expect(fragmentedResult.decision).toBe('append');
    expect(fragmentedResult.usage.mode).toBe('fragmented');
    expect(fragmentedResult.usage.estimatedBytes).toBe(Math.ceil((
      1_885_267.7263535133
      + 204.19742736464866 * fragmentedResult.usage.declaredSamples
      + 64 * fragmentedResult.usage.auxiliaryUnits
      + fragmentedResult.usage.metadataBytes
    ) * 1.1));

    expect(MP4_RESOURCE_GUARD_DEFAULTS.perParserBudgetBytes).toBe(93_113_499);
    expect(MP4_RESOURCE_GUARD_DEFAULTS.aggregateBudgetBytes).toBe(279_340_497);
  });

  it('reserves the conservative unknown-parser base before metadata arrives', () => {
    const guard = makeGuard();
    const expected = Math.ceil(1_885_267.7263535133 * 1.1);
    expect(guard.usage.mode).toBe('unknown');
    expect(guard.usage.estimatedBytes).toBe(expected);
    const result = guard.inspect(buffer(ftyp()), 0);
    expect(result.decision).toBe('append');
    expect(result.usage.estimatedBytes).toBe(Math.ceil((1_885_267.7263535133 + 128 + ftyp().byteLength) * 1.1));
  });

  it('counts compatible brands in ftyp instead of treating them as a fixed-size box', () => {
    const brands = box('ftyp', join(new TextEncoder().encode('isom'), view32(0), new TextEncoder().encode('isommp42')));
    const result = inspect(brands, 0, { final: true });
    expect(result.decision).toBe('append');
    expect(result.usage.auxiliaryUnits).toBeGreaterThan(1);
    expect(result.usage.metadataBytes).toBe(brands.byteLength);
  });

  it('caps and accounts opaque top-level boxes before passing them to MP4Box', () => {
    const payload = new Uint8Array(8 * 1024 * 1024);
    const input = box('free', payload);
    const result = inspect(input, 0);
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('resource-limit');
  });

  it('fails closed on an unmodeled top-level box type', () => {
    const result = inspect(box('ssix', join(view32(1), view32(0), view32(1))), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('unsupported-structure');
  });

  it('rejects an unknown nested box instead of accepting it through scanner fallthrough', () => {
    const result = inspect(moov([join(stsz(1), box('zzzz'))]), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('unsupported-structure');
  });

  it('rejects a known parser box in the wrong container context', () => {
    const result = inspect(box('moov', stsz(1)), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('unsupported-structure');
  });

  it('rejects every registered sample-entry parser except avc1/mp4a before materialization', () => {
    const sampleEntries = Object.keys((BoxParser as any).sampleEntry) as string[];
    expect(sampleEntries.length).toBe(54);
    for (const type of sampleEntries) {
      const handler = type === 'mp4a' ? 'soun' : 'vide';
      const result = inspect(moov([stsz(1)], undefined, false, [handler], undefined, undefined, undefined, [type]), 0, { final: true });
      if (type === 'avc1' || type === 'mp4a') {
        expect(result.decision).withContext(`type=${type}`).toBe('append');
      } else {
        expect(result.decision).withContext(`type=${type}`).toBe('reject');
        expect(result.reason).withContext(`type=${type}`).toBe('unsupported-structure');
      }
    }
  });

  it('rejects every registered sample-group dispatch except the measured roll subset', () => {
    const groups = Object.keys((BoxParser as any).sampleGroupEntry) as string[];
    expect(groups.length).toBe(18);
    for (const group of groups) {
      const sgpd = fullBox('sgpd', join(new TextEncoder().encode(group), view32(1), new Uint8Array(2)));
      const result = inspect(moov([join(stsz(1), sgpd)]), 0, { final: true });
      if (group === 'roll') {
        expect(result.decision).withContext(`group=${group}`).toBe('append');
      } else {
        expect(result.decision).withContext(`group=${group}`).toBe('reject');
        expect(result.reason).withContext(`group=${group}`).toBe('unsupported-structure');
      }
    }
  });

  it('rejects avc1/mp4a sample entries mapped to the opposite track handler', () => {
    for (const [type, handler] of [['avc1', 'soun'], ['mp4a', 'vide']] as const) {
      const result = inspect(moov([stsz(1)], undefined, false, [handler], undefined, undefined, undefined, [type]), 0, { final: true });
      expect(result.decision).withContext(`${type} in ${handler}`).toBe('reject');
      expect(result.reason).withContext(`${type} in ${handler}`).toBe('unsupported-structure');
    }
  });

  it('rejects top-level, nested, and sample-entry UUID boxes before dynamic dispatch', () => {
    const uuid = (parent: string) => {
      const userType = new Uint8Array(16).fill(0x41);
      const value = box('uuid', join(userType, box('free')));
      if (parent === 'top-level') return value;
      if (parent === 'sample-entry') return moov([stsz(1)], undefined, false, undefined, value);
      return moov([join(stsz(1), value)]);
    };
    for (const parent of ['top-level', 'nested', 'sample-entry']) {
      const result = inspect(uuid(parent), 0, { final: true });
      expect(result.decision).withContext(parent).toBe('reject');
      expect(result.reason).withContext(parent).toBe('unsupported-structure');
    }
  });

  it('rejects unknown sample-entry children before MP4Box can dispatch them', () => {
    const result = inspect(moov([stsz(1)], undefined, false, undefined, box('zzzz')), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('unsupported-structure');
  });

  it('admits only a short, valid elng language tag in mdia and budgets its parser allocation', () => {
    const baseline = inspect(moov([stsz(1)]), 0, { final: true });
    const languageTag = fullBox('elng', new TextEncoder().encode('fr-FR'));
    const accepted = inspect(moov([stsz(1)], undefined, false, undefined, undefined, undefined, languageTag), 0, { final: true });
    expect(accepted.decision).toBe('append');
    expect(accepted.usage.auxiliaryUnits - baseline.usage.auxiliaryUnits).toBe(8);

    const wrongParent = inspect(moov([stsz(1)], undefined, false, undefined, undefined, languageTag), 0, { final: true });
    expect(wrongParent.decision).toBe('reject');
    expect(wrongParent.reason).toBe('unsupported-structure');

    const tooLong = fullBox('elng', new TextEncoder().encode('a'.repeat(64)));
    const oversized = inspect(moov([stsz(1)], undefined, false, undefined, undefined, undefined, tooLong), 0, { final: true });
    expect(oversized.decision).toBe('reject');
    expect(oversized.reason).toBe('unsupported-structure');
  });

  it('rejects an expanding registered child inside dref rather than trusting its entry count alone', () => {
    const nestedExpansion = box('subs', join(view32(1), view32(1), new Uint8Array(2)));
    const dref = fullBox('dref', join(view32(1), nestedExpansion));
    const result = inspect(moov([stsz(1)], undefined, false, undefined, new Uint8Array(), box('dinf', dref)), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('unsupported-structure');
  });

  it('rejects non-self-contained and multiple data references', () => {
    const externalUrl = fullBox('url ', new TextEncoder().encode('https://invalid.example/'), 0, 0);
    const externalDinf = box('dinf', fullBox('dref', join(view32(1), externalUrl)));
    const external = inspect(moov([stsz(1)], undefined, false, undefined, new Uint8Array(), externalDinf), 0, { final: true });
    expect(external.decision).toBe('reject');
    expect(external.reason).toBe('unsupported-structure');

    const url = fullBox('url ', new Uint8Array(), 0, 1);
    const duplicateDinf = box('dinf', fullBox('dref', join(view32(2), url, url)));
    const duplicated = inspect(moov([stsz(1)], undefined, false, undefined, new Uint8Array(), duplicateDinf), 0, { final: true });
    expect(duplicated.decision).toBe('reject');
    expect(duplicated.reason).toBe('resource-limit');
  });

  it('accepts only the exact self-contained dref grammar under minf/dinf', () => {
    const url = (flags = 1, version = 0, payload = new Uint8Array()) => fullBox('url ', payload, version, flags);
    const dref = (count: number, ...entries: Bytes[]) => fullBox('dref', join(view32(count), ...entries));
    const withinDinf = (value: Bytes) => moov([stsz(1)], undefined, false, undefined, undefined, box('dinf', value));
    const valid = inspect(withinDinf(dref(1, url())), 0, { final: true });
    expect(valid.decision).toBe('append');

    const urn = box('urn ', new TextEncoder().encode('name'));
    const cases: Array<{ label: string; bytes: Bytes }> = [
      { label: 'zero count', bytes: withinDinf(dref(0)) },
      { label: 'count two', bytes: withinDinf(dref(2, url(), url())) },
      { label: 'one count with two entries', bytes: withinDinf(dref(1, url(), url())) },
      { label: 'count mismatch', bytes: withinDinf(dref(2, url())) },
      { label: 'urn entry', bytes: withinDinf(dref(1, urn)) },
      { label: 'external URL flags', bytes: withinDinf(dref(1, url(0, 0, new TextEncoder().encode('external')))) },
      { label: 'URL version one', bytes: withinDinf(dref(1, url(1, 1))) },
      { label: 'trailing dref bytes', bytes: withinDinf(dref(1, url(), new Uint8Array([1]))) },
      { label: 'dref outside dinf', bytes: moov([stsz(1)], undefined, false, undefined, undefined, dref(1, url())) },
      { label: 'dinf outside minf', bytes: moov([stsz(1)], undefined, false, undefined, undefined, undefined, box('dinf', dref(1, url()))) },
      { label: 'unknown entry', bytes: withinDinf(dref(1, box('zzzz'))) },
    ];
    for (const item of cases) {
      const result = inspect(item.bytes, 0, { final: true });
      expect(result.decision).withContext(item.label).toBe('reject');
    }
  });

  it('rejects unknown top-level types with ordinary, zero-to-end, and extended-size headers', () => {
    const unknown = box('zzzz');
    const sizeZero = unknown.slice();
    new DataView(sizeZero.buffer).setUint32(0, 0);
    const extended = new Uint8Array(16);
    const extendedView = new DataView(extended.buffer);
    extendedView.setUint32(0, 1);
    extended.set(new TextEncoder().encode('zzzz'), 4);
    extendedView.setBigUint64(8, 16n);
    for (const [label, bytes] of [['ordinary', unknown], ['size-zero', sizeZero], ['largesize', extended]] as const) {
      const result = inspect(bytes, 0, { final: true });
      expect(result.decision).withContext(label).toBe('reject');
      expect(result.reason).withContext(label).toBe('unsupported-structure');
    }
  });

  it('caps compatible brands before MP4Box materializes the brand list', () => {
    const compatibleBrands = new Uint8Array(65 * 4);
    const input = box('ftyp', join(new TextEncoder().encode('isom'), view32(0), compatibleBrands));
    const result = inspect(input, 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('resource-limit');
  });

  it('reads the real sidx reference_count field for both supported versions', () => {
    const version0 = fullBox('sidx', join(
      view32(1), view32(1), view32(0), view32(0), new Uint8Array(2), new Uint8Array([0, 1]), new Uint8Array(12),
    ));
    const acceptedV0 = inspect(version0, 0, { final: true });
    expect(acceptedV0.decision).toBe('append');
    expect(acceptedV0.usage.auxiliaryUnits).toBe(4);

    const version1 = fullBox('sidx', join(
      view32(1), view32(1), new Uint8Array(8), new Uint8Array(8), new Uint8Array(2), new Uint8Array([0, 1]), new Uint8Array(12),
    ), 1);
    expect(inspect(version1, 0, { final: true }).decision).toBe('append');
    const truncated = inspect(fullBox('sidx', join(
      view32(1), view32(1), view32(0), view32(0), new Uint8Array(2), new Uint8Array([0, 1]),
    )), 0, { final: true });
    expect(truncated.decision).toBe('reject');
    expect(truncated.reason).toBe('invalid-structure');
  });

  it('applies probe-derived extra auxiliary units to materialized parser entries and trun arrays', () => {
    const baseline = inspect(moov([stsz(1)]), 0, { final: true });
    const sbgp = fullBox('sbgp', join(new TextEncoder().encode('roll'), view32(1), view32(1), view32(1)));
    const measuredSbgp = inspect(moov([join(stsz(1), sbgp)]), 0, { final: true });
    expect(measuredSbgp.usage.auxiliaryUnits - baseline.usage.auxiliaryUnits).toBe(9);

    const avcConfiguration = (parameterSets: Bytes) => box('avcC', parameterSets);
    const avcPrefix = new Uint8Array([1, 66, 0, 30, 0xff]);
    const noParameterSets = avcConfiguration(join(avcPrefix, new Uint8Array([0, 0])));
    const oneSps = avcConfiguration(join(avcPrefix, new Uint8Array([1, 0, 1, 0x67, 0])));
    const avcBaseline = inspect(moov([stsz(1)], undefined, false, undefined, noParameterSets), 0, { final: true });
    const avcMeasured = inspect(moov([stsz(1)], undefined, false, undefined, oneSps), 0, { final: true });
    expect(avcMeasured.usage.auxiliaryUnits - avcBaseline.usage.auxiliaryUnits).toBe(6);

    const fragmentedInit = moov([stsz(0)], [1], true);
    const fragment = (fieldCount: number) => box('moof', box('traf', join(fullBox('tfhd', view32(1)), trun(1, fieldCount))));
    const noOptionalFields = inspect(join(fragmentedInit, fragment(0)), 0, { final: true });
    const oneOptionalField = inspect(join(fragmentedInit, fragment(1)), 0, { final: true });
    expect(oneOptionalField.usage.auxiliaryUnits - noOptionalFields.usage.auxiliaryUnits).toBe(3);
  });

  it('applies the calibrated co64 per-entry charge', () => {
    const table = (count: number) => fullBox('co64', join(view32(count), new Uint8Array(count * 8)));
    const empty = inspect(moov([join(stsz(1), table(0))]), 0, { final: true });
    const oneEntry = inspect(moov([join(stsz(1), table(1))]), 0, { final: true });
    expect(empty.decision).toBe('append');
    expect(oneEntry.decision).toBe('append');
    expect(oneEntry.usage.auxiliaryUnits - empty.usage.auxiliaryUnits).toBe(7);
  });

  it('rejects unknown sample-group parsers even when a fixed entry width is declared', () => {
    const sgpd = fullBox('sgpd', join(new TextEncoder().encode('rash'), view32(4), view32(1), view32(0)), 1);
    const result = inspect(moov([join(stsz(1), sgpd)]), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('unsupported-structure');
  });

  it('weights MP4Box 2.4.1 sample-group entries above the generic auxiliary charge', () => {
    const baseline = inspect(moov([stsz(1)]), 0, { final: true });
    const count = 3;
    const entries = new Uint8Array(count * 2);
    const sgpd = fullBox('sgpd', join(new TextEncoder().encode('roll'), view32(count), entries));
    const measured = inspect(moov([join(stsz(1), sgpd)]), 0, { final: true });
    expect(measured.decision).toBe('append');
    expect(measured.usage.auxiliaryUnits - baseline.usage.auxiliaryUnits).toBe(count * 11 + 2);
  });

  it('rejects sgpd version 2 because MP4Box 2.4.1 does not materialize its entries correctly', () => {
    const sgpd = fullBox('sgpd', join(new TextEncoder().encode('roll'), view32(2), view32(0), view32(1), view32(2), new Uint8Array(2)), 2);
    const result = inspect(moov([join(stsz(1), sgpd)]), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('unsupported-structure');
  });

  it('weights sample-description objects and each visited MP4Box box in the pre-parser estimate', () => {
    const result = inspect(join(ftyp(), moov([stsz(1)])), 0, { final: true });
    expect(result.decision).toBe('append');
    expect(result.usage.auxiliaryUnits).toBe(18 + 2 * result.usage.visitedBoxes);
  });

  it('R2A-001 rejects a uniform-size stsz count before parser expansion', () => {
    const result = makeGuard({ perParserBudgetBytes: 2_000_000 }).inspect(buffer(moov([stsz(10_000_000)])), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('resource-limit');
  });

  it('R2A-002 rejects variable-size stsz with missing entries', () => {
    const result = inspect(moov([stsz(2, 0, 4)]), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('invalid-structure');
  });

  it('R2A-003 accounts the installed MP4Box stz2 expanding parser', () => {
    const result = makeGuard({ perParserBudgetBytes: 2_000_000 }).inspect(buffer(moov([stz2(10_000_000)])), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('resource-limit');
  });

  it('R2A-004 rejects an abusive trun sample_count', () => {
    const result = makeGuard({ perParserBudgetBytes: 2_000_000 }).inspect(buffer(fragmented([10_000_000])), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('resource-limit');
  });

  it('R2A-005 rejects trun fields whose physical length disagrees with flags', () => {
    const result = inspect(join(moov([stsz(0)], [1], true), box('moof', box('traf', join(fullBox('tfhd', view32(1)), trun(2, 2, 1))))), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('invalid-structure');
  });

  it('R2A-006 accumulates multiple trun sample counts across fragments', () => {
    const result = makeGuard({ perParserBudgetBytes: 4_500_000 }).inspect(buffer(fragmented([10_000, 10_000])), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.usage.declaredSamples).toBeGreaterThan(10_000);
  });

  it('R2A-007 combines sample counts from multiple tracks', () => {
    const result = makeGuard({ perParserBudgetBytes: 5_000_000 }).inspect(buffer(moov([stsz(10_000), stsz(10_000)])), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.usage.declaredSamples).toBe(20_000);
  });

  it('R2A-008 carries a split ordinary box header across chunks', () => {
    const source = box('ftyp', new Uint8Array(8));
    const guard = makeGuard();
    expect(guard.inspect(buffer(source.subarray(0, 3)), 0).decision).toBe('append');
    expect(guard.inspect(buffer(source.subarray(3)), 3, { final: true }).decision).toBe('append');
  });

  it('R2A-009 handles a split largesize header without confusing incompleteness with corruption', () => {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 1);
    bytes.set(new TextEncoder().encode('free'), 4);
    view.setBigUint64(8, 16n);
    const guard = makeGuard();
    expect(guard.inspect(buffer(bytes.subarray(0, 11)), 0).decision).toBe('append');
    expect(guard.inspect(buffer(bytes.subarray(11)), 11, { final: true }).decision).toBe('append');
  });

  it('R2A-010 handles a split FullBox prefix', () => {
    const bytes = moov([stsz(1)]);
    const split = 8 + 8 + 4 + 8 + 2;
    const guard = makeGuard();
    expect(guard.inspect(buffer(bytes.subarray(0, split)), 0).decision).toBe('append');
    expect(guard.inspect(buffer(bytes.subarray(split)), split, { final: true }).decision).toBe('append');
    expect(guard.usage.declaredSamples).toBe(1);
  });

  it('R2A-011 handles stsz sample_count split across chunks', () => {
    const bytes = moov([stsz(4)]);
    const split = 8 + 8 + 4 + 2;
    const guard = makeGuard();
    expect(guard.inspect(buffer(bytes.subarray(0, split)), 0).decision).toBe('append');
    expect(guard.inspect(buffer(bytes.subarray(split)), split, { final: true }).decision).toBe('append');
    expect(guard.usage.declaredSamples).toBe(4);
  });

  it('R2A-012 handles trun sample_count split across chunks', () => {
    const bytes = fragmented([3]);
    const split = bytes.byteLength - 6;
    const guard = makeGuard();
    expect(guard.inspect(buffer(bytes.subarray(0, split)), 0).decision).toBe('append');
    expect(guard.inspect(buffer(bytes.subarray(split)), split, { final: true }).decision).toBe('append');
    expect(guard.usage.declaredSamples).toBe(3);
  });

  it('R2A-013 accepts a complete initial moov', () => {
    const result = inspect(moov([stsz(100)]), 0, { final: true, canonical: true });
    expect(result.decision).toBe('append');
    expect(result.usage.mode).toBe('classic');
  });

  it('R2A-014 accepts moov bytes split across contiguous chunks with bounded retention', () => {
    const bytes = moov([stsz(100)]);
    const split = Math.floor(bytes.byteLength / 2);
    const guard = makeGuard();
    const partial = guard.inspect(buffer(bytes.subarray(0, split)), 0, { canonical: true });
    expect(partial.decision).toBe('append');
    expect(partial.retainedBytes).toBe(split);
    const completed = guard.inspect(buffer(bytes.subarray(split)), split, { final: true, canonical: true });
    expect(completed.decision).toBe('append');
    expect(completed.pendingBytes).toBe(0);
    expect(completed.retainedBytes).toBe(bytes.byteLength);
    expect(completed.usage.declaredSamples).toBe(100);
  });

  it('R2A-015 accepts a separately supplied complete moov at its absolute offset', () => {
    const result = inspect(moov([stsz(100)]), 8_000_000, { supplemental: true, canonical: true });
    expect(result.decision).toBe('append');
    expect(result.usage.metadataBytes).toBeGreaterThan(0);
  });

  it('R2A-016 cumulatively accounts sequential moof boxes', () => {
    const result = inspect(fragmented([20, 30]), 0, { final: true });
    expect(result.decision).toBe('append');
    expect(result.usage.mode).toBe('fragmented');
    expect(result.usage.declaredSamples).toBe(50);
  });

  it('R2A-017 skips mdat payload signatures without scanning them as boxes', () => {
    const payload = join(new TextEncoder().encode('moovmooftrun'), new Uint8Array(64));
    const result = inspect(join(box('mdat', payload), moov([stsz(1)])), 0, { final: true });
    expect(result.decision).toBe('append');
    expect(result.usage.declaredSamples).toBe(1);
  });

  it('R2A-018 rejects a box size smaller than its header', () => {
    const bytes = join(view32(4), new TextEncoder().encode('free'));
    expect(inspect(bytes, 0, { final: true }).reason).toBe('invalid-structure');
  });

  it('R2A-019 rejects an invalid largesize', () => {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 1);
    bytes.set(new TextEncoder().encode('moov'), 4);
    view.setBigUint64(8, 0xffff_ffff_ffff_ffffn);
    expect(inspect(bytes, 0, { final: true }).reason).toBe('invalid-structure');
  });

  it('R2A-020 rejects absolute-offset overflow', () => {
    expect(inspect(box('free'), Number.MAX_SAFE_INTEGER - 3).reason).toBe('invalid-structure');
  });

  it('R2A-021 rejects partial metadata at EOF before flush', () => {
    const bytes = moov([stsz(100)]);
    const guard = makeGuard();
    const result = guard.inspect(buffer(bytes.subarray(0, bytes.byteLength - 1)), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('invalid-structure');
  });

  it('R2A-022 fails closed on an installed expanding structure not modeled by the estimator', () => {
    const result = inspect(moov([join(stsz(1), fullBox('subs', join(view32(1), view32(1), new Uint8Array(2))))]), 0, { final: true });
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('unsupported-structure');
  });

  it('R2A-023 fails closed for a track handler outside the characterized media set', () => {
    const result = inspect(moov([stsz(1)], [1], false, ['meta']), 0, { final: true });
    expect(result.reason).toBe('unsupported-structure');
  });

  it('R2A-024 rejects duplicate track IDs', () => {
    const result = inspect(moov([stsz(1), stsz(1)], [1, 1]), 0, { final: true });
    expect(result.reason).toBe('invalid-structure');
  });

  it('R2A-025 deduplicates an identical moov range within one parser', () => {
    const bytes = moov([stsz(10)]);
    const guard = makeGuard();
    const first = guard.inspect(buffer(bytes), 0, { final: true, canonical: true });
    const second = guard.inspect(buffer(bytes), 0, { final: true });
    expect(first.decision).toBe('append');
    expect(second.decision).toBe('append');
    expect(second.usage.estimatedBytes).toBe(first.usage.estimatedBytes);
  });

  it('R2A-026 accounts the same moov independently in a new parser', () => {
    const bytes = moov([stsz(10)]);
    const first = makeGuard().inspect(buffer(bytes), 0, { final: true, canonical: true });
    const second = makeGuard().inspect(buffer(bytes), 0, { final: true, canonical: true });
    expect(second.usage.estimatedBytes).toBe(first.usage.estimatedBytes);
  });

  it('R2A-027 permits a cost exactly at the configured budget', () => {
    const bytes = moov([stsz(10)]);
    const estimate = makeGuard().inspect(buffer(bytes), 0, { final: true }).usage.estimatedBytes;
    const result = makeGuard({ perParserBudgetBytes: estimate }).inspect(buffer(bytes), 0, { final: true });
    expect(result.decision).toBe('append');
  });

  it('R2A-028 rejects a cost one byte above the configured budget', () => {
    const bytes = moov([stsz(10)]);
    const estimate = makeGuard().inspect(buffer(bytes), 0, { final: true }).usage.estimatedBytes;
    const result = makeGuard({ perParserBudgetBytes: estimate - 1 }).inspect(buffer(bytes), 0, { final: true });
    expect(result.reason).toBe('resource-limit');
  });

  it('R2A-029 rejects huge sample declarations using constant-size metadata', () => {
    const bytes = moov([stsz(0xffff_ffff)]);
    const started = performance.now();
    const result = makeGuard({ perParserBudgetBytes: 2_000_000 }).inspect(buffer(bytes), 0, { final: true });
    expect(result.reason).toBe('resource-limit');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('R2A-030 enforces the visited-box limit', () => {
    const result = makeGuard({ maxVisitedBoxes: 2 }).inspect(buffer(moov([stsz(1)])), 0, { final: true });
    expect(result.reason).toBe('resource-limit');
  });

  it('enforces the visited-box limit cumulatively across separate fragments', () => {
    const init = moov([stsz(0)], [1], true);
    const baseline = inspect(init, 0, { final: true }).usage.visitedBoxes;
    const guard = makeGuard({ maxVisitedBoxes: baseline + 3 });
    expect(guard.inspect(buffer(init), 0).decision).toBe('append');
    const fragment = box('moof', box('traf', join(fullBox('tfhd', view32(1)), trun(0))));
    expect(guard.inspect(buffer(fragment), init.byteLength).reason).toBe('resource-limit');
  });

  it('R2A-031 enforces the metadata nesting limit', () => {
    const result = makeGuard({ maxDepth: 3 }).inspect(buffer(moov([stsz(1)])), 0, { final: true });
    expect(result.reason).toBe('resource-limit');
  });

  it('R2A-032 enforces bounded incomplete metadata retention', () => {
    const data = new Uint8Array(128);
    new DataView(data.buffer).setUint32(0, 1024);
    data.set(new TextEncoder().encode('moov'), 4);
    const result = makeGuard({ maxMetadataBoxBytes: 64 }).inspect(buffer(data), 0);
    expect(result.reason).toBe('resource-limit');
  });

  it('R2A-033 supports an out-of-order supplemental moov without joining file ranges', () => {
    const guard = makeGuard();
    expect(guard.inspect(buffer(ftyp()), 0).decision).toBe('append');
    const result = guard.inspect(buffer(moov([stsz(1)])), 9_000_000, { supplemental: true, canonical: true });
    expect(result.decision).toBe('append');
  });

  it('R2A-034 rejects overlapping non-identical structural ranges', () => {
    const guard = makeGuard();
    guard.inspect(buffer(moov([stsz(1)])), 0, { final: true, canonical: true });
    const result = guard.inspect(buffer(moov([stsz(2)])), 0, { final: true });
    expect(result.reason).toBe('invalid-structure');
  });

  it('rejects an out-of-order input that overlaps a known range and extends beyond it', () => {
    const guard = makeGuard();
    const mdat = box('mdat', new Uint8Array(16));
    expect(guard.inspect(buffer(mdat), 0).decision).toBe('append');
    const partialOverlap = new Uint8Array(20).buffer;
    expect(guard.inspect(partialOverlap, 8).reason).toBe('invalid-structure');
  });

  it('R2A-035 accepts characterized video and audio tracks', () => {
    const result = inspect(moov([stsz(100), stsz(200)], [1, 2], false, ['vide', 'soun']), 0, { final: true });
    expect(result.decision).toBe('append');
    expect(result.usage.declaredSamples).toBe(300);
  });

  it('counts bounded QuickTime ilst entries instead of rejecting valid track metadata', () => {
    const item = box('©too', box('data', join(view32(1), view32(0), new TextEncoder().encode('Lavf'))));
    const metadata = box('udta', box('meta', join(new Uint8Array(4), box('ilst', item))));
    const bytes = box('moov', join(fullBox('mvhd', new Uint8Array(16)), track(1, stsz(1)), metadata));
    const result = inspect(bytes, 0, { final: true });
    expect(result.decision).toBe('append');
    expect(result.reason).toBeUndefined();
    expect(result.usage.visitedBoxes).toBeGreaterThan(10);
  });

  it('R2A-036 accepts characterized multitrack input without an arbitrary track cap', () => {
    const result = inspect(moov([stsz(10), stsz(20), stsz(30)], [1, 2, 3]), 0, { final: true });
    expect(result.decision).toBe('append');
    expect(result.usage.declaredSamples).toBe(60);
  });

  it('R2A-037 accepts a valid fragmented initialization and cumulative trun data', () => {
    const result = inspect(fragmented([10, 20]), 0, { final: true });
    expect(result.decision).toBe('append');
    expect(result.usage.mode).toBe('fragmented');
    expect(result.usage.declaredSamples).toBe(30);
  });

  it('R2A-038 accepts a complete moov supplied at a nonzero EOF offset', () => {
    const result = inspect(moov([stsz(50)]), 100_000, { supplemental: true, canonical: true, final: true });
    expect(result.decision).toBe('append');
    expect(result.usage.declaredSamples).toBe(50);
  });

  it('R2A-039 rejects chunked size-zero boxes but accepts an explicitly final size-zero moov', () => {
    const bytes = moov([stsz(1)]);
    new DataView(bytes.buffer).setUint32(0, 0);
    expect(makeGuard().inspect(buffer(bytes), 0).reason).toBe('unsupported-structure');
    const finalResult = makeGuard().inspect(buffer(bytes), 0, { final: true, canonical: true });
    expect(finalResult.decision).toBe('append');
  });

  it('R2A-040 represents valid partial metadata as appendable incompleteness', () => {
    const bytes = moov([stsz(1)]);
    const result = makeGuard().inspect(buffer(bytes.subarray(0, 12)), 0);
    expect(result.decision).toBe('append');
    expect(result.complete).toBeFalse();
    expect(result.pendingBytes).toBe(12);
  });

  it('preserves the preflight budget monotonically as fragment boxes arrive', () => {
    const init = moov([stsz(0)], [1], true);
    const fragment1 = box('moof', box('traf', join(fullBox('tfhd', view32(1)), trun(10))));
    const fragment2 = box('moof', box('traf', join(fullBox('tfhd', view32(1)), trun(10))));
    const guard = makeGuard();
    const first = guard.inspect(buffer(init), 0).usage.estimatedBytes;
    const second = guard.inspect(buffer(fragment1), init.byteLength).usage.estimatedBytes;
    const third = guard.inspect(buffer(fragment2), init.byteLength + fragment1.byteLength, { final: true }).usage.estimatedBytes;
    expect(second).toBeGreaterThanOrEqual(first);
    expect(third).toBeGreaterThanOrEqual(second);
  });

  it('HDLR-001/002/003/010/011 accepts bounded video/audio names, empty names, and NUL at child end', () => {
    const name = (value: string) => new TextEncoder().encode(value);
    const baseline = inspect(moov([stsz(1)]), 0, { final: true }).usage;
    const validNames = [
      new Uint8Array(),
      name('VideoHandler\0'),
      new Uint8Array([0]),
      name('V\0'),
      name('VideoHandler\0nonzero trailing bytes'),
      ...[16, 64, 256, 1024, 4096, 16384, 65536].map((length) => {
        const value = new Uint8Array(length).fill(0x41);
        value[length - 1] = 0;
        return value;
      }),
    ];
    for (const boundedName of validNames) {
      const bytes = moov([stsz(1)], undefined, false, undefined, undefined, undefined, undefined, undefined, [
        box('hdlr', handlerPayload('vide', boundedName)),
      ]);
      const result = inspect(bytes, 0, { final: true });
      expect(result.decision).toBe('append');
      expect(result.usage.metadataBytes - baseline.metadataBytes).toBe(boundedName.byteLength);
      const nameBytes = boundedName.byteLength === 0 ? 0 : boundedName.indexOf(0) + 1;
      expect(result.usage.auxiliaryUnits - baseline.auxiliaryUnits).toBe(Math.ceil(nameBytes / 64));
    }

    for (const handler of ['vide', 'soun'] as const) {
      const bytes = moov([stsz(1)], undefined, false, [handler], undefined, undefined, undefined, undefined, [
        box('hdlr', handlerPayload(handler, name('Handler\0'))),
      ]);
      expect(inspect(bytes, 0, { final: true }).decision).toBe('append');
    }
  });

  it('HDLR-004/005/006/014 rejects unterminated names even when sibling bytes contain NUL', () => {
    const unterminatedHdlr = box('hdlr', handlerPayload('vide', new TextEncoder().encode('missing-nul')));
    const siblingNul = box('free', new Uint8Array([0]));
    const longSiblingNul = box('free', join(new Uint8Array(256).fill(0x53), new Uint8Array([0])));
    const malformed = [
      moov([stsz(1)], undefined, false, undefined, undefined, undefined, siblingNul, undefined, [unterminatedHdlr]),
      moov([stsz(1)], undefined, false, undefined, undefined, undefined, join(siblingNul, longSiblingNul), undefined, [unterminatedHdlr]),
    ];
    for (const bytes of malformed) {
      const result = inspect(bytes, 0, { final: true });
      expect(result.decision).toBe('reject');
      expect(result.reason).toBe('unsupported-structure');
    }
  });

  it('HDLR-007/008/009 rejects malformed fixed fields, nonzero version, and meta flags', () => {
    const malformedFixed = moov([stsz(1)], undefined, false, undefined, undefined, undefined, undefined, undefined, [
      box('hdlr', new Uint8Array(23)),
    ]);
    expect(inspect(malformedFixed, 0, { final: true }).reason).toBe('invalid-structure');

    const wrongVersion = moov([stsz(1)], undefined, false, undefined, undefined, undefined, undefined, undefined, [
      box('hdlr', handlerPayload('vide', new Uint8Array([0]), 1)),
    ]);
    expect(inspect(wrongVersion, 0, { final: true }).reason).toBe('unsupported-structure');

    const metaHdlr = box('udta', fullBox('meta', box('hdlr', handlerPayload('mdir', new Uint8Array([0]), 0, 1))));
    const metaMoov = box('moov', join(fullBox('mvhd', new Uint8Array(16)), track(1, stsz(1)), metaHdlr));
    expect(inspect(metaMoov, 0, { final: true }).reason).toBe('unsupported-structure');
  });

  it('HDLR-012/015 keeps unsupported handlers rejected and applies the same rule to largesize boxes', () => {
    const unsupported = moov([stsz(1)], undefined, false, ['meta'], undefined, undefined, undefined, undefined, [
      box('hdlr', handlerPayload('meta', new TextEncoder().encode('MetaHandler\0'))),
    ]);
    expect(inspect(unsupported, 0, { final: true }).reason).toBe('unsupported-structure');

    const boundedLarge = moov([stsz(1)], undefined, false, undefined, undefined, undefined, undefined, undefined, [
      largeSizeBox(box('hdlr', handlerPayload('vide', new TextEncoder().encode('VideoHandler\0')))),
    ]);
    expect(inspect(boundedLarge, 0, { final: true }).decision).toBe('append');

    const unterminatedLarge = moov([stsz(1)], undefined, false, undefined, undefined, undefined, undefined, undefined, [
      largeSizeBox(box('hdlr', handlerPayload('vide', new TextEncoder().encode('x')))),
    ]);
    expect(inspect(unterminatedLarge, 0, { final: true }).reason).toBe('unsupported-structure');
  });

  it('HDLR-013/014 retains partial names until complete and then enforces an in-box terminator', () => {
    const valid = moov([stsz(1)], undefined, false, undefined, undefined, undefined, undefined, undefined, [
      box('hdlr', handlerPayload('vide', new TextEncoder().encode('VideoHandler\0'))),
    ]);
    const name = new TextEncoder().encode('VideoHandler\0');
    let nameOffset = -1;
    for (let offset = 0; offset <= valid.byteLength - name.byteLength; offset++) {
      if (name.every((value, index) => valid[offset + index] === value)) { nameOffset = offset; break; }
    }
    expect(nameOffset).toBeGreaterThan(0);
    for (const split of [nameOffset - 1, nameOffset, nameOffset + 5, nameOffset + name.byteLength - 1]) {
      const guard = makeGuard();
      const prefix = valid.subarray(0, split);
      const partial = guard.inspect(buffer(prefix), 0);
      expect(partial.decision).toBe('append');
      expect(partial.complete).toBeFalse();
      const tail = valid.subarray(split);
      const complete = guard.inspect(buffer(tail), split, { final: true });
      expect(complete.decision).toBe('append');
      expect(complete.complete).toBeTrue();
    }

    const malformed = moov([stsz(1)], undefined, false, undefined, undefined, box('free', new Uint8Array([0])), undefined, undefined, [
      box('hdlr', handlerPayload('vide', new TextEncoder().encode('missing-nul'))),
    ]);
    const guard = makeGuard();
    const childEnd = malformed.byteLength - box('free', new Uint8Array([0])).byteLength;
    const first = guard.inspect(buffer(malformed.subarray(0, childEnd)), 0);
    expect(first.decision).toBe('append');
    expect(first.complete).toBeFalse();
    const final = guard.inspect(buffer(malformed.subarray(childEnd)), childEnd, { final: true });
    expect(final.decision).toBe('reject');
    expect(final.reason).toBe('unsupported-structure');
  });
});
