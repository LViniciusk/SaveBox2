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

export { validateContainer } from './ap06-kasumi-validation.mjs';
import { validateContainer } from './ap06-kasumi-validation.mjs';

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
