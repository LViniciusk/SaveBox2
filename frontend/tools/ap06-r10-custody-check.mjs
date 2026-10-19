import { readFileSync, openAsBlob } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { validateContainer } from './ap06-kasumi-validation.mjs';

try {
  const root = resolve(process.argv[2]);
  let input = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    input = Buffer.concat([input,chunk]);
    if (input.length > 65536) throw new Error('CUSTODY_INPUT_TOO_LARGE');
  }
  const keys = JSON.parse(input.toString('utf8')); input.fill(0);
  if (Object.keys(keys).sort().join() !== '0,1,2' || Object.values(keys).some(key =>
    key.length !== 32 || key.some(value => !Number.isInteger(value) || value < 0 || value > 255))) throw new Error('CUSTODY_INVALID_KEYS');
  const { KasumiCryptoService } = createRequire(import.meta.url)(join(root,'tooling/kasumi.cjs'));
  const kasumi = new KasumiCryptoService(), fixtures = JSON.parse(readFileSync(join(root,'manifests/corpus.json'),'utf8'));
  const rows = [];
  try {
    for (const fixture of fixtures) {
      const plainPath = join(root,'corpus/plain',fixture.path), cipherPath = join(root,'corpus/cipher',`video-${fixture.id}.bin`);
      const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
      if (digest(plainPath) !== fixture.sha256 || digest(cipherPath) !== fixture.ciphertextSha256) throw new Error('CUSTODY_CORPUS_HASH_MISMATCH');
      const fdk = Uint8Array.from(keys[fixture.id]);
      try {
        const verified = await validateContainer(kasumi,await openAsBlob(plainPath),await openAsBlob(cipherPath),{ fdk });
        if (verified.roundTripSha256 !== fixture.sha256 || verified.chunkCount !== 3) throw new Error('CUSTODY_DECRYPT_MISMATCH');
        rows.push({ id:fixture.id,roundTripSha256:verified.roundTripSha256,ciphertextSha256:fixture.ciphertextSha256,
          authenticatedMetadata:verified.authenticatedMetadata,chunkCount:verified.chunkCount,bytes:verified.expectedSize });
      } finally { fdk.fill(0); }
    }
  } finally { for (const key of Object.values(keys)) key.fill(0); }
  console.log(JSON.stringify({ status:'PASS',fixtures:rows }));
} catch {
  console.error('CUSTODY_CORPUS_CHECK_FAILED'); process.exitCode=1;
}
