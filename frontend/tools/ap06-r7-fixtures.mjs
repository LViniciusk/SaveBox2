import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { openAsBlob, openSync, writeSync, closeSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { disposableCryptoMaterial } from './ap06-mse-probe.mjs';
import { prepareFixtureCorpus } from './ap06-transmux-probe.mjs';
import { writeJsonAtomic } from './browser-memory-probe.mjs';

export async function buildKasumi(path) {
  await build({ stdin: { contents: "import '@angular/compiler'; export {KasumiCryptoService} from './src/app/core/crypto/kasumi-crypto.service';", resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
    bundle: true, platform: 'node', format: 'cjs', outfile: path, logLevel: 'error' });
}

export function loadKasumi(path) {
  const { KasumiCryptoService } = createRequire(import.meta.url)(path);
  return new KasumiCryptoService();
}

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

async function prepare() {
  const { AP06_R7_PLAIN_DIR: plain, AP06_R7_CIPHER_DIR: cipher, AP06_R7_MANIFEST: manifest,
    AP06_R7_KASUMI_BUNDLE: bundle } = process.env;
  if (![plain, cipher, manifest, bundle].every(Boolean)) throw new Error('OWNED_R7_PREPARATION_REQUIRED');
  mkdirSync(plain); mkdirSync(cipher);
  await buildKasumi(bundle);
  const kasumi = loadKasumi(bundle);
  const fixtures = await prepareFixtureCorpus(plain, { bitrateKbps: 2400 });
  const historical = JSON.parse(readFileSync('../docs/qualidade/ap06-r6.json', 'utf8')).fixtureManifests.faststart;
  for (const fixture of fixtures) {
    const material = disposableCryptoMaterial(fixture.id);
    try {
      const plaintext = await openAsBlob(`${plain}/${fixture.path}`);
      const path = `${cipher}/video-${fixture.id}.bin`;
      const fd = openSync(path, 'wx');
      const metadata = JSON.stringify({ name: fixture.name, mimeType: 'video/mp4' });
      try {
        for await (const part of kasumi.encryptFileParts(plaintext, material.fdk, material.baseNonce, metadata)) {
          const bytes = Buffer.from(await part.arrayBuffer());
          try { writeSync(fd, bytes); } finally { bytes.fill(0); }
        }
      } finally { closeSync(fd); }
      Object.assign(fixture, await validateContainer(kasumi, plaintext, await openAsBlob(path), material));
      if (fixture.sha256 !== fixture.roundTripSha256 || fixture.chunkCount !== 3 || fixture.lastChunkBytes <= 0 || fixture.lastChunkBytes >= 4194304) {
        throw new Error('R7_FIXTURE_CAPACITY_OR_ROUND_TRIP_INVALID');
      }
      fixture.ciphertextSha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      fixture.r6PlaintextIdentical = fixture.sha256 === historical.find(row => row.id === fixture.id)?.sha256;
    } finally { material.fdk.fill(0); material.baseNonce.fill(0); }
  }
  writeJsonAtomic(manifest, fixtures);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await prepare();
