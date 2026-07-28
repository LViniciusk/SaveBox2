/**
 * stream-crypto.worker.ts
 *
 * Phase 2 / Worker 1: Cryptographic decryption worker.
 *
 * Responsibilities:
 *   - Receives a single encrypted chunk (MAC + Ciphertext) together with the
 *     plaintext File Data Key (FDK), the file Base Nonce and the chunk index.
 *   - Decrypts the chunk using XChaCha20-Poly1305 (libsodium-wrappers-sumo).
 *   - Returns the plaintext bytes via postMessage with a Transferable, so the
 *     ArrayBuffer is moved (zero-copy) back to the caller and is no longer
 *     accessible here.
 *
 * Wire format for incoming chunks (on disk / over the wire):
 *   offset  0 ..  15  MAC  (16 bytes, Poly1305 tag)
 *   offset 16 .. end  Ciphertext (up to 4 MB)
 *
 * File header (first 32 bytes of the encrypted blob, NOT part of a chunk):
 *   offset  0 .. 23   Base Nonce (24 bytes, XChaCha20)
 *   offset 24 .. 31   Original plaintext size (uint64-LE)
 *
 * The caller is responsible for slicing off the header before sending chunk
 * data to this worker.
 *
 * Message API
 * -----------
 * IN  { type: 'DECRYPT_CHUNK'; encryptedChunk: ArrayBuffer; fdk: ArrayBuffer;
 *       baseNonce: ArrayBuffer; chunkIndex: number; }
 *
 * OUT (success) { type: 'CHUNK_DECRYPTED'; decryptedChunk: ArrayBuffer;
 *                 chunkIndex: number; }
 *
 * OUT (error)   { type: 'ERROR'; chunkIndex: number; message: string; }
 */

import _sodium from 'libsodium-wrappers-sumo';

const NONCE_SIZE = 24;
const MAC_SIZE   = 16;
let sodiumReady  = false;

async function ensureSodium(): Promise<void> {
  if (!sodiumReady) {
    await _sodium.ready;
    sodiumReady = true;
  }
}

/**
 * Derives the per-chunk nonce by XORing the chunk index (little-endian uint64)
 * into the last 8 bytes of the base nonce. Mirrors the implementation used in
 * KasumiCryptoService.deriveChunkNonce.
 */
function deriveChunkNonce(baseNonce: Uint8Array, chunkIndex: number): Uint8Array {
  const nonce = new Uint8Array(baseNonce);
  let remaining = chunkIndex;
  for (let i = 0; i < 8; i++) {
    nonce[NONCE_SIZE - 1 - i] ^= remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return nonce;
}

let logsEnabled = false;
if (logsEnabled) console.log('[CryptoWorker] Top-level script evaluated.');

self.onmessage = async (event: MessageEvent) => {
  if (event.data.type === 'INIT') {
    logsEnabled = !!event.data.logsEnabled;
    return;
  }
  
  if (logsEnabled) console.log('[CryptoWorker] Received message:', event.data.type, 'chunkIndex:', event.data.chunkIndex);
  const { type, encryptedChunk, fdk, baseNonce, chunkIndex } = event.data as {
    type: string;
    encryptedChunk: ArrayBuffer;
    fdk: ArrayBuffer;
    baseNonce: ArrayBuffer;
    chunkIndex: number;
  };

  if (type !== 'DECRYPT_CHUNK') return;

  try {
    await ensureSodium();

    const chunkBytes  = new Uint8Array(encryptedChunk);
    const fdkBytes    = new Uint8Array(fdk);
    const nonceBytes  = new Uint8Array(baseNonce);

    if (chunkBytes.length < MAC_SIZE) {
      throw new Error(`Chunk ${chunkIndex} is too small to contain a MAC tag.`);
    }

    const mac        = chunkBytes.slice(0, MAC_SIZE);
    const ciphertext = chunkBytes.slice(MAC_SIZE);
    const chunkNonce = deriveChunkNonce(nonceBytes, chunkIndex);

    // Throws on authentication failure (wrong key or tampered data).
    const plaintext = _sodium.crypto_aead_xchacha20poly1305_ietf_decrypt_detached(
      null,        // nsec (unused by this algorithm)
      ciphertext,
      mac,
      null,        // additional data (none)
      chunkNonce,
      fdkBytes
    ) as Uint8Array;

    // Transfer the underlying ArrayBuffer back to the caller with zero copies.
    const transferable = plaintext.buffer as ArrayBuffer;
    self.postMessage(
      { type: 'CHUNK_DECRYPTED', decryptedChunk: transferable, chunkIndex },
      [transferable]
    );
  } catch (err: any) {
    self.postMessage({
      type: 'ERROR',
      chunkIndex,
      message: err?.message ?? 'Unknown decryption error.',
    });
  }
};
