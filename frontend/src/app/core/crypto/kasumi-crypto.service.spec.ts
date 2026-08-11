import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { KasumiCryptoService } from './kasumi-crypto.service';
import {
  KASUMI_CHUNK_SIZE,
  KASUMI_KAS2_METADATA_PREFIX_SIZE,
  KASUMI_MAX_METADATA_SIZE,
} from './kasumi-format';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function collectParts(source: AsyncIterable<Blob>): Promise<Blob[]> {
  const parts: Blob[] = [];
  for await (const part of source) parts.push(part);
  return parts;
}

// Test-only whole-stream collector for byte-level golden assertions.
async function encryptForTest(
  service: KasumiCryptoService,
  file: File,
  key: Uint8Array,
  baseNonce?: Uint8Array,
  metadata?: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const nonce = baseNonce ?? service.generateBaseNonce();
  return new Blob(await collectParts(service.encryptFileParts(file, key, nonce, metadata, signal)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return toHex(digest);
}

describe('KasumiCryptoService', () => {
  let service: KasumiCryptoService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), KasumiCryptoService]
    });
    service = TestBed.inject(KasumiCryptoService);
  });

  async function mutateByte(blob: Blob, offset: number): Promise<Blob> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    bytes[offset] ^= 0x01;
    return new Blob([bytes]);
  }

  async function patchUint32(blob: Blob, offset: number, value: number): Promise<Blob> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value, true);
    return new Blob([bytes]);
  }

  async function patchUint64(blob: Blob, value: bigint): Promise<Blob> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(24, value, true);
    return new Blob([bytes]);
  }

  describe('deriveChunkNonce', () => {
    it('should correctly shift bits for chunkIndex and avoid collisions', () => {
      // Arrange
      const baseNonce = new Uint8Array(24);
      
      // Act
      // 0x01020304 = 16909060
      const chunkIndex = 16909060; 
      const nonce = service.deriveChunkNonce(baseNonce, chunkIndex);

      // Assert
      // NONCE_SIZE = 24. Last 8 bytes (indices 16 to 23).
      // Little-endian shift simulation XORs from index 23 down to 16.
      expect(nonce[23]).toBe(0x04);
      expect(nonce[22]).toBe(0x03);
      expect(nonce[21]).toBe(0x02);
      expect(nonce[20]).toBe(0x01);
      
      // Asserts no mutation on baseNonce
      expect(baseNonce[23]).toBe(0);
    });
  });

  it('should generate a base nonce with the expected size', () => {
    expect(service.generateBaseNonce().length).toBe(24);
  });

  it('E.1A preserves the PRE KAS1 small golden byte-for-byte', async () => {
    const file = new File([Uint8Array.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff])], 'small.bin');
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);
    const nonce = Uint8Array.from({ length: 24 }, (_, index) => 0xa0 + index);
    const encrypted = await encryptForTest(service, file, key, nonce);

    expect(toHex(new Uint8Array(await encrypted.arrayBuffer())))
      .toBe('a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b70700000000000000234a5aee8bb57dc6be37be9851ae029d45ed086237a35b');
  });

  it('E.1A preserves the PRE KAS2 UTF-8 small golden byte-for-byte', async () => {
    const file = new File([Uint8Array.from([0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff])], 'small.bin');
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);
    const nonce = Uint8Array.from({ length: 24 }, (_, index) => 0xa0 + index);
    const metadata = '{"name":"á🚀","thumb":"x"}';
    const encrypted = await encryptForTest(service, file, key, nonce, metadata);

    expect(toHex(new Uint8Array(await encrypted.arrayBuffer())))
      .toBe('a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b707000000000000004b4153321d000000d59e8a69cbe9577dd17618db4f6e3a3f55a2cae862ebde1650ea0b221a6fe080307703b49250763d1fc5c3d56e234a5aee8bb57dc6be37be9851ae029d45ed086237a35b');
  });

  it('E.1A yields the header before reading plaintext and preserves part order', async () => {
    const slice = jasmine.createSpy('slice').and.returnValue(new Blob([new Uint8Array([0x42])]));
    const file = { size: 1, slice } as unknown as File;
    const iterator = service.encryptFileParts(file, new Uint8Array(32).fill(1), new Uint8Array(24).fill(2));

    const header = await iterator.next();
    expect(header.done).toBeFalse();
    expect(header.value.size).toBe(32);
    expect(slice).not.toHaveBeenCalled();

    const data = await iterator.next();
    expect(data.done).toBeFalse();
    expect(data.value.size).toBe(17);
    expect(slice).toHaveBeenCalledTimes(1);
    expect((await iterator.next()).done).toBeTrue();
  });

  it('E.1A does not read the next Kasumi chunk before the consumer requests it', async () => {
    const plaintext = new Uint8Array(KASUMI_CHUNK_SIZE * 2 + 1);
    const file = new File([plaintext], 'backpressure.bin');
    const slice = spyOn(file, 'slice').and.callThrough();
    const iterator = service.encryptFileParts(file, new Uint8Array(32).fill(1), new Uint8Array(24).fill(2));

    await iterator.next();
    await iterator.next();
    expect(slice).toHaveBeenCalledTimes(1);
    await iterator.next();
    expect(slice).toHaveBeenCalledTimes(2);
  });

  it('E.1A collects the same bytes through the test collector and the incremental producer', async () => {
    const plaintext = new Uint8Array(KASUMI_CHUNK_SIZE + 17);
    plaintext[KASUMI_CHUNK_SIZE - 1] = 0x2a;
    plaintext[KASUMI_CHUNK_SIZE] = 0x7e;
    const file = new File([plaintext], 'multi.bin');
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);
    const nonce = Uint8Array.from({ length: 24 }, (_, index) => 0xa0 + index);
    const metadata = '{"name":"á🚀","thumb":"x"}';
    const collected = await encryptForTest(service, file, key, nonce, metadata);
    const incremental = new Blob(await collectParts(service.encryptFileParts(file, key, nonce, metadata)));

    expect(new Uint8Array(await incremental.arrayBuffer())).toEqual(new Uint8Array(await collected.arrayBuffer()));
    expect(await sha256(incremental)).toBe('1b683ed155f65c8ac13c58384655ed3d925b50e834dd17c8498d58e7a3d22ed7');
  });

  it('E.1A preserves the PRE KAS1 multichunk golden digest', async () => {
    const plaintext = new Uint8Array(KASUMI_CHUNK_SIZE + 17);
    plaintext[KASUMI_CHUNK_SIZE - 1] = 0x2a;
    plaintext[KASUMI_CHUNK_SIZE] = 0x7e;
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);
    const nonce = Uint8Array.from({ length: 24 }, (_, index) => 0xa0 + index);
    const encrypted = await encryptForTest(service, new File([plaintext], 'multi.bin'), key, nonce);

    expect(encrypted.size).toBe(4_194_385);
    expect(await sha256(encrypted)).toBe('a8ed43b6f1ab11ae81bcc80cd9a6a9b1fc12795108078b8065319fb2eeb9a735');
  });

  it('E.1A rejects cancellation before the first generator yield', async () => {
    const controller = new AbortController();
    controller.abort();
    const slice = jasmine.createSpy('slice');
    const iterator = service.encryptFileParts(
      { size: 1, slice } as unknown as File,
      new Uint8Array(32),
      new Uint8Array(24),
      undefined,
      controller.signal,
    );

    await expectAsync(iterator.next()).toBeRejectedWithError('Operation aborted');
    expect(slice).not.toHaveBeenCalled();
  });

  it('E.1A observes cancellation between yields before reading the next chunk', async () => {
    const controller = new AbortController();
    const slice = jasmine.createSpy('slice').and.returnValue(new Blob([new Uint8Array([0x42])]));
    const iterator = service.encryptFileParts(
      { size: 1, slice } as unknown as File,
      new Uint8Array(32),
      new Uint8Array(24),
      undefined,
      controller.signal,
    );

    await iterator.next();
    controller.abort();
    await expectAsync(iterator.next()).toBeRejectedWithError('Operation aborted');
    expect(slice).not.toHaveBeenCalled();
  });

  it('E.1A observes cancellation after an in-flight read and does not yield its ciphertext', async () => {
    const controller = new AbortController();
    const readStarted = deferred<void>();
    const read = deferred<ArrayBuffer>();
    const slice = jasmine.createSpy('slice').and.returnValue({
      arrayBuffer: () => {
        readStarted.resolve();
        return read.promise;
      },
    });
    const iterator = service.encryptFileParts(
      { size: 1, slice } as unknown as File,
      new Uint8Array(32),
      new Uint8Array(24),
      undefined,
      controller.signal,
    );

    await iterator.next();
    const pending = iterator.next();
    await readStarted.promise;
    controller.abort();
    read.resolve(new ArrayBuffer(1));

    await expectAsync(pending).toBeRejectedWithError('Operation aborted');
    expect(slice).toHaveBeenCalledTimes(1);
    expect((await iterator.next()).done).toBeTrue();
  });

  it('extracts only the bounded base-nonce prefix', async () => {
    const encrypted = new Blob([new Uint8Array(32).fill(0x42)]);
    const slice = spyOn(encrypted, 'slice').and.callThrough();

    const nonce = await service.extractBaseNonce(encrypted);

    expect(Array.from(nonce)).toEqual(new Array(24).fill(0x42));
    expect(slice).toHaveBeenCalledWith(0, 24);
  });

  it('rejects ciphertext too short to contain a base nonce and header size', async () => {
    await expectAsync(service.extractBaseNonce(new Blob([new Uint8Array(31)])))
      .toBeRejectedWithError('Encrypted file is too small');
  });

  it('preserves KAS1 bytes when a multichunk ciphertext is rematerialized', async () => {
    const plaintext = new Uint8Array(KASUMI_CHUNK_SIZE + 17);
    plaintext[KASUMI_CHUNK_SIZE - 1] = 0x2a;
    plaintext[KASUMI_CHUNK_SIZE] = 0x7e;
    const key = new Uint8Array(32).fill(0x41);
    const baseNonce = Uint8Array.from({ length: 24 }, (_, index) => index + 1);
    const original = await encryptForTest(service, new File([plaintext], 'kas1.bin'), key, baseNonce);

    const extractedNonce = await service.extractBaseNonce(original);
    const rematerialized = await encryptForTest(service, new File([plaintext], 'kas1.bin'), key, extractedNonce);

    expect(Array.from(new Uint8Array(await rematerialized.arrayBuffer())))
      .toEqual(Array.from(new Uint8Array(await original.arrayBuffer())));
  });

  it('preserves KAS2 bytes when metadata and ciphertext span multiple chunks', async () => {
    const plaintext = new Uint8Array(KASUMI_CHUNK_SIZE + 17).fill(0x53);
    const metadata = 'thumbnail-data-✓';
    const key = new Uint8Array(32).fill(0x52);
    const baseNonce = Uint8Array.from({ length: 24 }, (_, index) => 0xa0 + index);
    const original = await encryptForTest(service, new File([plaintext], 'kas2.bin'), key, baseNonce, metadata);

    const extractedNonce = await service.extractBaseNonce(original);
    const rematerialized = await encryptForTest(service, new File([plaintext], 'kas2.bin'), key, extractedNonce, metadata);

    expect(Array.from(new Uint8Array(await rematerialized.arrayBuffer())))
      .toEqual(Array.from(new Uint8Array(await original.arrayBuffer())));
  });

  it('should resolve and reject vault-key worker responses', async () => {
    const worker: any = {
      terminate: jasmine.createSpy('terminate'),
      postMessage: () => worker.onmessage({ data: { success: true, key: new Uint8Array(32) } })
    };
    const workerSpy = spyOn(globalThis as any, 'Worker').and.returnValue(worker);

    await expectAsync(service.deriveVaultKey('phrase', 'salt')).toBeResolvedTo(jasmine.any(Uint8Array));
    expect(worker.terminate).toHaveBeenCalled();

    const failedWorker: any = {
      terminate: jasmine.createSpy('terminate'),
      postMessage: () => failedWorker.onmessage({ data: { success: false, error: 'worker failed' } })
    };
    workerSpy.and.returnValue(failedWorker);
    await expectAsync(service.deriveVaultKey('phrase', 'salt')).toBeRejectedWithError('worker failed');
  });

  it('should hash names deterministically', async () => {
    const first = await service.hashName('arquivo.txt');
    const second = await service.hashName('arquivo.txt');

    expect(first).toBe(second);
    expect(first).not.toBe('');
  });

  it('should encrypt and decrypt names', async () => {
    const key = new Uint8Array(32).fill(7);
    const encrypted = await service.encryptName('nome secreto', key);

    expect(await service.decryptName(encrypted, key)).toBe('nome secreto');
  });

  it('should reject invalid name keys and ciphertexts', async () => {
    const invalidKey = new Uint8Array(31);

    await expectAsync(service.encryptName('x', invalidKey)).toBeRejectedWithError('Key must be 32 bytes');
    await expectAsync(service.decryptName('x', invalidKey)).toBeRejectedWithError('Key must be 32 bytes');
    await expectAsync(service.decryptName('eA', new Uint8Array(32))).toBeRejectedWithError('Invalid ciphertext length');

    const encrypted = await service.encryptName('x', new Uint8Array(32).fill(1));
    await expectAsync(service.decryptName(encrypted, new Uint8Array(32).fill(2))).toBeRejected();
  });

  it('should encrypt and decrypt a v1 file', async () => {
    const key = new Uint8Array(32).fill(1);
    const nonce = new Uint8Array(24).fill(2);
    const file = new File(['conteudo'], 'arquivo.txt');

    const encrypted = await encryptForTest(service, file, key, nonce);
    const decrypted = await service.decryptFile(encrypted, key, encrypted.size);

    expect(await decrypted.text()).toBe('conteudo');
    const metadata = await service.extractMetadata(encrypted, key, encrypted.size);
    expect(metadata.metadata).toBeNull();
    expect(metadata.dataOffset).toBe(32);
  });

  it('should encrypt and decrypt a v2 file with metadata', async () => {
    const key = new Uint8Array(32).fill(3);
    const nonce = new Uint8Array(24).fill(4);
    const file = new File(['imagem'], 'imagem.jpg');
    const metadata = JSON.stringify({ thumb: 'data:image/png;base64,AA==' });

    const encrypted = await encryptForTest(service, file, key, nonce, metadata);
    const extracted = await service.extractMetadata(encrypted, key, encrypted.size);
    const decrypted = await service.decryptFile(encrypted, key, encrypted.size);

    expect(extracted.metadata).toBe(metadata);
    expect(extracted.dataOffset).toBeGreaterThan(32);
    expect(extracted.expectedSize).toBe(file.size);
    expect(await decrypted.text()).toBe('imagem');
  });

  it('should preserve the V1 empty-file format and decrypt to an empty Blob', async () => {
    const encrypted = await encryptForTest(service, new File([], 'empty.bin'), new Uint8Array(32).fill(1), new Uint8Array(24).fill(2));

    expect(encrypted.size).toBe(32);
    await expectAsync(service.decryptFile(encrypted, new Uint8Array(32).fill(1), encrypted.size)).toBeResolvedTo(jasmine.any(Blob));
    expect((await service.decryptFile(encrypted, new Uint8Array(32).fill(1), encrypted.size)).size).toBe(0);
  });

  it('should preserve the V2 empty-file format and exact metadata offset', async () => {
    const metadata = 'meta';
    const encrypted = await encryptForTest(service, new File([], 'empty.bin'), new Uint8Array(32).fill(3), new Uint8Array(24).fill(4), metadata);

    expect(encrypted.size).toBe(40 + 16 + new TextEncoder().encode(metadata).length);
    await expectAsync(service.decryptFile(encrypted, new Uint8Array(32).fill(3), encrypted.size)).toBeResolved();
    await expectAsync(service.extractMetadata(encrypted, new Uint8Array(32).fill(3), encrypted.size))
      .toBeResolvedTo(jasmine.objectContaining({ dataOffset: 40 + 16 + 4 }));
  });

  it('calculates exact KAS1 geometry at every data-chunk boundary', () => {
    const sizes = [0, 1, KASUMI_CHUNK_SIZE - 1, KASUMI_CHUNK_SIZE, KASUMI_CHUNK_SIZE + 1];
    for (const size of sizes) {
      const chunks = size === 0 ? 0 : Math.ceil(size / KASUMI_CHUNK_SIZE);
      expect(service.calculateEncryptedSize(size)).toBe(32 + size + chunks * 16);
    }
  });

  it('calculates KAS2 geometry with UTF-8 metadata and keeps empty metadata on KAS1', () => {
    const metadata = '{"thumb":"á😀漢字"}';
    const metadataBytes = new TextEncoder().encode(metadata).length;
    const expected = 56 + metadataBytes + 1 + 16;

    expect(service.calculateEncryptedSize(1, metadata)).toBe(expected);
    expect(service.calculateEncryptedSize(1, '')).toBe(32 + 1 + 16);
  });

  it('matches the real KAS2 writer size for multibyte metadata', async () => {
    const file = new File(['payload'], 'geometry.bin');
    const key = new Uint8Array(32).fill(7);
    const metadata = '{"thumb":"á😀漢字"}';
    const encrypted = await encryptForTest(service, file, key, new Uint8Array(24).fill(8), metadata);

    expect(service.calculateEncryptedSize(file.size, metadata)).toBe(encrypted.size);
  });

  it('fails closed for invalid or unsafe geometry', () => {
    for (const size of [-1, 0.5, NaN, Infinity]) {
      expect(() => service.calculateEncryptedSize(size)).toThrowError('Invalid plaintext size');
    }
    expect(() => service.calculateEncryptedSize(Number.MAX_SAFE_INTEGER - 1)).toThrowError('Encrypted size is too large');
    expect(() => service.calculateEncryptedSize(0, 'x'.repeat(KASUMI_MAX_METADATA_SIZE + 1)))
      .toThrowError('Kasumi metadata is too large');
  });

  it('should measure KAS2 metadata with UTF-8 bytes rather than string length', async () => {
    const metadata = '{"name":"á🚀"}';
    const key = new Uint8Array(32).fill(5);
    const encrypted = await encryptForTest(service, new File(['payload'], 'x'), key, new Uint8Array(24).fill(6), metadata);
    const expectedOffset = 40 + 16 + new TextEncoder().encode(metadata).length;

    const extracted = await service.extractMetadata(encrypted, key, encrypted.size);
    expect(extracted.metadata).toBe(metadata);
    expect(extracted.dataOffset).toBe(expectedOffset);
    expect(await (await service.decryptFile(encrypted, key, encrypted.size)).text()).toBe('payload');
  });

  it('keeps an empty metadata string on the existing V1 writer path', async () => {
    const encrypted = await encryptForTest(service, new File([], 'empty.bin'), new Uint8Array(32).fill(7), new Uint8Array(24).fill(8), '');

    expect(encrypted.size).toBe(32);
    await expectAsync(service.decryptFile(encrypted, new Uint8Array(32).fill(7), encrypted.size)).toBeResolved();
  });

  it('decrypts exactly one data chunk at the 4 MiB boundary', async () => {
    const bytes = new Uint8Array(KASUMI_CHUNK_SIZE);
    bytes[0] = 0x11;
    bytes[KASUMI_CHUNK_SIZE - 1] = 0xee;
    const key = new Uint8Array(32).fill(9);
    const encrypted = await encryptForTest(service, new File([bytes], 'boundary.bin'), key, new Uint8Array(24).fill(10));

    expect(encrypted.size).toBe(32 + 16 + KASUMI_CHUNK_SIZE);
    expect(new Uint8Array(await (await service.decryptFile(encrypted, key, encrypted.size)).arrayBuffer())).toEqual(bytes);
  });

  it('decrypts two data chunks at the 4 MiB plus one boundary', async () => {
    const bytes = new Uint8Array(KASUMI_CHUNK_SIZE + 1);
    bytes[0] = 0x22;
    bytes[KASUMI_CHUNK_SIZE] = 0xdd;
    const key = new Uint8Array(32).fill(11);
    const encrypted = await encryptForTest(service, new File([bytes], 'two-chunks.bin'), key, new Uint8Array(24).fill(12));

    expect(encrypted.size).toBe(32 + bytes.length + 2 * 16);
    expect(new Uint8Array(await (await service.decryptFile(encrypted, key, encrypted.size)).arrayBuffer())).toEqual(bytes);
  });

  it('rejects authentication failure in the second data chunk without returning partial plaintext', async () => {
    const bytes = new Uint8Array(KASUMI_CHUNK_SIZE + 1).fill(0x33);
    const key = new Uint8Array(32).fill(13);
    const encrypted = await encryptForTest(service, new File([bytes], 'tamper.bin'), key, new Uint8Array(24).fill(14));
    const secondChunkMacOffset = 32 + 16 + KASUMI_CHUNK_SIZE;

    await expectAsync(service.decryptFile(await mutateByte(encrypted, secondChunkMacOffset), key, encrypted.size))
      .toBeRejectedWithError(/Authentication failed at chunk 1/);
  });

  it('should reject malformed file inputs', async () => {
    const key = new Uint8Array(32);

    await expectAsync(encryptForTest(service, new File(['x'], 'x'), new Uint8Array(31)))
      .toBeRejectedWithError('Key must be 32 bytes');
    await expectAsync(service.decryptFile(new Blob(['short']), key, 5))
      .toBeRejectedWithError('Encrypted file is too small to contain header');
    await expectAsync(service.extractMetadata(new Blob(['short']), key, 5))
      .toBeRejectedWithError('Partial blob is too small to contain header');
    await expectAsync(service.extractMetadata(new Blob([new Uint8Array(32)]), new Uint8Array(31), 32))
      .toBeRejectedWithError('Key must be 32 bytes');
    await expectAsync(service.decryptFile(new Blob([new Uint8Array(32)]), new Uint8Array(31), 32))
      .toBeRejectedWithError('Key must be 32 bytes');

    const malformedHeader = new ArrayBuffer(32);
    new DataView(malformedHeader).setBigUint64(24, BigInt(1), true);
    await expectAsync(service.decryptFile(new Blob([malformedHeader]), key, 32))
      .toBeRejectedWithError('File corrupted or truncated');
    await expectAsync(service.decryptFile(new Blob([new Uint8Array(32)]), new Uint8Array(33), 32))
      .toBeRejectedWithError('Key must be 32 bytes');
  });

  it('B.71.B rejects an already-aborted encryption before reading file data', async () => {
    const controller = new AbortController();
    controller.abort();
    const slice = jasmine.createSpy('slice');
    const file = { size: 1, slice } as unknown as File;
    const iterator = service.encryptFileParts(
      file,
      new Uint8Array(32),
      new Uint8Array(24),
      undefined,
      controller.signal,
    );

    let error: unknown;
    try {
      await iterator.next();
    } catch (caught) {
      error = caught;
    }

    expect(error).toEqual(jasmine.any(DOMException));
    if (error instanceof DOMException) expect(error.name).toBe('AbortError');
    expect(slice).not.toHaveBeenCalled();
  });

  it('B.71.B stops after cancellation during an in-flight chunk read', async () => {
    const controller = new AbortController();
    const firstRead = deferred<ArrayBuffer>();
    const readStarted = deferred<void>();
    let readCount = 0;
    const slice = jasmine.createSpy('slice').and.callFake(() => ({
      arrayBuffer: () => {
        readCount++;
        if (readCount === 1) {
          readStarted.resolve();
          return firstRead.promise;
        }
        return Promise.resolve(new ArrayBuffer(KASUMI_CHUNK_SIZE));
      },
    }));
    const file = { size: KASUMI_CHUNK_SIZE * 2, slice } as unknown as File;
    const iterator = service.encryptFileParts(
      file,
      new Uint8Array(32),
      new Uint8Array(24),
      undefined,
      controller.signal,
    );
    await iterator.next();
    const encryption = iterator.next();

    await readStarted.promise;
    controller.abort();
    firstRead.resolve(new ArrayBuffer(KASUMI_CHUNK_SIZE));

    let error: unknown;
    try {
      await encryption;
    } catch (caught) {
      error = caught;
    }

    expect(error).toEqual(jasmine.any(DOMException));
    if (error instanceof DOMException) expect(error.name).toBe('AbortError');
    expect(slice).toHaveBeenCalledTimes(1);
  });

  it('B.71.B preserves KAS1 bytes when the signal is not aborted', async () => {
    const file = new File(['payload'], 'payload.bin');
    const key = new Uint8Array(32).fill(41);
    const nonce = new Uint8Array(24).fill(42);
    const baseline = await encryptForTest(service, file, key, nonce);
    const signaled = await encryptForTest(service, file, key, nonce, undefined, new AbortController().signal);

    expect(new Uint8Array(await signaled.arrayBuffer())).toEqual(new Uint8Array(await baseline.arrayBuffer()));
  });

  it('B.71.B preserves KAS2 bytes when the signal is not aborted', async () => {
    const file = new File(['payload'], 'payload.bin');
    const key = new Uint8Array(32).fill(43);
    const nonce = new Uint8Array(24).fill(44);
    const metadata = '{"thumb":"data:image/png;base64,AA=="}';
    const baseline = await encryptForTest(service, file, key, nonce, metadata);
    const signaled = await encryptForTest(service, file, key, nonce, metadata, new AbortController().signal);

    expect(new Uint8Array(await signaled.arrayBuffer())).toEqual(new Uint8Array(await baseline.arrayBuffer()));
  });

  it('should reject truncated and unauthenticated chunks', async () => {
    const key = new Uint8Array(32).fill(5);
    const encrypted = await encryptForTest(service, new File(['payload'], 'x'), key, new Uint8Array(24));
    const truncated = encrypted.slice(0, encrypted.size - 1);

    await expectAsync(service.decryptFile(truncated, key, encrypted.size)).toBeRejectedWithError('File corrupted or truncated');
    await expectAsync(service.decryptFile(encrypted, new Uint8Array(32).fill(6), encrypted.size))
      .toBeRejectedWithError(/Authentication failed at chunk 0/);
    await expectAsync(service.decryptFileChunk(new Uint8Array([1]), new Uint8Array(16), new Uint8Array(24), 0, key))
      .toBeRejectedWithError(/Authentication failed at chunk 0/);
  });

  it('rejects a valid V1 blob with trailing bytes', async () => {
    const key = new Uint8Array(32).fill(15);
    const encrypted = await encryptForTest(service, new File(['payload'], 'x'), key, new Uint8Array(24).fill(16));
    const bytes = new Uint8Array(encrypted.size + 1);
    bytes.set(new Uint8Array(await encrypted.arrayBuffer()));
    bytes[bytes.length - 1] = 0xaa;

    await expectAsync(service.decryptFile(new Blob([bytes]), key, encrypted.size)).toBeRejected();
  });

  it('rejects a valid V2 blob with trailing bytes', async () => {
    const key = new Uint8Array(32).fill(17);
    const encrypted = await encryptForTest(service, new File(['payload'], 'x'), key, new Uint8Array(24).fill(18), 'meta');
    const bytes = new Uint8Array(encrypted.size + 1);
    bytes.set(new Uint8Array(await encrypted.arrayBuffer()));
    bytes[bytes.length - 1] = 0xbb;

    await expectAsync(service.decryptFile(new Blob([bytes]), key, encrypted.size)).toBeRejected();
  });

  it('rejects smaller and larger tampered plaintext-size headers', async () => {
    const key = new Uint8Array(32).fill(19);
    const encrypted = await encryptForTest(service, new File(['payload'], 'x'), key, new Uint8Array(24).fill(20));

    await expectAsync(service.decryptFile(await patchUint64(encrypted, 1n), key, encrypted.size)).toBeRejected();
    await expectAsync(service.decryptFile(await patchUint64(encrypted, 999n), key, encrypted.size)).toBeRejected();
  });

  it('rejects malicious uint64 sizes without allocating their declared size', async () => {
    const key = new Uint8Array(32).fill(21);
    const header = new Uint8Array(32);
    header.set(new Uint8Array(24).fill(22));

    await expectAsync(service.decryptFile(await patchUint64(new Blob([header]), 2n ** 53n), key, 32))
      .toBeRejectedWithError('File corrupted or truncated');
    await expectAsync(service.decryptFile(await patchUint64(new Blob([header]), 0xffffffffffffffffn), key, 32))
      .toBeRejectedWithError('File corrupted or truncated');
  });

  it('rejects a KAS2 blob with a corrupted magic marker', async () => {
    const key = new Uint8Array(32).fill(23);
    const encrypted = await encryptForTest(service, new File(['payload'], 'x'), key, new Uint8Array(24).fill(24), 'meta');

    await expectAsync(service.decryptFile(await mutateByte(encrypted, 32), key, encrypted.size)).toBeRejected();
  });

  it('should reject incomplete and invalid v2 metadata', async () => {
    const key = new Uint8Array(32).fill(8);
    const encrypted = await encryptForTest(service, new File(['x'], 'x'), key, new Uint8Array(24), 'meta');

    await expectAsync(service.extractMetadata(encrypted.slice(0, 40), key, encrypted.size))
      .toBeRejectedWithError('Partial blob is too small to contain the full metadata block');
    await expectAsync(service.extractMetadata(encrypted, new Uint8Array(32).fill(9), encrypted.size))
      .toBeRejectedWithError('Failed to authenticate or decrypt KAS2 metadata');
  });

  it('rejects a KAS2 prefix without its metadata MAC and ciphertext', async () => {
    const key = new Uint8Array(32).fill(25);
    const encrypted = await encryptForTest(service, new File([], 'empty.bin'), key, new Uint8Array(24).fill(26), 'meta');

    await expectAsync(service.decryptFile(encrypted.slice(0, 40), key, encrypted.size))
      .toBeRejectedWithError('File corrupted or truncated');
  });

  it('rejects a KAS2 blob with a truncated metadata MAC', async () => {
    const key = new Uint8Array(32).fill(27);
    const encrypted = await encryptForTest(service, new File([], 'empty.bin'), key, new Uint8Array(24).fill(28), 'meta');

    await expectAsync(service.decryptFile(encrypted.slice(0, 40 + 15), key, encrypted.size))
      .toBeRejectedWithError('File corrupted or truncated');
  });

  it('rejects a KAS2 blob with truncated metadata ciphertext', async () => {
    const key = new Uint8Array(32).fill(29);
    const encrypted = await encryptForTest(service, new File([], 'empty.bin'), key, new Uint8Array(24).fill(30), 'meta');

    await expectAsync(service.decryptFile(encrypted.slice(0, encrypted.size - 1), key, encrypted.size))
      .toBeRejectedWithError('File corrupted or truncated');
  });

  it('rejects a KAS2 blob whose declared metadata size shifts the boundary', async () => {
    const key = new Uint8Array(32).fill(31);
    const encrypted = await encryptForTest(service, new File([], 'empty.bin'), key, new Uint8Array(24).fill(32), 'meta');

    await expectAsync(service.decryptFile(await patchUint32(encrypted, 36, 0), key, encrypted.size))
      .toBeRejectedWithError('Failed to authenticate or decrypt KAS2 metadata');
    await expectAsync(service.decryptFile(await patchUint32(encrypted, 36, 0xffffffff), key, encrypted.size))
      .toBeRejectedWithError('File corrupted or truncated');
  });

  it('preserves the caller-owned FDK after successful decryption', async () => {
    const key = new Uint8Array(32).fill(0x5a);
    const snapshot = key.slice();
    const encrypted = await encryptForTest(service, new File(['payload'], 'x'), key, new Uint8Array(24).fill(33));

    await service.decryptFile(encrypted, key, encrypted.size);

    expect(key).toEqual(snapshot);
  });

  it('preserves the caller-owned FDK after wrong-key and tamper failures', async () => {
    const key = new Uint8Array(32).fill(0x6a);
    const snapshot = key.slice();
    const wrongKey = new Uint8Array(32).fill(0x6b);
    const wrongKeySnapshot = wrongKey.slice();
    const encrypted = await encryptForTest(service, new File(['payload'], 'x'), key, new Uint8Array(24).fill(34));

    await expectAsync(service.decryptFile(encrypted, wrongKey, encrypted.size)).toBeRejected();
    expect(wrongKey).toEqual(wrongKeySnapshot);
    expect(key).toEqual(snapshot);
    await expectAsync(service.decryptFile(await mutateByte(encrypted, 32), key, encrypted.size)).toBeRejected();
    expect(key).toEqual(snapshot);
  });

  it('B.64 rejects coordinated KAS1 suffix truncation with a smaller originalSize', async () => {
    const plaintext = new Uint8Array(KASUMI_CHUNK_SIZE + 17);
    plaintext[0] = 0x11;
    plaintext[KASUMI_CHUNK_SIZE - 1] = 0x22;
    plaintext[KASUMI_CHUNK_SIZE] = 0x33;
    plaintext[plaintext.length - 1] = 0x44;
    const key = new Uint8Array(32).fill(0x55);
    const encrypted = await encryptForTest(service, new File([plaintext], 'b64-kas1.bin'), key, new Uint8Array(24).fill(0x66));
    const trustedEncryptedSize = encrypted.size;
    const attackedBytes = new Uint8Array(await encrypted.arrayBuffer()).slice(0, 32 + 16 + KASUMI_CHUNK_SIZE);
    new DataView(attackedBytes.buffer).setBigUint64(24, BigInt(KASUMI_CHUNK_SIZE), true);

    expect(trustedEncryptedSize).toBeGreaterThan(attackedBytes.length);
    await expectAsync(service.decryptFile(new Blob([attackedBytes]), key, trustedEncryptedSize))
      .toBeRejectedWithError('File corrupted or truncated');
  });

  it('B.64 rejects a non-empty KAS1 container forged as empty', async () => {
    const key = new Uint8Array(32).fill(0x57);
    const encrypted = await encryptForTest(service, new File(['not-empty'], 'b64-empty.bin'), key, new Uint8Array(24).fill(0x67));
    const trustedEncryptedSize = encrypted.size;
    const forgedHeader = new Uint8Array(await encrypted.slice(0, 32).arrayBuffer());
    new DataView(forgedHeader.buffer).setBigUint64(24, 0n, true);

    expect(trustedEncryptedSize).toBeGreaterThan(forgedHeader.length);
    await expectAsync(service.decryptFile(new Blob([forgedHeader]), key, trustedEncryptedSize))
      .toBeRejectedWithError('File corrupted or truncated');
  });

  it('B.64 authenticates the KAS2 metadata MAC during full decrypt', async () => {
    const key = new Uint8Array(32).fill(0x58);
    const metadata = '{"thumb":"data:image/webp;base64,AA=="}';
    const encrypted = await encryptForTest(service, new File(['payload'], 'b64-meta.bin'), key, new Uint8Array(24).fill(0x68), metadata);
    const attacked = new Uint8Array(await encrypted.arrayBuffer());
    attacked[40] ^= 0x01;

    await expectAsync(service.decryptFile(new Blob([attacked]), key, encrypted.size))
      .toBeRejectedWithError('Failed to authenticate or decrypt KAS2 metadata');
    await expectAsync(service.extractMetadata(new Blob([attacked]), key, encrypted.size))
      .toBeRejectedWithError('Failed to authenticate or decrypt KAS2 metadata');
  });

  it('B.64 rejects coordinated KAS2 suffix truncation with a smaller originalSize', async () => {
    const plaintext = new Uint8Array(KASUMI_CHUNK_SIZE + 17);
    plaintext[0] = 0x19;
    plaintext[KASUMI_CHUNK_SIZE] = 0x39;
    const metadata = 'b64-kas2-metadata';
    const key = new Uint8Array(32).fill(0x59);
    const encrypted = await encryptForTest(service, new File([plaintext], 'b64-kas2.bin'), key, new Uint8Array(24).fill(0x69), metadata);
    const trustedEncryptedSize = encrypted.size;
    const metadataSize = new TextEncoder().encode(metadata).length;
    const dataOffset = 40 + 16 + metadataSize;
    const attackedBytes = new Uint8Array(await encrypted.arrayBuffer()).slice(0, dataOffset + 16 + KASUMI_CHUNK_SIZE);
    new DataView(attackedBytes.buffer).setBigUint64(24, BigInt(KASUMI_CHUNK_SIZE), true);

    expect(trustedEncryptedSize).toBeGreaterThan(attackedBytes.length);
    await expectAsync(service.decryptFile(new Blob([attackedBytes]), key, trustedEncryptedSize))
      .toBeRejectedWithError('File corrupted or truncated');
  });

  it('B.64 rejects oversized KAS2 metadata before authentication during full decrypt', async () => {
    const key = new Uint8Array(32).fill(0x5b);
    const metaSize = KASUMI_MAX_METADATA_SIZE + 1;
    const bytes = new Uint8Array(KASUMI_KAS2_METADATA_PREFIX_SIZE + metaSize);
    bytes.fill(0xa5);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(24, 0n, true);
    bytes.set(new TextEncoder().encode('KAS2'), 32);
    view.setUint32(36, metaSize, true);
    const attacked = new Blob([bytes]);

    await expectAsync(service.decryptFile(attacked, key, attacked.size))
      .toBeRejectedWithError('File corrupted or truncated');
  });

  it('B.64 rejects oversized KAS2 metadata before authentication during extraction', async () => {
    const key = new Uint8Array(32).fill(0x5c);
    const metaSize = KASUMI_MAX_METADATA_SIZE + 1;
    const bytes = new Uint8Array(KASUMI_KAS2_METADATA_PREFIX_SIZE + metaSize);
    bytes.fill(0xb6);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(24, 0n, true);
    bytes.set(new TextEncoder().encode('KAS2'), 32);
    view.setUint32(36, metaSize, true);
    const attacked = new Blob([bytes]);

    await expectAsync(service.extractMetadata(attacked, key, attacked.size))
      .toBeRejectedWithError('File corrupted or truncated');
  });

  it('B.64 keeps the metadata boundary inclusive and rejects one byte above it in the writer', async () => {
    const key = new Uint8Array(32).fill(0x5d);
    const nonce = new Uint8Array(24).fill(0x6d);
    const validMetadata = 'a'.repeat(KASUMI_MAX_METADATA_SIZE);
    const oversizedMetadata = `${validMetadata}b`;

    await expectAsync(encryptForTest(service, new File([], 'max.bin'), key, nonce, validMetadata)).toBeResolved();
    await expectAsync(encryptForTest(service, new File([], 'oversized.bin'), key, nonce, oversizedMetadata))
      .toBeRejectedWithError('Kasumi metadata is too large');
  });

  it('B.64 extractMetadata rejects coordinated KAS1 originalSize forgery', async () => {
    const plaintext = new Uint8Array(KASUMI_CHUNK_SIZE + 17);
    const key = new Uint8Array(32).fill(0x5e);
    const encrypted = await encryptForTest(service, new File([plaintext], 'extract-kas1.bin'), key, new Uint8Array(24).fill(0x6e));
    const forgedHeader = await patchUint64(encrypted.slice(0, 32), BigInt(KASUMI_CHUNK_SIZE));

    await expectAsync(service.extractMetadata(forgedHeader, key, encrypted.size))
      .toBeRejectedWithError('File corrupted or truncated');
  });

  it('B.64 extractMetadata rejects coordinated KAS2 originalSize forgery', async () => {
    const plaintext = new Uint8Array(KASUMI_CHUNK_SIZE + 17);
    const metadata = 'extract-kas2-metadata';
    const key = new Uint8Array(32).fill(0x5f);
    const encrypted = await encryptForTest(
      service,
      new File([plaintext], 'extract-kas2.bin'),
      key,
      new Uint8Array(24).fill(0x6f),
      metadata,
    );
    const metadataSize = new TextEncoder().encode(metadata).length;
    const dataOffset = KASUMI_KAS2_METADATA_PREFIX_SIZE + metadataSize;
    const forgedPrefix = new Uint8Array(await encrypted.slice(0, dataOffset).arrayBuffer());
    new DataView(forgedPrefix.buffer).setBigUint64(24, BigInt(KASUMI_CHUNK_SIZE), true);

    await expectAsync(service.extractMetadata(new Blob([forgedPrefix]), key, encrypted.size))
      .toBeRejectedWithError('File corrupted or truncated');
  });
});
