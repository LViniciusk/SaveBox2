import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { KASUMI_CHUNK_SIZE } from '../../../core/crypto/kasumi-format';
import { DRIVE_TRANSFER_CHUNK_SIZE } from '../transfer-limits';
import { frameUploadChunks, UploadTransportChunk } from './upload-stream-framer';

function blobs(...sizes: number[]): AsyncIterable<Blob> {
  return (async function* () {
    for (const size of sizes) yield new Blob([new Uint8Array(size)]);
  })();
}

async function collectFrames(source: AsyncIterable<Blob>, expectedSize: number): Promise<UploadTransportChunk[]> {
  const frames: UploadTransportChunk[] = [];
  for await (const frame of frameUploadChunks(source, expectedSize)) frames.push(frame);
  return frames;
}

async function collectEncryptedParts(source: AsyncIterable<Blob>): Promise<Blob> {
  const parts: Blob[] = [];
  for await (const part of source) parts.push(part);
  return new Blob(parts);
}

async function digest(blob: Blob): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function reconstructed(frames: UploadTransportChunk[]): Promise<Blob> {
  return new Blob(frames.map(frame => frame.blob));
}

function expectFrameGeometry(frames: UploadTransportChunk[], expectedSize: number): void {
  expect(frames.map(frame => frame.index)).toEqual(frames.map((_, index) => index));
  if (expectedSize === 0) {
    expect(frames).toEqual([]);
    return;
  }

  for (const frame of frames.slice(0, -1)) {
    expect(frame.blob.size).toBe(DRIVE_TRANSFER_CHUNK_SIZE);
  }
  expect(frames.at(-1)?.blob.size).toBe(
    expectedSize - (frames.length - 1) * DRIVE_TRANSFER_CHUNK_SIZE,
  );
}

describe('frameUploadChunks', () => {
  it('frames a small part without changing its bytes', async () => {
    const sourceBytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    const frames = await collectFrames((async function* () {
      yield new Blob([sourceBytes]);
    })(), sourceBytes.length);

    expectFrameGeometry(frames, sourceBytes.length);
    expect(Array.from(new Uint8Array(await frames[0].blob.arrayBuffer()))).toEqual(Array.from(sourceBytes));
  });

  it('does not emit an empty frame for an exact transport multiple', async () => {
    const frames = await collectFrames(blobs(DRIVE_TRANSFER_CHUNK_SIZE), DRIVE_TRANSFER_CHUNK_SIZE);

    expectFrameGeometry(frames, DRIVE_TRANSFER_CHUNK_SIZE);
    expect(frames.length).toBe(1);
  });

  it('frames an exact two-frame stream after confirming upstream exhaustion', async () => {
    const expectedSize = 2 * DRIVE_TRANSFER_CHUNK_SIZE;
    const frames = await collectFrames(blobs(expectedSize), expectedSize);

    expectFrameGeometry(frames, expectedSize);
    expect(frames.length).toBe(2);
  });

  it('awaits upstream return when the framed iterator is closed before exhaustion', async () => {
    const expectedSize = 2 * DRIVE_TRANSFER_CHUNK_SIZE;
    let returnStarted!: () => void;
    let releaseReturn!: () => void;
    let returnCompleted = false;
    const returnRequested = new Promise<void>(resolve => returnStarted = resolve);
    const returnGate = new Promise<void>(resolve => releaseReturn = resolve);
    const source: AsyncIterable<Blob> = {
      [Symbol.asyncIterator]: () => {
        let emitted = false;
        return {
          next: async (): Promise<IteratorResult<Blob>> => {
            if (emitted) return { done: true, value: undefined };
            emitted = true;
            return { done: false, value: new Blob([new Uint8Array(expectedSize)]) };
          },
          return: async (): Promise<IteratorResult<Blob>> => {
            returnStarted();
            await returnGate;
            returnCompleted = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const iterator = frameUploadChunks(source, expectedSize)[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBeFalse();

    const closing = iterator.return!(undefined);
    await returnRequested;
    expect(returnCompleted).toBeFalse();
    releaseReturn();
    await closing;

    expect(returnCompleted).toBeTrue();
  });

  it('does not publish an exact-size terminal frame before upstream exhaustion', async () => {
    const source = (async function* () {
      yield new Blob([new Uint8Array(DRIVE_TRANSFER_CHUNK_SIZE)]);
      yield new Blob([Uint8Array.of(0xff)]);
    })();
    const iterator = frameUploadChunks(source, DRIVE_TRANSFER_CHUNK_SIZE);

    await expectAsync(iterator.next()).toBeRejectedWithError('Encrypted stream size mismatch');
  });

  it('propagates an upstream error before publishing a terminal frame', async () => {
    const expectedError = new Error('upstream failed');
    const source = (async function* () {
      yield new Blob([new Uint8Array(DRIVE_TRANSFER_CHUNK_SIZE)]);
      throw expectedError;
    })();
    const iterator = frameUploadChunks(source, DRIVE_TRANSFER_CHUNK_SIZE);

    let rejected = false;
    try {
      await iterator.next();
    } catch (error) {
      rejected = true;
      expect(error).toBe(expectedError);
    }
    expect(rejected).toBeTrue();
  });

  it('emits an exact remainder for transport multiple plus one byte', async () => {
    const frames = await collectFrames(blobs(DRIVE_TRANSFER_CHUNK_SIZE + 1), DRIVE_TRANSFER_CHUNK_SIZE + 1);

    expectFrameGeometry(frames, DRIVE_TRANSFER_CHUNK_SIZE + 1);
    expect(frames.length).toBe(2);
    expect(frames[1].blob.size).toBe(1);
  });

  it('does not publish a remainder frame before rejecting trailing source bytes', async () => {
    const expectedSize = DRIVE_TRANSFER_CHUNK_SIZE + 1;
    const source = (async function* () {
      yield new Blob([new Uint8Array(DRIVE_TRANSFER_CHUNK_SIZE)]);
      yield new Blob([Uint8Array.of(0x01)]);
      yield new Blob([Uint8Array.of(0x02)]);
    })();
    const iterator = frameUploadChunks(source, expectedSize);

    const first = await iterator.next();
    expect(first.value.blob.size).toBe(DRIVE_TRANSFER_CHUNK_SIZE);
    await expectAsync(iterator.next()).toBeRejectedWithError('Encrypted stream size mismatch');
  });

  it('splits a source part larger than one transport frame', async () => {
    const frames = await collectFrames(blobs(DRIVE_TRANSFER_CHUNK_SIZE + 16), DRIVE_TRANSFER_CHUNK_SIZE + 16);

    expectFrameGeometry(frames, DRIVE_TRANSFER_CHUNK_SIZE + 16);
    expect(frames[1].blob.size).toBe(16);
  });

  it('joins source parts that cross a transport boundary', async () => {
    const expectedSize = 2 * 1024 * 1024 + 2 * 1024 * 1024 + 17;
    const frames = await collectFrames(blobs(2 * 1024 * 1024, 2 * 1024 * 1024, 17), expectedSize);

    expectFrameGeometry(frames, expectedSize);
    expect(frames[0].blob.size).toBe(DRIVE_TRANSFER_CHUNK_SIZE);
    expect(frames[1].blob.size).toBe(17);
  });

  it('handles KAS1-like and KAS2-like misaligned part boundaries', async () => {
    const kas1Size = 32 + DRIVE_TRANSFER_CHUNK_SIZE + 16 + 9;
    const kas1 = await collectFrames(blobs(32, DRIVE_TRANSFER_CHUNK_SIZE + 16, 9), kas1Size);
    const kas2HeaderSize = 2 * 1024 * 1024 + 53;
    const kas2Size = kas2HeaderSize + DRIVE_TRANSFER_CHUNK_SIZE + 16 + 9;
    const kas2 = await collectFrames(blobs(kas2HeaderSize, DRIVE_TRANSFER_CHUNK_SIZE + 16, 9), kas2Size);

    expectFrameGeometry(kas1, kas1Size);
    expectFrameGeometry(kas2, kas2Size);
  });

  it('reconstructs source content exactly', async () => {
    const parts = [
      Uint8Array.from([0x01, 0x02]),
      Uint8Array.from([0x03, 0x04, 0x05]),
      Uint8Array.from([0x06]),
    ];
    const expected = new Blob(parts);
    const frames = await collectFrames((async function* () {
      for (const part of parts) yield new Blob([part]);
    })(), expected.size);

    expect(await digest(await reconstructed(frames))).toBe(await digest(expected));
  });

  it('does not call arrayBuffer on source parts', async () => {
    const source = new Blob([Uint8Array.from([1, 2, 3])]);
    spyOn(source, 'arrayBuffer').and.callFake(() => {
      throw new Error('WHOLE-PART-COPY');
    });

    const frames = await collectFrames((async function* () { yield source; })(), source.size);

    expect(frames.length).toBe(1);
    expect(frames[0].blob.size).toBe(source.size);
  });

  it('applies backpressure and does not pull the next source part before the next frame', async () => {
    let pulls = 0;
    const source = (async function* () {
      pulls++;
      yield new Blob([new Uint8Array(3 * 1024 * 1024)]);
      pulls++;
      yield new Blob([new Uint8Array(2 * 1024 * 1024)]);
      pulls++;
      yield new Blob([new Uint8Array(1 * 1024 * 1024)]);
    })();
    const iterator = frameUploadChunks(source, 6 * 1024 * 1024);

    const first = await iterator.next();
    expect(first.value.blob.size).toBe(DRIVE_TRANSFER_CHUNK_SIZE);
    expect(pulls).toBe(2);

    const pullsAfterFirst = pulls;
    const second = await iterator.next();
    expect(pulls).toBeGreaterThan(pullsAfterFirst);
    expect(second.value.blob.size).toBe(2 * 1024 * 1024);
    expect((await iterator.next()).done).toBeTrue();
  });

  it('continues yielding definitely non-terminal frames without waiting for EOF', async () => {
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>(resolve => {
      releaseSecond = resolve;
    });
    let secondPulled = false;
    const source = (async function* () {
      yield new Blob([new Uint8Array(DRIVE_TRANSFER_CHUNK_SIZE)]);
      secondPulled = true;
      await secondGate;
      yield new Blob([new Uint8Array(DRIVE_TRANSFER_CHUNK_SIZE)]);
    })();
    const iterator = frameUploadChunks(source, 2 * DRIVE_TRANSFER_CHUNK_SIZE);

    const first = await iterator.next();
    expect(first.value.blob.size).toBe(DRIVE_TRANSFER_CHUNK_SIZE);
    expect(secondPulled).toBeFalse();

    const secondPromise = iterator.next();
    await Promise.resolve();
    expect(secondPulled).toBeTrue();
    releaseSecond();

    const second = await secondPromise;
    expect(second.value.blob.size).toBe(DRIVE_TRANSFER_CHUNK_SIZE);
    expect((await iterator.next()).done).toBeTrue();
  });

  it('emits the final transport frame only after the encrypted source is exhausted', async () => {
    const expectedSize = DRIVE_TRANSFER_CHUNK_SIZE + 1;
    let sourceNextCalls = 0;
    let sourceReturnCalls = 0;
    let sourceExhausted = false;
    const sourceIterator: AsyncIterator<Blob> = {
      async next() {
        sourceNextCalls++;
        if (sourceNextCalls === 1) {
          return { done: false, value: new Blob([new Uint8Array(DRIVE_TRANSFER_CHUNK_SIZE)]) };
        }
        if (sourceNextCalls === 2) {
          return { done: false, value: new Blob([Uint8Array.of(0x01)]) };
        }
        sourceExhausted = true;
        return { done: true, value: undefined };
      },
      async return() {
        sourceReturnCalls++;
        sourceExhausted = true;
        return { done: true, value: undefined };
      },
    };
    const source: AsyncIterable<Blob> = { [Symbol.asyncIterator]: () => sourceIterator };
    const iterator = frameUploadChunks(source, expectedSize)[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBeFalse();
    expect(first.value.blob.size).toBe(DRIVE_TRANSFER_CHUNK_SIZE);
    expect(sourceExhausted).toBeFalse();

    const final = await iterator.next();
    expect(final.done).toBeFalse();
    expect(final.value.blob.size).toBe(1);
    expect(sourceExhausted).toBeTrue();
    expect(sourceNextCalls).toBe(3);
    expect(sourceReturnCalls).toBe(0);
    expect((await iterator.next()).done).toBeTrue();
  });

  it('rejects a source shorter than expected', async () => {
    await expectAsync(collectFrames(blobs(99), 100)).toBeRejectedWithError('Encrypted stream size mismatch');
  });

  it('rejects a source longer than expected', async () => {
    await expectAsync(collectFrames(blobs(101), 100)).toBeRejectedWithError('Encrypted stream size mismatch');
  });

  it('rejects invalid or unsafe expected sizes', async () => {
    for (const expectedSize of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expectAsync(collectFrames(blobs(), expectedSize)).toBeRejectedWithError('Invalid encrypted stream size');
    }
  });

  it('accepts an empty source only for expected size zero', async () => {
    expect(await collectFrames(blobs(), 0)).toEqual([]);
    await expectAsync(collectFrames(blobs(), 1)).toBeRejectedWithError('Encrypted stream size mismatch');
    await expectAsync(collectFrames(blobs(1), 0)).toBeRejectedWithError('Encrypted stream size mismatch');
  });
});

describe('E.1 encryption and transport integration', () => {
  let service: KasumiCryptoService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), KasumiCryptoService]
    });
    service = TestBed.inject(KasumiCryptoService);
  });

  async function assertIntegration(plaintextSize: number, metadata?: string): Promise<void> {
    const plaintext = new Uint8Array(plaintextSize);
    if (plaintext.length > 0) plaintext[0] = 0x11;
    if (plaintext.length > 1) plaintext[plaintext.length - 1] = 0xee;
    const file = new File([plaintext], 'integration.bin');
    const key = new Uint8Array(32).fill(0x41);
    const nonce = Uint8Array.from({ length: 24 }, (_, index) => index + 1);
    const expectedSize = service.calculateEncryptedSize(file.size, metadata);
    const wholeBlob = await collectEncryptedParts(service.encryptFileParts(file, key, nonce, metadata));
    const frames = await collectFrames(service.encryptFileParts(file, key, nonce, metadata), expectedSize);
    const output = await reconstructed(frames);

    expect(output.size).toBe(expectedSize);
    expectFrameGeometry(frames, expectedSize);
    expect(await digest(output)).toBe(await digest(wholeBlob));
    expect(new Uint8Array(await output.arrayBuffer())).toEqual(new Uint8Array(await wholeBlob.arrayBuffer()));
  }

  it('frames a zero-byte KAS1 file', async () => {
    await assertIntegration(0);
  });

  it('frames a zero-byte KAS2 file with metadata', async () => {
    await assertIntegration(0, '{"name":"á🚀","thumb":"x"}');
  });

  it('frames a KAS1 file at the exact Kasumi plaintext boundary', async () => {
    await assertIntegration(KASUMI_CHUNK_SIZE);
  });

  it('frames a KAS1 file one byte beyond the Kasumi plaintext boundary', async () => {
    await assertIntegration(KASUMI_CHUNK_SIZE + 1);
  });

  it('frames a KAS2 file with UTF-8 metadata at the exact plaintext boundary', async () => {
    await assertIntegration(KASUMI_CHUNK_SIZE, '{"name":"á🚀","thumb":"x"}');
  });
});
