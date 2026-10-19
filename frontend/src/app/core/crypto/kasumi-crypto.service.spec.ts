import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { KasumiCryptoService } from './kasumi-crypto.service';

describe('KasumiCryptoService', () => {
  let service: KasumiCryptoService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), KasumiCryptoService]
    });
    service = TestBed.inject(KasumiCryptoService);
  });

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

    const encrypted = await service.encryptFile(file, key, nonce);
    const decrypted = await service.decryptFile(encrypted, key);

    expect(await decrypted.text()).toBe('conteudo');
    const metadata = await service.extractMetadata(encrypted, key);
    expect(metadata.metadata).toBeNull();
    expect(metadata.dataOffset).toBe(32);
  });

  it('should encrypt and decrypt a v2 file with metadata', async () => {
    const key = new Uint8Array(32).fill(3);
    const nonce = new Uint8Array(24).fill(4);
    const file = new File(['imagem'], 'imagem.jpg');
    const metadata = JSON.stringify({ thumb: 'data:image/png;base64,AA==' });

    const encrypted = await service.encryptFile(file, key, nonce, metadata);
    const extracted = await service.extractMetadata(encrypted, key);
    const decrypted = await service.decryptFile(encrypted, key);

    expect(extracted.metadata).toBe(metadata);
    expect(extracted.dataOffset).toBeGreaterThan(32);
    expect(extracted.expectedSize).toBe(file.size);
    expect(await decrypted.text()).toBe('imagem');
  });

  it('should reject malformed file inputs', async () => {
    const key = new Uint8Array(32);

    await expectAsync(service.encryptFile(new File(['x'], 'x'), new Uint8Array(31)))
      .toBeRejectedWithError('Key must be 32 bytes');
    await expectAsync(service.decryptFile(new Blob(['short']), key))
      .toBeRejectedWithError('Encrypted file is too small to contain header');
    await expectAsync(service.extractMetadata(new Blob(['short']), key))
      .toBeRejectedWithError('Partial blob is too small to contain header');
    await expectAsync(service.extractMetadata(new Blob([new Uint8Array(32)]), new Uint8Array(31)))
      .toBeRejectedWithError('Key must be 32 bytes');
    await expectAsync(service.decryptFile(new Blob([new Uint8Array(32)]), new Uint8Array(31)))
      .toBeRejectedWithError('Key must be 32 bytes');

    const malformedHeader = new ArrayBuffer(32);
    new DataView(malformedHeader).setBigUint64(24, BigInt(1), true);
    await expectAsync(service.decryptFile(new Blob([malformedHeader]), key))
      .toBeRejectedWithError(/Size mismatch/);
  });

  it('should generate a nonce when none is supplied', async () => {
    const encrypted = await service.encryptFile(new File(['x'], 'x'), new Uint8Array(32));
    expect(encrypted.size).toBeGreaterThan(32);
  });

  it('should reject truncated and unauthenticated chunks', async () => {
    const key = new Uint8Array(32).fill(5);
    const encrypted = await service.encryptFile(new File(['payload'], 'x'), key, new Uint8Array(24));
    const truncated = encrypted.slice(0, encrypted.size - 1);

    await expectAsync(service.decryptFile(truncated, key)).toBeRejectedWithError('File corrupted or truncated');
    await expectAsync(service.decryptFile(encrypted, new Uint8Array(32).fill(6)))
      .toBeRejectedWithError(/Authentication failed at chunk 0/);
    await expectAsync(service.decryptFileChunk(new Uint8Array([1]), new Uint8Array(16), new Uint8Array(24), 0, key))
      .toBeRejectedWithError(/Authentication failed at chunk 0/);
  });

  it('should reject incomplete and invalid v2 metadata', async () => {
    const key = new Uint8Array(32).fill(8);
    const encrypted = await service.encryptFile(new File(['x'], 'x'), key, new Uint8Array(24), 'meta');

    await expectAsync(service.extractMetadata(encrypted.slice(0, 40), key))
      .toBeRejectedWithError('Partial blob is too small to contain the full metadata block');
    await expectAsync(service.extractMetadata(encrypted, new Uint8Array(32).fill(9)))
      .toBeRejectedWithError('Failed to authenticate or decrypt KAS2 metadata');
  });
});
