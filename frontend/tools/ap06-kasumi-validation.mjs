import { createHash } from 'node:crypto';

export async function validateContainer(kasumi, plaintext, encrypted, material) {
  const header = encrypted.slice(0, Math.min(encrypted.size, 128 * 1024));
  const bytes = new Uint8Array(await header.arrayBuffer());
  if (new TextDecoder().decode(bytes.subarray(32, 36)) !== 'KAS2') throw new Error('KAS2_HEADER_REQUIRED');
  const metadata = await kasumi.extractMetadata(header, material.fdk, encrypted.size);
  const chunks = Math.ceil(plaintext.size / 4194304);
  if (metadata.expectedSize !== plaintext.size || metadata.dataOffset !== 56 + new DataView(bytes.buffer).getUint32(36, true) ||
      encrypted.size !== metadata.dataOffset + plaintext.size + chunks * 16) throw new Error('KAS2_SIZE_MISMATCH');
  const nonce = await kasumi.extractBaseNonce(header);
  const hash = createHash('sha256');
  try {
    for (let index = 0; index < chunks; index++) {
      const start = metadata.dataOffset + index * (4194304 + 16);
      const size = Math.min(4194304, plaintext.size - index * 4194304);
      const input = new Uint8Array(await encrypted.slice(start, start + size + 16).arrayBuffer());
      const output = await kasumi.decryptFileChunk(input.subarray(16), input.subarray(0, 16), nonce, index, material.fdk);
      const expected = Buffer.from(await plaintext.slice(index * 4194304, index * 4194304 + size).arrayBuffer());
      try {
        if (output.length !== size || !expected.equals(output)) throw new Error('KAS2_ROUND_TRIP_MISMATCH');
        hash.update(output);
      } finally { output.fill(0); input.fill(0); expected.fill(0); }
    }
  } finally { nonce.fill(0); bytes.fill(0); }
  return { dataOffset: metadata.dataOffset, expectedSize: metadata.expectedSize, ciphertextBytes: encrypted.size,
    chunkCount: chunks, macBytesPerChunk: 16, lastChunkBytes: plaintext.size - (chunks - 1) * 4194304,
    roundTripSha256: hash.digest('hex'), authenticatedMetadata: true };
}

