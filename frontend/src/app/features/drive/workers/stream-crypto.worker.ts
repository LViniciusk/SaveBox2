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
import { createStreamCryptoMessageHandler } from './stream-crypto-protocol';

const handleMessage = createStreamCryptoMessageHandler(
  (message, transferables = []) => self.postMessage(message, transferables),
  _sodium as any,
);

self.onmessage = (event: MessageEvent) => {
  void handleMessage(event.data);
};
