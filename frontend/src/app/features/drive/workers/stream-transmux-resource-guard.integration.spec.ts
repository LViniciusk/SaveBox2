import { createFile } from 'mp4box';
import { KASUMI_CHUNK_SIZE } from '../../../core/crypto/kasumi-format';
import { createTransmuxMessageHandler } from './stream-transmux-protocol';
import { createMp4ResourceGuard, type Mp4ResourceGuard } from './stream-transmux-resource-guard';
import {
  createTransmuxState,
  TRANSMUX_PARSER_ERROR,
  TRANSMUX_RESOURCE_ERROR,
  TRANSMUX_STRUCTURE_ERROR,
  type TransmuxState,
} from './stream-transmux-state';

type Bytes = Uint8Array<ArrayBuffer>;
interface ProtocolMessage extends Record<string, any> { type?: string; message?: string; generation?: number; }
interface Posted { message: ProtocolMessage; transferables: Transferable[]; }

const u32 = (number: number): Bytes => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, number);
  return bytes;
};

function join(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

function box(type: string, payload = new Uint8Array()): Bytes {
  return join(u32(payload.byteLength + 8), new TextEncoder().encode(type), payload);
}

function fullBox(type: string, payload = new Uint8Array(), version = 0, flags = 0): Bytes {
  const header = new Uint8Array([version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255]);
  return box(type, join(header, payload));
}

function hdlrPayload(handler: string, name: Bytes): Bytes {
  const payload = new Uint8Array(24 + name.byteLength);
  payload.set(new TextEncoder().encode(handler), 8);
  payload.set(name, 24);
  return payload;
}

function stsz(count: number, fixedSize = 1): Bytes {
  return fullBox('stsz', join(u32(fixedSize), u32(count)));
}

function track(
  id: number,
  handler: 'vide' | 'soun',
  sampleCount: number,
  extraBoxes: Bytes[] = [],
  minfExtraBoxes: Bytes[] = [],
  hdlrOverride?: Bytes,
  mdiaExtraBoxes: Bytes[] = [],
): Bytes {
  const tkhd = new Uint8Array(20);
  new DataView(tkhd.buffer).setUint32(8, id);
  const hdlr = new Uint8Array(24);
  hdlr.set(new TextEncoder().encode(handler), 8);
  const sampleEntry = box(handler === 'vide' ? 'avc1' : 'mp4a', new Uint8Array(handler === 'vide' ? 78 : 28));
  const stbl = box('stbl', join(fullBox('stsd', join(u32(1), sampleEntry)), stsz(sampleCount), ...extraBoxes));
  const minf = box('minf', join(box(handler === 'vide' ? 'vmhd' : 'smhd', new Uint8Array(8)), ...minfExtraBoxes, stbl));
  const mdia = box('mdia', join(hdlrOverride ?? box('hdlr', hdlr), ...mdiaExtraBoxes, minf));
  return box('trak', join(fullBox('tkhd', tkhd), mdia));
}

function moov(
  tracks: Array<{ id: number; handler?: 'vide' | 'soun'; samples: number }>,
  fragmented = false,
  extraBoxes: Bytes[] = [],
  minfExtraBoxes: Bytes[] = [],
  hdlrBoxes?: Bytes[],
  mdiaExtraBoxes?: Bytes[][],
): Bytes {
  const content = tracks.map((entry, index) => track(
    entry.id, entry.handler ?? 'vide', entry.samples, extraBoxes, minfExtraBoxes,
    hdlrBoxes?.[index], mdiaExtraBoxes?.[index],
  ));
  if (fragmented) content.push(box('mvex'));
  return box('moov', join(fullBox('mvhd', new Uint8Array(16)), ...content));
}

function ftyp(): Bytes { return box('ftyp', new Uint8Array(8)); }

function fixedChunk0(metadata = moov([{ id: 1, samples: 1 }]), mdatEnd = KASUMI_CHUNK_SIZE * 4): ArrayBuffer {
  const prefix = join(ftyp(), metadata);
  const size = mdatEnd - prefix.byteLength;
  if (size < 8) throw new Error('Test metadata does not fit in chunk zero.');
  const out = new Uint8Array(KASUMI_CHUNK_SIZE);
  out.set(prefix);
  const view = new DataView(out.buffer);
  view.setUint32(prefix.byteLength, size);
  out.set(new TextEncoder().encode('mdat'), prefix.byteLength + 4);
  return out.buffer;
}

function asBuffer(bytes: Bytes): ArrayBuffer { return bytes.slice().buffer; }

function findFourcc(bytes: Bytes, fourcc: string): number {
  const needle = new TextEncoder().encode(fourcc);
  for (let offset = 0; offset <= bytes.byteLength - needle.byteLength; offset++) {
    if (needle.every((value, index) => bytes[offset + index] === value)) return offset;
  }
  throw new Error(`Missing ${fourcc} in test box.`);
}

function paddedBoxChunk(payloadPrefix: Bytes, splitAfter: number): { prefix: ArrayBuffer; tail: ArrayBuffer } {
  const boxOffset = KASUMI_CHUNK_SIZE - splitAfter;
  if (boxOffset < 8 || splitAfter < 1 || splitAfter > payloadPrefix.byteLength) throw new Error('Invalid test split.');
  const prefix = new Uint8Array(KASUMI_CHUNK_SIZE);
  const view = new DataView(prefix.buffer);
  view.setUint32(0, boxOffset);
  prefix.set(new TextEncoder().encode('free'), 4);
  prefix.set(payloadPrefix.subarray(0, splitAfter), boxOffset);
  return { prefix: prefix.buffer, tail: asBuffer(payloadPrefix.subarray(splitAfter)) };
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

function realFragmentedInit(): ArrayBuffer {
  const writer = createFile() as any;
  writer.init({ brands: ['isom'], timescale: 1000, duration: 1000 });
  writer.addTrack({ type: 'avc1', width: 16, height: 16, hdlr: 'vide', timescale: 1000, media_duration: 1000 });
  const stream = writer.getBuffer();
  return stream.buffer.slice(0, stream.byteLength);
}

function paddedInitChunk(init: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(KASUMI_CHUNK_SIZE);
  bytes.set(new Uint8Array(init));
  const offset = init.byteLength;
  const view = new DataView(bytes.buffer);
  view.setUint32(offset, bytes.byteLength - offset);
  bytes.set(new TextEncoder().encode('mdat'), offset + 4);
  return bytes.buffer;
}

function trun(count: number): Bytes { return fullBox('trun', u32(count)); }

function trunWithPerSampleSizes(count: number): Bytes {
  return fullBox('trun', join(u32(count), new Uint8Array(count * 4)), 0, 0x200);
}

function moof(count: number, totalSize?: number): Bytes {
  const body = join(fullBox('mfhd', u32(1)), box('traf', join(fullBox('tfhd', u32(1)), trun(count))));
  const target = totalSize ?? body.byteLength + 8;
  const slack = target - body.byteLength - 16;
  if (slack < 0) throw new Error('Requested test moof is too small.');
  return box('moof', join(body, box('free', new Uint8Array(slack))));
}

function parserState(ready: Promise<void> = Promise.resolve()): TransmuxState {
  const mp4file = jasmine.createSpyObj<any>('mp4file', ['appendBuffer', 'flush', 'start', 'seek']);
  mp4file.seek.and.returnValue({ offset: KASUMI_CHUNK_SIZE * 2, time: 0 });
  return {
    mp4file, initData: null, videoDuration: 10, pendingSegments: [],
    resolveReady: null, rejectReady: null, readyPromise: ready, terminalError: null,
  };
}

function snapshot(): Mp4ResourceGuard['usage'] {
  return { declaredSamples: 0, auxiliaryUnits: 0, metadataBytes: 0, visitedBoxes: 0, estimatedBytes: 0, mode: 'unknown' };
}

function noOpGuard(): Mp4ResourceGuard {
  const usage = snapshot();
  return {
    usage,
    inspect: () => ({ decision: 'append', complete: true, pendingBytes: 0, retainedBytes: 0, usage }),
    finish: () => ({ decision: 'append', complete: true, pendingBytes: 0, retainedBytes: 0, usage }),
  };
}

function harness(states: TransmuxState[], opts: { aggregateBudgetBytes?: number; testGuard?: () => Mp4ResourceGuard } = {}) {
  const posts: Posted[] = [];
  const handle = createTransmuxMessageHandler(
    () => states.shift()!,
    (message, transferables = []) => posts.push({ message, transferables }),
    {
      aggregateBudgetBytes: opts.aggregateBudgetBytes,
      createResourceGuard: opts.testGuard ?? createMp4ResourceGuard,
    },
  );
  return { handle, posts };
}

async function bootstrap(handle: (data: any) => Promise<void>, chunk0 = fixedChunk0(), extras: Record<string, unknown> = {}): Promise<void> {
  await handle({ type: 'BOOTSTRAP', chunk0, moovBytes: null, isLastChunk: false, ...extras });
}

describe('B.89-R2B MP4 guard protocol integration', () => {
  it('R2B-026 rejects an abusive declaration before the resolved MP4Box parser can receive it', async () => {
    const parser = createFile();
    const appendBuffer = spyOn(parser, 'appendBuffer').and.callThrough();
    const state = createTransmuxState(parser);
    const { handle, posts } = harness([state]);
    const malicious = asBuffer(join(ftyp(), moov([{ id: 1, samples: 10_000_000 }])));

    await handle({ type: 'BOOTSTRAP', chunk0: malicious, moovBytes: null });

    expect(appendBuffer).not.toHaveBeenCalled();
    expect((parser as any).moov).toBeUndefined();
    expect(state.terminalError?.message).toBe(TRANSMUX_RESOURCE_ERROR);
    expect(posts.map(({ message }) => message.type)).toEqual(['ERROR']);
  });

  it('rejects an unknown nested parser surface before MP4Box appendBuffer', async () => {
    const parser = createFile() as any;
    const appendBuffer = spyOn(parser, 'appendBuffer').and.callThrough();
    const state = createTransmuxState(parser);
    const { handle, posts } = harness([state]);
    const unknownChild = box('zzzz');
    const hostile = asBuffer(join(ftyp(), moov([{ id: 1, samples: 1 }], false, [unknownChild])));

    await handle({ type: 'BOOTSTRAP', chunk0: hostile, moovBytes: null });

    expect(appendBuffer).not.toHaveBeenCalled();
    expect(parser.moov).toBeUndefined();
    expect(state.terminalError?.message).toBe(TRANSMUX_STRUCTURE_ERROR);
    expect(posts.map(({ message }) => message.type)).toEqual(['ERROR']);
  });

  it('rejects invalid dref grammar before the real MP4Box parser can materialize it', async () => {
    const parser = createFile() as any;
    const appendBuffer = spyOn(parser, 'appendBuffer').and.callThrough();
    const state = createTransmuxState(parser);
    const { handle, posts } = harness([state]);
    const invalidDref = fullBox('dref', join(u32(1), box('urn ', new TextEncoder().encode('external'))));
    const hostile = fixedChunk0(moov([{ id: 1, samples: 1 }], false, [], [box('dinf', invalidDref)]));

    await bootstrap(handle, hostile);

    expect(appendBuffer).not.toHaveBeenCalled();
    expect(parser.moov).toBeUndefined();
    expect(state.terminalError?.message).toBe(TRANSMUX_STRUCTURE_ERROR);
    expect(posts.map(({ message }) => message.type)).toEqual(['ERROR']);
  });

  it('HDLR-INT-001 rejects an unterminated bootstrap handler before real MP4Box receives it', async () => {
    const parser = createFile() as any;
    const appendBuffer = spyOn(parser, 'appendBuffer').and.callThrough();
    const state = createTransmuxState(parser);
    const { handle, posts } = harness([state]);
    const malformedHandler = box('hdlr', hdlrPayload('vide', new TextEncoder().encode('missing-nul')));
    const hostile = fixedChunk0(moov(
      [{ id: 1, samples: 1 }], false, [], [], [malformedHandler], [[box('free', new Uint8Array([0]))]],
    ));

    await bootstrap(handle, hostile);

    expect(appendBuffer).not.toHaveBeenCalled();
    expect(state.terminalError?.message).toBe(TRANSMUX_STRUCTURE_ERROR);
    expect(posts.at(-1)?.message.message).toBe(TRANSMUX_STRUCTURE_ERROR);
  });

  it('HDLR-INT-002 accepts a valid initialization through the same guard and real MP4Box 2.4.1', () => {
    const init = realFragmentedInit();
    (init as any).fileStart = 0;
    const checked = createMp4ResourceGuard().inspect(init, 0, { final: true });
    expect(checked.decision).toBe('append');
    const parser = createFile() as any;
    let info: any = null;
    parser.onReady = (value: any) => { info = value; };
    parser.appendBuffer(init);
    expect(info?.tracks?.map((track: any) => [track.type, track.name])).toEqual([['video', 'Track created with MP4Box.js']]);
  });

  it('HDLR-INT-003 rejects a malformed supplemental moov before its real parser append', async () => {
    const parser = createFile() as any;
    const appendBuffer = spyOn(parser, 'appendBuffer').and.callThrough();
    const state = createTransmuxState(parser);
    state.readyPromise = Promise.resolve();
    const { handle, posts } = harness([state]);
    const chunk0 = fixedChunk0(box('free'), KASUMI_CHUNK_SIZE);
    const malformed = moov(
      [{ id: 1, samples: 1 }], false, [], [],
      [box('hdlr', hdlrPayload('vide', new TextEncoder().encode('missing-nul')))],
      [[box('free', new Uint8Array([0]))]],
    );

    await bootstrap(handle, chunk0, { moovBytes: asBuffer(malformed), moovOffset: KASUMI_CHUNK_SIZE + 16 });

    expect(appendBuffer).toHaveBeenCalledTimes(1);
    expect(state.terminalError?.message).toBe(TRANSMUX_STRUCTURE_ERROR);
    expect(posts.at(-1)?.message.message).toBe(TRANSMUX_STRUCTURE_ERROR);
  });

  it('HDLR-INT-004 validates chunk-spanning moov before the completing append reaches real MP4Box', async () => {
    const parser = createFile() as any;
    const appendBuffer = spyOn(parser, 'appendBuffer').and.callThrough();
    const state = createTransmuxState(parser);
    state.readyPromise = Promise.resolve();
    const { handle, posts } = harness([state]);
    const chunk0 = fixedChunk0(box('free'), KASUMI_CHUNK_SIZE);
    await bootstrap(handle, chunk0);
    const malformed = moov(
      [{ id: 1, samples: 1 }], false,
      [box('free', new Uint8Array(KASUMI_CHUNK_SIZE))], [],
      [box('hdlr', hdlrPayload('vide', new TextEncoder().encode('missing-nul')))],
      [[box('free', new Uint8Array([0]))]],
    );
    const prefix = asBuffer(malformed.subarray(0, KASUMI_CHUNK_SIZE));
    const tail = asBuffer(malformed.subarray(KASUMI_CHUNK_SIZE));

    await handle({ type: 'TRANSMUX_CHUNK', decryptedChunk: prefix, chunkIndex: 1, isLastChunk: false });
    expect(appendBuffer).toHaveBeenCalledTimes(2);
    await handle({ type: 'TRANSMUX_CHUNK', decryptedChunk: tail, chunkIndex: 2, isLastChunk: true });

    expect(appendBuffer).toHaveBeenCalledTimes(2);
    expect(appendBuffer).not.toHaveBeenCalledWith(tail);
    expect(state.terminalError?.message).toBe(TRANSMUX_STRUCTURE_ERROR);
    expect(posts.at(-1)?.message.message).toBe(TRANSMUX_STRUCTURE_ERROR);
  });

  it('HDLR-INT-005 does not promote a seek candidate rejected by its replay guard', async () => {
    const active = parserState();
    const candidate = parserState();
    let guardsCreated = 0;
    const { handle, posts } = harness([active, candidate], {
      testGuard: () => {
        const guard = createMp4ResourceGuard();
        guardsCreated++;
        if (guardsCreated === 1) return guard;
        return {
          get usage() { return guard.usage; },
          inspect(input, offset, options) {
            const result = guard.inspect(input, offset, options);
            return result.decision === 'append' ? { ...result, decision: 'reject', reason: 'unsupported-structure' } : result;
          },
          finish: () => guard.finish(),
        };
      },
    });
    await bootstrap(handle);
    posts.length = 0;

    await handle({ type: 'SEEK', time: 1, generation: 4 });

    expect(candidate.mp4file.appendBuffer).not.toHaveBeenCalled();
    expect(candidate.mp4file.start).not.toHaveBeenCalled();
    expect(active.terminalError).toBeNull();
    expect(posts.some(({ message }) => message.type === 'SEEK_COMPLETE')).toBeFalse();
    expect(posts.at(-1)?.message).toEqual({
      type: 'ERROR', chunkIndex: -1, message: TRANSMUX_STRUCTURE_ERROR, generation: 4,
    });
  });

  it('R2B-M1-001 keeps real MP4Box safe across stsz header, FullBox, count, and Kasumi-boundary splits', async () => {
    const ordinary = moov([{ id: 1, samples: 300_000 }]);
    const extended = largeSizeBox(ordinary);
    const ordinaryCountOffset = findFourcc(ordinary, 'stsz') + 12;
    const ordinaryTypeOffset = findFourcc(ordinary, 'stsz');
    const extendedCountOffset = findFourcc(extended, 'stsz') + 12;
    const cases: Array<{ name: string; box: Bytes; cut: number }> = [
      ...[1, 4, 7, 8].map(cut => ({ name: `32-bit moov header @${cut}`, box: ordinary, cut })),
      ...[8, 15, 16].map(cut => ({ name: `largesize moov header @${cut}`, box: extended, cut })),
      ...[4, 5, 7, 8].map(delta => ({ name: `stsz FullBox @+${delta}`, box: ordinary, cut: ordinaryTypeOffset + delta })),
      ...[0, 1, 2, 3, 4].map(delta => ({ name: `stsz sample_count @+${delta}`, box: ordinary, cut: ordinaryCountOffset + delta })),
      { name: 'stsz final byte', box: ordinary, cut: ordinary.byteLength - 1 },
      { name: 'stsz moov ends at the chunk boundary', box: ordinary, cut: ordinary.byteLength },
      { name: 'largesize stsz sample_count split after two bytes', box: extended, cut: extendedCountOffset + 2 },
    ];

    for (const testCase of cases) {
      const split = paddedBoxChunk(testCase.box, testCase.cut);
      const parser = createFile() as any;
      const appendBuffer = spyOn(parser, 'appendBuffer').and.callThrough();
      const flush = spyOn(parser, 'flush').and.callThrough();
      const state = createTransmuxState(parser);
      const { handle, posts } = harness([state]);
      const hasTail = split.tail.byteLength > 0;

      await handle({
        type: 'BOOTSTRAP',
        chunk0: split.prefix,
        moovBytes: hasTail ? split.tail : null,
        moovOffset: KASUMI_CHUNK_SIZE,
        isLastChunk: true,
      });

      const expectedAppends = hasTail ? 1 : 0;
      expect(appendBuffer.calls.count()).withContext(testCase.name).toBe(expectedAppends);
      if (hasTail) expect(appendBuffer.calls.argsFor(0)[0]).withContext(testCase.name).toBe(split.prefix as any);
      if (hasTail) expect((parser as any).stream.buffers).withContext(testCase.name).toContain(split.prefix as any);
      expect((parser as any).moov).withContext(testCase.name).toBeUndefined();
      expect(flush).withContext(testCase.name).not.toHaveBeenCalled();
      expect(state.terminalError?.message).withContext(testCase.name).toBe(TRANSMUX_RESOURCE_ERROR);
      expect(posts.map(({ message }) => message.type)).withContext(testCase.name).toEqual(['ERROR']);
      expect(posts[0].message.message).withContext(testCase.name).toBe(TRANSMUX_RESOURCE_ERROR);
    }
  });

  it('R2B-M1-002 keeps real MP4Box safe across trun header, flags, count, optional fields, and chunk splits', async () => {
    const init = realFragmentedInit();
    const initChunk = paddedInitChunk(init);
    const initInspection = createMp4ResourceGuard().inspect(initChunk, 0);
    const sampleCount = 500_000;
    const hostile = asBuffer(box('moof', join(
      fullBox('mfhd', u32(1)),
      box('traf', join(fullBox('tfhd', u32(1)), trunWithPerSampleSizes(sampleCount))),
    )));
    const hostileBytes = new Uint8Array(hostile);
    const trunTypeOffset = findFourcc(hostileBytes, 'trun');
    const sampleCountOffset = trunTypeOffset + 8;
    const cases = [
      ...[1, 4, 7, 8].map(cut => ({ name: `moof header @${cut}`, cut })),
      ...[trunTypeOffset - 3, trunTypeOffset - 1, trunTypeOffset + 1, trunTypeOffset + 3, trunTypeOffset + 4]
        .map(cut => ({ name: `trun box header @${cut - trunTypeOffset}`, cut })),
      ...[5, 6, 7, 8].map(delta => ({ name: `trun FullBox @+${delta}`, cut: trunTypeOffset + delta })),
      ...[0, 1, 2, 3, 4].map(delta => ({ name: `trun sample_count @+${delta}`, cut: sampleCountOffset + delta })),
      { name: 'trun optional sample-size fields', cut: sampleCountOffset + 100 },
      { name: 'trun final byte', cut: hostileBytes.byteLength - 1 },
      { name: 'trun moof ends at the chunk boundary', cut: hostileBytes.byteLength },
    ];

    for (const testCase of cases) {
      const split = paddedBoxChunk(hostileBytes, testCase.cut);
      const parser = createFile() as any;
      const appendBuffer = spyOn(parser, 'appendBuffer').and.callThrough();
      const flush = spyOn(parser, 'flush').and.callThrough();
      const state = createTransmuxState(parser);
      const { handle, posts } = harness([state]);

      await handle({ type: 'BOOTSTRAP', chunk0: initChunk.slice(0), moovBytes: null, isLastChunk: false });
      expect(posts.at(-1)?.message.type)
        .withContext(`${testCase.name}; guard=${initInspection.reason ?? initInspection.decision}; ${posts.at(-1)?.message.message ?? 'no bootstrap response'}`)
        .toBe('BOOTSTRAP_COMPLETE');
      await handle({ type: 'TRANSMUX_CHUNK', decryptedChunk: split.prefix, chunkIndex: 1, isLastChunk: false });

      const hasTail = split.tail.byteLength > 0;
      if (hasTail) expect(posts.at(-1)?.message.type).withContext(testCase.name).toBe('CHUNK_TRANSMUXED');
      if (hasTail) expect((parser as any).stream.buffers).withContext(testCase.name).toContain(split.prefix as any);
      if (hasTail) {
        await handle({
          type: 'TRANSMUX_CHUNK',
          decryptedChunk: split.tail,
          chunkIndex: 2,
          isLastChunk: true,
        });
      }

      expect(appendBuffer.calls.count()).withContext(testCase.name).toBe(hasTail ? 2 : 1);
      expect((parser as any).boxes.some((entry: any) => entry.type === 'moof')).withContext(testCase.name).toBeFalse();
      expect(flush).withContext(testCase.name).not.toHaveBeenCalled();
      expect(state.terminalError?.message).withContext(testCase.name).toBe(TRANSMUX_RESOURCE_ERROR);
      expect(posts.at(-1)?.message.type).withContext(testCase.name).toBe('ERROR');
      expect(posts.at(-1)?.message.message).withContext(testCase.name).toBe(TRANSMUX_RESOURCE_ERROR);
      const postCount = posts.length;
      parser.onSegment(1, null, new ArrayBuffer(1), 1, false);
      expect(state.pendingSegments).withContext(testCase.name).toEqual([]);
      expect(posts.length).withContext(testCase.name).toBe(postCount);
    }
  });

  it('R2B-001 rejects abusive bootstrap stsz before append and success', async () => {
    const state = parserState();
    const { handle, posts } = harness([state]);
    const malicious = asBuffer(join(ftyp(), moov([{ id: 1, samples: 10_000_000 }])));
    await handle({ type: 'BOOTSTRAP', chunk0: malicious, moovBytes: null });
    expect(state.mp4file.appendBuffer).not.toHaveBeenCalledWith(malicious);
    expect(posts.map(({ message }) => message.type)).toEqual(['ERROR']);
    expect(posts[0].message.message).toBe(TRANSMUX_RESOURCE_ERROR);
  });

  it('R2B-002 rejects abusive separately supplied moov before its append', async () => {
    const state = parserState();
    const { handle, posts } = harness([state]);
    const chunk0 = asBuffer(join(ftyp(), box('mdat', u32(0))));
    const malicious = asBuffer(moov([{ id: 1, samples: 10_000_000 }]));
    await handle({ type: 'BOOTSTRAP', chunk0, moovBytes: malicious, moovOffset: 64 });
    expect(state.mp4file.appendBuffer).toHaveBeenCalledTimes(1);
    expect(state.mp4file.appendBuffer).not.toHaveBeenCalledWith(malicious);
    expect(posts.some(({ message }) => message.type === 'BOOTSTRAP_COMPLETE')).toBeFalse();
    expect(posts[0].message.message).toBe(TRANSMUX_RESOURCE_ERROR);
  });

  it('R2B-003 rejects abusive trun before the normal chunk reaches MP4Box', async () => {
    const state = parserState();
    const { handle, posts } = harness([state]);
    await bootstrap(handle, fixedChunk0(moov([{ id: 1, samples: 0 }], true), KASUMI_CHUNK_SIZE));
    const malicious = asBuffer(box('moof', box('traf', join(fullBox('tfhd', u32(1)), trun(10_000_000)))));
    await handle({ type: 'TRANSMUX_CHUNK', decryptedChunk: malicious, chunkIndex: 1, isLastChunk: false });
    expect(state.mp4file.appendBuffer).toHaveBeenCalledTimes(1);
    expect(state.mp4file.appendBuffer).not.toHaveBeenCalledWith(malicious);
    expect(posts.some(({ message }) => message.type === 'CHUNK_TRANSMUXED')).toBeFalse();
    expect(posts.at(-1)?.message.message).toBe(TRANSMUX_RESOURCE_ERROR);
  });

  it('R2B-004 acknowledges an incomplete moof prefix, then validates it before the completing append', async () => {
    const state = parserState();
    const { handle, posts } = harness([state]);
    const moofSize = KASUMI_CHUNK_SIZE + 32;
    const fragment = moof(5, moofSize);
    const chunk0 = fixedChunk0(moov([{ id: 1, samples: 0 }], true), KASUMI_CHUNK_SIZE);
    await bootstrap(handle, chunk0);
    const first = asBuffer(fragment.slice(0, KASUMI_CHUNK_SIZE));
    await handle({ type: 'TRANSMUX_CHUNK', decryptedChunk: first, chunkIndex: 1, isLastChunk: false });
    expect(posts.at(-1)?.message.type).toBe('CHUNK_TRANSMUXED');
    expect(state.mp4file.appendBuffer).toHaveBeenCalledWith(first);
    const tail = asBuffer(fragment.slice(KASUMI_CHUNK_SIZE));
    await handle({ type: 'TRANSMUX_CHUNK', decryptedChunk: tail, chunkIndex: 2, isLastChunk: true });
    expect(state.mp4file.appendBuffer).toHaveBeenCalledWith(tail);
    expect(posts.at(-1)?.message.type).toBe('CHUNK_TRANSMUXED');
    expect(state.mp4file.flush).toHaveBeenCalledTimes(1);
  });

  it('R2B-005 rejects incomplete final metadata before append and flush', async () => {
    const state = parserState();
    const { handle, posts } = harness([state]);
    await bootstrap(handle, fixedChunk0());
    const partial = new Uint8Array([0, 0, 0, 64, 0x6d, 0x6f, 0x6f, 0x66, 0, 0, 0, 0]).buffer;
    await handle({ type: 'TRANSMUX_CHUNK', decryptedChunk: partial, chunkIndex: 1, isLastChunk: true });
    expect(state.mp4file.appendBuffer).not.toHaveBeenCalledWith(partial);
    expect(state.mp4file.flush).not.toHaveBeenCalled();
    expect(posts.at(-1)?.message.message).toBe(TRANSMUX_STRUCTURE_ERROR);
  });

  it('R2B-006 preserves the active parser when a candidate replay is rejected by the aggregate budget', async () => {
    const base = createMp4ResourceGuard().inspect(fixedChunk0(), 0).usage.estimatedBytes;
    const active = parserState();
    const candidate = parserState();
    const { handle, posts } = harness([active, candidate], { aggregateBudgetBytes: Math.ceil(base * 1.5) });
    await bootstrap(handle);
    posts.length = 0;
    await handle({ type: 'SEEK', time: 1, generation: 7 });
    expect(candidate.mp4file.appendBuffer).not.toHaveBeenCalled();
    expect(candidate.mp4file.start).not.toHaveBeenCalled();
    expect(active.terminalError).toBeNull();
    expect(posts.at(-1)?.message).toEqual({
      type: 'ERROR', chunkIndex: -1, message: TRANSMUX_RESOURCE_ERROR, generation: 7,
    });
  });

  it('R2B-007 rejects a candidate before append when active plus candidate exceed aggregate budget', async () => {
    const cost = createMp4ResourceGuard().inspect(fixedChunk0(), 0).usage.estimatedBytes;
    const active = parserState();
    const candidate = parserState();
    const { handle } = harness([active, candidate], { aggregateBudgetBytes: cost + cost - 1 });
    await bootstrap(handle);
    await handle({ type: 'SEEK', time: 1, generation: 1 });
    expect(candidate.mp4file.appendBuffer).not.toHaveBeenCalled();
  });

  it('R2B-008 accounts for both simultaneous seek candidates and rejects the one over aggregate', async () => {
    const cost = createMp4ResourceGuard().inspect(fixedChunk0(), 0).usage.estimatedBytes;
    const readyA = deferred<void>();
    const readyB = deferred<void>();
    const active = parserState();
    const candidateA = parserState(readyA.promise);
    const candidateB = parserState(readyB.promise);
    const { handle, posts } = harness([active, candidateA, candidateB], { aggregateBudgetBytes: Math.floor(cost * 2.5) });
    await bootstrap(handle);
    posts.length = 0;
    const first = handle({ type: 'SEEK', time: 1, generation: 1 });
    const second = handle({ type: 'SEEK', time: 2, generation: 2 });
    expect(candidateA.mp4file.appendBuffer).toHaveBeenCalledTimes(1);
    expect(candidateB.mp4file.appendBuffer).not.toHaveBeenCalled();
    readyA.resolve();
    await Promise.all([first, second]);
    expect(posts.some(({ message }) => message.type === 'ERROR' && message.generation === 2)).toBeTrue();
    expect(active.terminalError).toBeNull();
  });

  it('R2B-009 does not publish or promote a stale candidate and releases its reservation', async () => {
    const active = parserState();
    const readyA = deferred<void>();
    const stale = parserState(readyA.promise);
    const winner = parserState();
    const { handle, posts } = harness([active, stale, winner]);
    await bootstrap(handle);
    posts.length = 0;
    const first = handle({ type: 'SEEK', time: 1, generation: 1 });
    const second = handle({ type: 'SEEK', time: 2, generation: 2 });
    await second;
    readyA.resolve();
    await first;
    expect(stale.mp4file.start).not.toHaveBeenCalled();
    expect(posts.filter(({ message }) => message.type === 'SEEK_COMPLETE').map(({ message }) => message.generation)).toEqual([2]);
  });

  it('R2B-010 transfers the promoted candidate accounting exactly once', async () => {
    const active = parserState();
    const candidate = parserState();
    const nextCandidate = parserState();
    const cost = createMp4ResourceGuard().inspect(fixedChunk0(), 0).usage.estimatedBytes;
    const { handle, posts } = harness([active, candidate, nextCandidate], { aggregateBudgetBytes: cost * 2 + 1 });
    await bootstrap(handle);
    await handle({ type: 'SEEK', time: 1, generation: 1 });
    posts.length = 0;
    await handle({ type: 'SEEK', time: 2, generation: 2 });
    expect(nextCandidate.mp4file.appendBuffer).toHaveBeenCalledTimes(1);
    expect(nextCandidate.mp4file.start).toHaveBeenCalledTimes(1);
    posts.length = 0;
    const next = new Uint8Array([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65]).buffer;
    await handle({ type: 'TRANSMUX_CHUNK', decryptedChunk: next, chunkIndex: 2, isLastChunk: false });
    expect(nextCandidate.mp4file.appendBuffer).toHaveBeenCalledWith(next);
    expect(posts.at(-1)?.message.type).toBe('CHUNK_TRANSMUXED');
  });

  it('R2B-011 accumulates trun declarations across separate fragment messages', () => {
    const guard = createMp4ResourceGuard({ perParserBudgetBytes: 3_400_000 });
    const init = asBuffer(moov([{ id: 1, samples: 0 }], true));
    const fragment1 = asBuffer(box('moof', box('traf', join(fullBox('tfhd', u32(1)), trun(4_000)))));
    const fragment2 = asBuffer(box('moof', box('traf', join(fullBox('tfhd', u32(1)), trun(4_000)))));
    expect(guard.inspect(init, 0).decision).toBe('append');
    expect(guard.inspect(fragment1, init.byteLength).decision).toBe('append');
    expect(guard.inspect(fragment2, init.byteLength + fragment1.byteLength).decision).toBe('reject');
    expect(guard.usage.declaredSamples).toBe(8_000);
  });

  it('R2B-012 combines sample cost across tracks', () => {
    const input = asBuffer(moov([{ id: 1, samples: 8_000 }, { id: 2, samples: 8_000 }]));
    const result = createMp4ResourceGuard({ perParserBudgetBytes: 5_000_000 }).inspect(input, 0);
    expect(result.decision).toBe('reject');
    expect(result.usage.declaredSamples).toBe(16_000);
  });

  it('R2B-013 counts an identical moov only once per parser', () => {
    const bytes = asBuffer(moov([{ id: 1, samples: 4 }]));
    const guard = createMp4ResourceGuard();
    expect(guard.inspect(bytes, 0).decision).toBe('append');
    const first = guard.usage.estimatedBytes;
    expect(guard.inspect(bytes, 0).decision).toBe('append');
    expect(guard.usage.estimatedBytes).toBe(first);
  });

  it('R2B-014 independently accounts the same moov in a new seek parser', () => {
    const bytes = asBuffer(moov([{ id: 1, samples: 4 }]));
    const first = createMp4ResourceGuard();
    const second = createMp4ResourceGuard();
    first.inspect(bytes, 0);
    second.inspect(bytes, 0);
    expect(first.usage.estimatedBytes).toBeGreaterThan(0);
    expect(second.usage.estimatedBytes).toBe(first.usage.estimatedBytes);
  });

  it('R2B-015 allows structural cost exactly equal to the configured limit', () => {
    const bytes = asBuffer(moov([{ id: 1, samples: 1 }]));
    const baseline = createMp4ResourceGuard().inspect(bytes, 0).usage.estimatedBytes;
    const result = createMp4ResourceGuard({ perParserBudgetBytes: baseline }).inspect(bytes, 0);
    expect(result.decision).toBe('append');
    expect(result.usage.estimatedBytes).toBe(baseline);
  });

  it('R2B-016 rejects structural cost one byte above the configured limit', () => {
    const bytes = asBuffer(moov([{ id: 1, samples: 1 }]));
    const baseline = createMp4ResourceGuard().inspect(bytes, 0).usage.estimatedBytes;
    const result = createMp4ResourceGuard({ perParserBudgetBytes: baseline - 1 }).inspect(bytes, 0);
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('resource-limit');
  });

  it('R2B-017 rejects absolute-offset overflow safely', () => {
    const result = createMp4ResourceGuard().inspect(new ArrayBuffer(8), Number.MAX_SAFE_INTEGER - 4);
    expect(result.decision).toBe('reject');
    expect(result.reason).toBe('invalid-structure');
  });

  it('R2B-018 preserves the first AP-02 terminal reason after readiness', async () => {
    const state = parserState();
    const { handle, posts } = harness([state]);
    await bootstrap(handle);
    state.terminalError = new Error(TRANSMUX_PARSER_ERROR);
    await handle({ type: 'TRANSMUX_CHUNK', decryptedChunk: asBuffer(box('free')), chunkIndex: 1, isLastChunk: false });
    expect(state.terminalError.message).toBe(TRANSMUX_PARSER_ERROR);
    expect(posts.at(-1)?.message.message).toBe(TRANSMUX_PARSER_ERROR);
  });

  it('R2B-019 does not publish chunk success when flush callback terminalizes the parser', async () => {
    const mp4file = jasmine.createSpyObj<any>('mp4file', ['appendBuffer', 'flush', 'start', 'seek', 'setSegmentOptions', 'initializeSegmentation', 'releaseUsedSamples']);
    const state = createTransmuxState(mp4file);
    mp4file.onReady({ tracks: [] });
    const { handle, posts } = harness([state], { testGuard: noOpGuard });
    await bootstrap(handle);
    posts.length = 0;
    mp4file.flush.and.callFake(() => mp4file.onError('secret flush detail'));
    await handle({ type: 'TRANSMUX_CHUNK', decryptedChunk: asBuffer(box('free')), chunkIndex: 1, isLastChunk: true });
    expect(posts.some(({ message }) => message.type === 'CHUNK_TRANSMUXED')).toBeFalse();
    expect(posts.at(-1)?.message.message).toBe(TRANSMUX_PARSER_ERROR);
  });

  it('R2B-020 ignores parser callbacks after a resource error', async () => {
    const mp4file = jasmine.createSpyObj<any>('mp4file', ['appendBuffer', 'flush', 'start', 'seek', 'setSegmentOptions', 'initializeSegmentation', 'releaseUsedSamples']);
    const state = createTransmuxState(mp4file);
    const { handle, posts } = harness([state]);
    const malicious = asBuffer(join(ftyp(), moov([{ id: 1, samples: 10_000_000 }])));
    await handle({ type: 'BOOTSTRAP', chunk0: malicious, moovBytes: null });
    const calls = mp4file.appendBuffer.calls.count();
    mp4file.onReady({ tracks: [] });
    mp4file.onSegment(1, null, new ArrayBuffer(5), 1, false);
    expect(mp4file.appendBuffer.calls.count()).toBe(calls);
    expect(state.pendingSegments).toEqual([]);
    expect(posts.every(({ message }) => message.type !== 'BOOTSTRAP_COMPLETE')).toBeTrue();
  });

  it('R2B-021 accepts characterized fast-start moov input', () => {
    const input = asBuffer(join(ftyp(), moov([{ id: 1, samples: 10 }]), box('mdat', new Uint8Array(32))));
    expect(createMp4ResourceGuard().inspect(input, 0, { final: true }).decision).toBe('append');
  });

  it('R2B-022 accepts a complete moov supplied at its absolute tail offset', () => {
    const guard = createMp4ResourceGuard();
    const first = asBuffer(join(ftyp(), box('mdat', u32(0))));
    const tail = asBuffer(moov([{ id: 1, samples: 10 }]));
    expect(guard.inspect(first, 0).decision).toBe('append');
    expect(guard.inspect(tail, 100_000, { supplemental: true }).decision).toBe('append');
    expect(guard.usage.declaredSamples).toBe(10);
  });

  it('R2B-023 accepts a legitimate fragmented initialization and moof/trun', () => {
    const guard = createMp4ResourceGuard();
    const init = asBuffer(moov([{ id: 1, samples: 0 }], true));
    const fragment = asBuffer(box('moof', box('traf', join(fullBox('tfhd', u32(1)), trun(25)))));
    expect(guard.inspect(init, 0).decision).toBe('append');
    expect(guard.inspect(fragment, init.byteLength).decision).toBe('append');
    expect(guard.usage.declaredSamples).toBe(25);
  });

  it('R2B-024 accepts legitimate audio and video tracks', () => {
    const result = createMp4ResourceGuard().inspect(asBuffer(moov([
      { id: 1, handler: 'vide', samples: 10 },
      { id: 2, handler: 'soun', samples: 20 },
    ])), 0, { final: true });
    expect(result.decision).toBe('append');
    expect(result.usage.declaredSamples).toBe(30);
  });

  it('R2B-025 accepts multiple characterized tracks without rejecting their count alone', () => {
    const tracks = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, samples: 1 }));
    expect(createMp4ResourceGuard().inspect(asBuffer(moov(tracks)), 0, { final: true }).decision).toBe('append');
  });

  it('sanitizes structural and resource failures without exposing untrusted strings', async () => {
    const state = parserState();
    const { handle, posts } = harness([state]);
    const secrets = ['C:\\Users\\secret\\video.mp4', 'https://provider/private?token=SECRET', 'FDK-PRIVATE-SENTINEL', 'JWT-PRIVATE-SENTINEL', 'payload-secret'];
    const malicious = asBuffer(join(ftyp(), moov([{ id: 1, samples: 10_000_000 }]), box('free', new TextEncoder().encode(secrets.join(' ')))));
    await handle({ type: 'BOOTSTRAP', chunk0: malicious });
    const publicError = String(posts[0].message.message);
    expect(publicError).toBe(TRANSMUX_RESOURCE_ERROR);
    for (const secret of secrets) expect(publicError).not.toContain(secret);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
