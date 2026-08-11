import { Injectable } from '@angular/core';
import _sodium from 'libsodium-wrappers-sumo';
import {
  KASUMI_CHUNK_SIZE,
  KASUMI_MAX_METADATA_SIZE,
} from './kasumi-format';
const NONCE_SIZE = 24;
const MAC_SIZE = 16;
const KEY_SIZE = 32;

@Injectable({ providedIn: 'root' })
export class KasumiCryptoService {
  constructor() {
    _sodium.ready.catch(e => console.error('Libsodium init error', e));
  }

  /**
   * Generates a random 24-byte Base Nonce for XChaCha20.
   */
  generateBaseNonce(): Uint8Array {
    return _sodium.randombytes_buf(NONCE_SIZE);
  }

  /**
   * Derives a specific chunk nonce by XORing the chunk_index into the last 8 bytes of the base_nonce.
   * Note: The chunk_index is expected to be processed as a little-endian 64-bit unsigned integer.
   */
  deriveChunkNonce(baseNonce: Uint8Array, chunkIndex: number): Uint8Array {
    const chunkNonce = new Uint8Array(baseNonce);
    // XORing the last 8 bytes (from index 16 to 23)
    let current = chunkIndex;
    for (let i = 0; i < 8; i++) {
      const byte = current & 0xff;
      chunkNonce[NONCE_SIZE - 1 - i] ^= byte;
      // Use Math.floor to simulate bitwise shift for numbers larger than 32 bits
      current = Math.floor(current / 256);
    }
    return chunkNonce;
  }

  /**
   * Derives a 32-byte Vault Key from a passphrase using Argon2id.
   * Runs in a Web Worker to avoid freezing the UI.
   */
  async deriveVaultKey(passphrase: string, saltString: string): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./crypto.worker', import.meta.url), {
        type: 'module'
      });

      worker.onmessage = ({ data }) => {
        if (data.success) {
          resolve(data.key);
        } else {
          reject(new Error(data.error));
        }
        worker.terminate();
      };

      worker.onerror = (err) => {
        reject(err);
        worker.terminate();
      };

      worker.postMessage({ passphrase, salt: saltString });
    });
  }

  /**
   * Hashes a string using Blake2b (for name_hash) and returns a Base64 string.
   */
  async hashName(name: string): Promise<string> {
    await _sodium.ready;
    const encoder = new TextEncoder();
    const hash = _sodium.crypto_generichash(32, encoder.encode(name), null);
    return _sodium.to_base64(hash, _sodium.base64_variants.URLSAFE_NO_PADDING);
  }

  /**
   * Encrypts a string (e.g. filename) using XChaCha20-Poly1305.
   * Format: base64( nonce(24) || mac(16) || ciphertext )
   */
  async encryptName(name: string, key: Uint8Array): Promise<string> {
    await _sodium.ready;
    if (key.length !== KEY_SIZE) throw new Error('Key must be 32 bytes');
    
    const encoder = new TextEncoder();
    const plaintext = encoder.encode(name);
    const nonce = this.generateBaseNonce();

    const encrypted = _sodium.crypto_aead_xchacha20poly1305_ietf_encrypt_detached(
      plaintext, null, null, nonce, key
    );

    const result = new Uint8Array(NONCE_SIZE + MAC_SIZE + encrypted.ciphertext.length);
    result.set(nonce, 0);
    result.set(encrypted.mac, NONCE_SIZE);
    result.set(encrypted.ciphertext, NONCE_SIZE + MAC_SIZE);

    return _sodium.to_base64(result, _sodium.base64_variants.URLSAFE_NO_PADDING);
  }

  /**
   * Decrypts a string (e.g. filename) using XChaCha20-Poly1305.
   * Throws on decryption failure (e.g. wrong key / corrupted ciphertext).
   */
  async decryptName(ciphertextBase64: string, key: Uint8Array): Promise<string> {
    await _sodium.ready;
    if (key.length !== KEY_SIZE) throw new Error('Key must be 32 bytes');

    const data = _sodium.from_base64(ciphertextBase64, _sodium.base64_variants.URLSAFE_NO_PADDING);
    if (data.length < NONCE_SIZE + MAC_SIZE) throw new Error('Invalid ciphertext length');

    const nonce = data.slice(0, NONCE_SIZE);
    const mac = data.slice(NONCE_SIZE, NONCE_SIZE + MAC_SIZE);
    const ciphertext = data.slice(NONCE_SIZE + MAC_SIZE);

    // Throws if MAC verification fails (wrong key or corrupted data)
    const plaintext = _sodium.crypto_aead_xchacha20poly1305_ietf_decrypt_detached(
      null, ciphertext, mac, null, nonce, key
    );

    const decoder = new TextDecoder();
    return decoder.decode(plaintext);
  }

  async *encryptFileParts(
    file: File,
    key: Uint8Array,
    baseNonce: Uint8Array,
    metadata?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<Blob> {
    this.throwIfAborted(signal);
    await _sodium.ready;
    this.throwIfAborted(signal);

    if (key.length !== KEY_SIZE) {
      throw new Error(`Key must be ${KEY_SIZE} bytes`);
    }

    const fileSize = file.size;

    if (metadata) {
      // Kasumi v2 Header
      const encoder = new TextEncoder();
      const metaBytes = encoder.encode(metadata);
      if (metaBytes.length > KASUMI_MAX_METADATA_SIZE) {
        throw new Error('Kasumi metadata is too large');
      }

      const headerBuffer = new ArrayBuffer(NONCE_SIZE + 8 + 4 + 4);
      const headerView = new DataView(headerBuffer);
      const headerUint8 = new Uint8Array(headerBuffer);

      // Base Nonce
      headerUint8.set(baseNonce, 0);
      // Original Size (uint64)
      headerView.setBigUint64(NONCE_SIZE, BigInt(fileSize), true);

      // Magic 'KAS2'
      const magicBytes = encoder.encode('KAS2');
      headerUint8.set(magicBytes, NONCE_SIZE + 8);

      // Meta Size (uint32)
      headerView.setUint32(NONCE_SIZE + 12, metaBytes.length, true);

      // Encrypt Metadata Chunk (using special chunk index 0xFFFFFFFF)
      const metaNonce = this.deriveChunkNonce(baseNonce, 0xFFFFFFFF);
      const metaEncrypted = _sodium.crypto_aead_xchacha20poly1305_ietf_encrypt_detached(
        metaBytes, null, null, metaNonce, key
      );

      yield new Blob([
        headerBuffer,
        new Uint8Array(metaEncrypted.mac),
        new Uint8Array(metaEncrypted.ciphertext)
      ]);
    } else {
      // Kasumi v1 Header
      const headerBuffer = new ArrayBuffer(NONCE_SIZE + 8);
      const headerView = new DataView(headerBuffer);
      const headerUint8 = new Uint8Array(headerBuffer);

      headerUint8.set(baseNonce, 0);
      headerView.setBigUint64(NONCE_SIZE, BigInt(fileSize), true);

      yield new Blob([headerBuffer]);
    }

    let offset = 0;
    let chunkIndex = 0;

    while (offset < fileSize) {
      this.throwIfAborted(signal);
      const slice = file.slice(offset, offset + KASUMI_CHUNK_SIZE);
      const chunkBuffer = await slice.arrayBuffer();
      this.throwIfAborted(signal);
      const chunkUint8 = new Uint8Array(chunkBuffer);

      const chunkNonce = this.deriveChunkNonce(baseNonce, chunkIndex);

      // Encrypt chunk detached (MAC separate from Ciphertext)
      const encrypted = _sodium.crypto_aead_xchacha20poly1305_ietf_encrypt_detached(
        chunkUint8,
        null, // No additional data
        null, // No nsec
        chunkNonce,
        key
      );

      // Push MAC first (16 bytes), then Ciphertext
      yield new Blob([new Uint8Array(encrypted.mac), new Uint8Array(encrypted.ciphertext)]);

      offset += KASUMI_CHUNK_SIZE;
      chunkIndex++;
    }
  }

  async extractBaseNonce(encryptedBlob: Blob): Promise<Uint8Array> {
    const minimumHeaderSize = NONCE_SIZE + 8;
    if (encryptedBlob.size < minimumHeaderSize) {
      throw new Error('Encrypted file is too small');
    }
    return new Uint8Array(await encryptedBlob.slice(0, NONCE_SIZE).arrayBuffer());
  }

  calculateEncryptedSize(plaintextSize: number, metadata?: string): number {
    if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0) {
      throw new Error('Invalid plaintext size');
    }

    const chunkCount = plaintextSize === 0 ? 0 : Math.ceil(plaintextSize / KASUMI_CHUNK_SIZE);
    let headerSize = NONCE_SIZE + 8;
    if (metadata) {
      const metadataSize = new TextEncoder().encode(metadata).length;
      if (metadataSize > KASUMI_MAX_METADATA_SIZE) throw new Error('Kasumi metadata is too large');
      headerSize += 8 + MAC_SIZE + metadataSize;
    }

    const encryptedSize = headerSize + plaintextSize + chunkCount * MAC_SIZE;
    if (!Number.isSafeInteger(encryptedSize)) throw new Error('Encrypted size is too large');
    return encryptedSize;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Operation aborted', 'AbortError');
  }

  /**
   * Decrypts a Blob previously encrypted with the Kasumi XChaCha20-Poly1305 format.
   * @param encryptedBlob The encrypted blob from the backend
   * @param key 32-byte FDK
   * @param expectedEncryptedSize Trusted ciphertext size persisted for the file
   */
  async decryptFile(encryptedBlob: Blob, key: Uint8Array, expectedEncryptedSize: number): Promise<Blob> {
    await _sodium.ready;

    if (key.length !== KEY_SIZE) {
      throw new Error(`Key must be ${KEY_SIZE} bytes`);
    }
    if (!Number.isSafeInteger(expectedEncryptedSize) || expectedEncryptedSize < 0 || encryptedBlob.size !== expectedEncryptedSize) {
      throw new Error('File corrupted or truncated');
    }

    if (encryptedBlob.size < NONCE_SIZE + 8) {
      throw new Error('Encrypted file is too small to contain header');
    }

    // Read Header
    const initialHeaderSize = NONCE_SIZE + 8;
    const headerSlice = encryptedBlob.slice(0, initialHeaderSize);
    const headerBuffer = await headerSlice.arrayBuffer();
    const baseNonce = new Uint8Array(headerBuffer, 0, NONCE_SIZE);
    
    const headerView = new DataView(headerBuffer);
    const expectedSize = Number(headerView.getBigUint64(NONCE_SIZE, true));

    let offset = initialHeaderSize;

    // Check for KAS2 magic bytes
    if (encryptedBlob.size >= initialHeaderSize + 8) {
      const magicSlice = encryptedBlob.slice(initialHeaderSize, initialHeaderSize + 4);
      const magicBuffer = await magicSlice.arrayBuffer();
      const magicString = new TextDecoder().decode(magicBuffer);

      if (magicString === 'KAS2') {
        const metaSizeSlice = encryptedBlob.slice(initialHeaderSize + 4, initialHeaderSize + 8);
        const metaSizeBuffer = await metaSizeSlice.arrayBuffer();
        const metaSize = new DataView(metaSizeBuffer).getUint32(0, true);
        if (metaSize > KASUMI_MAX_METADATA_SIZE) {
          throw new Error('File corrupted or truncated');
        }

        // offset now starts after the metadata chunk (MAC + Ciphertext)
        offset = initialHeaderSize + 8 + MAC_SIZE + metaSize;
        if (offset > encryptedBlob.size) {
          throw new Error('File corrupted or truncated');
        }

        const metaChunk = new Uint8Array(await encryptedBlob.slice(initialHeaderSize + 8, offset).arrayBuffer());
        const metaNonce = this.deriveChunkNonce(baseNonce, 0xFFFFFFFF);
        try {
          _sodium.crypto_aead_xchacha20poly1305_ietf_decrypt_detached(
            null,
            metaChunk.subarray(MAC_SIZE),
            metaChunk.subarray(0, MAC_SIZE),
            null,
            metaNonce,
            key
          );
        } catch (e) {
          throw new Error('Failed to authenticate or decrypt KAS2 metadata');
        }
      }
    }

    this.assertContainerSize(offset, expectedSize, expectedEncryptedSize);

    const decryptedChunks: Blob[] = [];
    let chunkIndex = 0;
    let totalDecrypted = 0;
    
    // Start reading chunks after the header
    while (offset < encryptedBlob.size) {
      // Each encrypted chunk is MAC (16 bytes) + Ciphertext
      // The ciphertext is at most KASUMI_CHUNK_SIZE. So the total chunk is at most MAC_SIZE + KASUMI_CHUNK_SIZE.
      // But the last chunk could be smaller.
      
      // Calculate how many bytes are left in the encrypted blob
      const remainingBytes = encryptedBlob.size - offset;
      
      // The expected chunk size (excluding MAC) is either KASUMI_CHUNK_SIZE or the rest of the original file size
      const expectedPlaintextSize = Math.min(KASUMI_CHUNK_SIZE, expectedSize - totalDecrypted);
      const expectedEncryptedChunkSize = MAC_SIZE + expectedPlaintextSize;

      if (remainingBytes < expectedEncryptedChunkSize) {
        throw new Error('File corrupted or truncated');
      }

      const chunkSlice = encryptedBlob.slice(offset, offset + expectedEncryptedChunkSize);
      const chunkBuffer = await chunkSlice.arrayBuffer();
      const chunkUint8 = new Uint8Array(chunkBuffer);

      const mac = chunkUint8.subarray(0, MAC_SIZE);
      const ciphertext = chunkUint8.subarray(MAC_SIZE);

      const chunkNonce = this.deriveChunkNonce(baseNonce, chunkIndex);

      try {
        const plaintext = _sodium.crypto_aead_xchacha20poly1305_ietf_decrypt_detached(
          null, // nsec
          ciphertext,
          mac,
          null, // ad
          chunkNonce,
          key
        );

        decryptedChunks.push(new Blob([new Uint8Array(plaintext)]));
        totalDecrypted += plaintext.length;
      } catch (e) {
        throw new Error(`Authentication failed at chunk ${chunkIndex}. File may be malicious or corrupted.`);
      }

      offset += expectedEncryptedChunkSize;
      chunkIndex++;
    }

    if (totalDecrypted !== expectedSize) {
      throw new Error(`Size mismatch. Expected ${expectedSize}, got ${totalDecrypted}`);
    }

    return new Blob(decryptedChunks);
  }

  async decryptFileChunk(
    ciphertext: Uint8Array,
    mac: Uint8Array,
    baseNonce: Uint8Array,
    chunkIndex: number,
    key: Uint8Array
  ): Promise<Uint8Array> {
    await _sodium.ready;
    const chunkNonce = this.deriveChunkNonce(baseNonce, chunkIndex);
    try {
      const plaintext = _sodium.crypto_aead_xchacha20poly1305_ietf_decrypt_detached(
        null, // nsec
        ciphertext,
        mac,
        null, // ad
        chunkNonce,
        key
      );
      return new Uint8Array(plaintext);
    } catch (e) {
      throw new Error(`Authentication failed at chunk ${chunkIndex}.`);
    }
  }

  /**
   * Extracts metadata from a Kasumi v2 encrypted Blob.
   * Useful when only downloading a partial file (e.g. via Range request).
   * @param expectedEncryptedSize Trusted full ciphertext size persisted for the file
   * Returns { metadata: string | null, dataOffset: number }
   */
  async extractMetadata(partialBlob: Blob, key: Uint8Array, expectedEncryptedSize: number): Promise<{ metadata: string | null, dataOffset: number, expectedSize: number }> {
    await _sodium.ready;
    if (key.length !== KEY_SIZE) throw new Error('Key must be 32 bytes');

    const initialHeaderSize = NONCE_SIZE + 8;
    if (partialBlob.size < initialHeaderSize) {
      throw new Error('Partial blob is too small to contain header');
    }

    const headerSlice = partialBlob.slice(0, initialHeaderSize);
    const headerBuffer = await headerSlice.arrayBuffer();
    const baseNonce = new Uint8Array(headerBuffer, 0, NONCE_SIZE);
    
    const expectedSize = Number(new DataView(headerBuffer).getBigUint64(NONCE_SIZE, true));

    let dataOffset = initialHeaderSize;
    let metadata: string | null = null;

    if (partialBlob.size >= initialHeaderSize + 8) {
      const magicSlice = partialBlob.slice(initialHeaderSize, initialHeaderSize + 4);
      const magicBuffer = await magicSlice.arrayBuffer();
      const magicString = new TextDecoder().decode(magicBuffer);

      if (magicString === 'KAS2') {
        const metaSizeSlice = partialBlob.slice(initialHeaderSize + 4, initialHeaderSize + 8);
        const metaSizeBuffer = await metaSizeSlice.arrayBuffer();
        const metaSize = new DataView(metaSizeBuffer).getUint32(0, true);
        if (metaSize > KASUMI_MAX_METADATA_SIZE) {
          throw new Error('File corrupted or truncated');
        }

        const expectedTotalHeader = initialHeaderSize + 8 + MAC_SIZE + metaSize;
        if (partialBlob.size < expectedTotalHeader) {
          throw new Error('Partial blob is too small to contain the full metadata block');
        }

        const metaChunkSlice = partialBlob.slice(initialHeaderSize + 8, expectedTotalHeader);
        const metaChunkBuffer = await metaChunkSlice.arrayBuffer();
        const metaChunkUint8 = new Uint8Array(metaChunkBuffer);

        const mac = metaChunkUint8.slice(0, MAC_SIZE);
        const ciphertext = metaChunkUint8.slice(MAC_SIZE);
        const metaNonce = this.deriveChunkNonce(baseNonce, 0xFFFFFFFF);

        try {
          const plaintext = _sodium.crypto_aead_xchacha20poly1305_ietf_decrypt_detached(
            null, ciphertext, mac, null, metaNonce, key
          );
          metadata = new TextDecoder().decode(plaintext);
        } catch (e) {
          throw new Error('Failed to authenticate or decrypt KAS2 metadata');
        }

        dataOffset = expectedTotalHeader;
      }
    }

    this.assertContainerSize(dataOffset, expectedSize, expectedEncryptedSize);

    return { metadata, dataOffset, expectedSize };
  }

  private assertContainerSize(dataOffset: number, plaintextSize: number, expectedEncryptedSize: number): void {
    if (
      !Number.isSafeInteger(dataOffset) || dataOffset < 0 ||
      !Number.isSafeInteger(plaintextSize) || plaintextSize < 0 ||
      !Number.isSafeInteger(expectedEncryptedSize) || expectedEncryptedSize < 0
    ) {
      throw new Error('File corrupted or truncated');
    }

    const chunkCount = plaintextSize === 0 ? 0 : Math.ceil(plaintextSize / KASUMI_CHUNK_SIZE);
    const computedSize = dataOffset + plaintextSize + chunkCount * MAC_SIZE;
    if (!Number.isSafeInteger(computedSize) || computedSize !== expectedEncryptedSize) {
      throw new Error('File corrupted or truncated');
    }
  }
}
