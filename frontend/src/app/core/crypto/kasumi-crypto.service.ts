import { Injectable } from '@angular/core';
import _sodium from 'libsodium-wrappers-sumo';

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
const NONCE_SIZE = 24;
const MAC_SIZE = 16;
const KEY_SIZE = 32;

@Injectable({ providedIn: 'root' })
export class KasumiCryptoService {
  private sodiumLoaded = false;

  constructor() {
    this.initSodium();
  }

  private async initSodium() {
    await _sodium.ready;
    this.sodiumLoaded = true;
  }

  private async ensureSodium() {
    if (!this.sodiumLoaded) {
      await _sodium.ready;
      this.sodiumLoaded = true;
    }
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
    await this.ensureSodium();
    const encoder = new TextEncoder();
    const hash = _sodium.crypto_generichash(32, encoder.encode(name), null);
    return _sodium.to_base64(hash, _sodium.base64_variants.URLSAFE_NO_PADDING);
  }

  /**
   * Encrypts a string (e.g. filename) using XChaCha20-Poly1305.
   * Format: base64( nonce(24) || mac(16) || ciphertext )
   */
  async encryptName(name: string, key: Uint8Array): Promise<string> {
    await this.ensureSodium();
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
    await this.ensureSodium();
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

  /**
   * Encrypts a File into a Blob using Kasumi XChaCha20-Poly1305 stream format.
   * @param file The file to encrypt
   * @param key 32-byte FDK (File Data Key)
   * @param fixedBaseNonce Optional fixed base nonce
   * @param metadata Optional metadata string to embed in the Kasumi v2 header
   */
  async encryptFile(file: File, key: Uint8Array, fixedBaseNonce?: Uint8Array, metadata?: string): Promise<Blob> {
    await this.ensureSodium();

    if (key.length !== KEY_SIZE) {
      throw new Error(`Key must be ${KEY_SIZE} bytes`);
    }

    const baseNonce = fixedBaseNonce || this.generateBaseNonce();
    const fileSize = file.size;

    // Encrypted chunks
    const encryptedChunks: Blob[] = [];

    if (metadata) {
      // Kasumi v2 Header
      const encoder = new TextEncoder();
      const metaBytes = encoder.encode(metadata);
      
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

      encryptedChunks.push(new Blob([
        headerBuffer,
        new Uint8Array(metaEncrypted.mac),
        new Uint8Array(metaEncrypted.ciphertext)
      ]));
    } else {
      // Kasumi v1 Header
      const headerBuffer = new ArrayBuffer(NONCE_SIZE + 8);
      const headerView = new DataView(headerBuffer);
      const headerUint8 = new Uint8Array(headerBuffer);

      headerUint8.set(baseNonce, 0);
      headerView.setBigUint64(NONCE_SIZE, BigInt(fileSize), true);
      
      encryptedChunks.push(new Blob([headerBuffer]));
    }

    let offset = 0;
    let chunkIndex = 0;

    while (offset < fileSize) {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const chunkBuffer = await slice.arrayBuffer();
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
      encryptedChunks.push(new Blob([new Uint8Array(encrypted.mac), new Uint8Array(encrypted.ciphertext)]));

      offset += CHUNK_SIZE;
      chunkIndex++;
    }

    return new Blob(encryptedChunks);
  }

  /**
   * Decrypts a Blob previously encrypted with the Kasumi XChaCha20-Poly1305 format.
   * @param encryptedBlob The encrypted blob from the backend
   * @param key 32-byte FDK
   */
  async decryptFile(encryptedBlob: Blob, key: Uint8Array): Promise<Blob> {
    await this.ensureSodium();

    if (key.length !== KEY_SIZE) {
      throw new Error(`Key must be ${KEY_SIZE} bytes`);
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

        // offset now starts after the metadata chunk (MAC + Ciphertext)
        offset = initialHeaderSize + 8 + MAC_SIZE + metaSize;
      }
    }

    const decryptedChunks: Blob[] = [];
    let chunkIndex = 0;
    let totalDecrypted = 0;
    
    // Start reading chunks after the header
    while (offset < encryptedBlob.size) {
      // Each encrypted chunk is MAC (16 bytes) + Ciphertext
      // The ciphertext is at most CHUNK_SIZE. So the total chunk is at most MAC_SIZE + CHUNK_SIZE.
      // But the last chunk could be smaller.
      
      // Calculate how many bytes are left in the encrypted blob
      const remainingBytes = encryptedBlob.size - offset;
      
      // The expected chunk size (excluding MAC) is either CHUNK_SIZE or the rest of the original file size
      const expectedPlaintextSize = Math.min(CHUNK_SIZE, expectedSize - totalDecrypted);
      const expectedEncryptedChunkSize = MAC_SIZE + expectedPlaintextSize;

      if (remainingBytes < expectedEncryptedChunkSize) {
        throw new Error('File corrupted or truncated');
      }

      const chunkSlice = encryptedBlob.slice(offset, offset + expectedEncryptedChunkSize);
      const chunkBuffer = await chunkSlice.arrayBuffer();
      const chunkUint8 = new Uint8Array(chunkBuffer);

      const mac = chunkUint8.slice(0, MAC_SIZE);
      const ciphertext = chunkUint8.slice(MAC_SIZE);

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
    await this.ensureSodium();
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
   * Returns { metadata: string | null, dataOffset: number }
   */
  async extractMetadata(partialBlob: Blob, key: Uint8Array): Promise<{ metadata: string | null, dataOffset: number, expectedSize: number }> {
    await this.ensureSodium();
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

    return { metadata, dataOffset, expectedSize };
  }
}
