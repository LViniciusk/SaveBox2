import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { openAsBlob, openSync, closeSync, writeSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildKasumi, loadKasumi, validateContainer } from './ap06-r7-fixtures.mjs';
import { prepareFixtureCorpus } from './ap06-transmux-probe.mjs';

const out = resolve(process.env.AP06_EXPERIMENT_ROOT ?? '');
const runtime = resolve(process.env.AP06_R9_PRIVATE_RUNTIME ?? '');
assert.ok(out.endsWith('readiness-wave9-r2') && runtime.startsWith(out + '\\'));
const plain = join(out, 'fixtures/plain'), cipher = join(out, 'fixtures/cipher');
mkdirSync(plain); mkdirSync(cipher);
const bundle = join(out, 'tooling/kasumi.cjs');
await buildKasumi(bundle);
const kasumi = loadKasumi(bundle), keys = {};
const fixtures = await prepareFixtureCorpus(plain, { bitrateKbps: 2400 });
for (const fixture of fixtures) {
  const material = { fdk: randomBytes(32), baseNonce: randomBytes(24) };
  try {
    const plaintext = await openAsBlob(join(plain, fixture.path));
    const path = join(cipher, `video-${fixture.id}.bin`), fd = openSync(path, 'wx');
    try {
      for await (const part of kasumi.encryptFileParts(plaintext, material.fdk, material.baseNonce,
        JSON.stringify({ name: fixture.name, mimeType: 'video/mp4' }))) {
        const bytes = Buffer.from(await part.arrayBuffer());
        try { assert.equal(writeSync(fd, bytes), bytes.length); } finally { bytes.fill(0); }
      }
    } finally { closeSync(fd); }
    Object.assign(fixture, await validateContainer(kasumi, plaintext, await openAsBlob(path), material));
    assert.equal(fixture.sha256, fixture.roundTripSha256); assert.equal(fixture.chunkCount, 3);
    fixture.ciphertextSha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
    const info = JSON.parse(execFileSync(process.env.NANIKA_FFPROBE_PATH ?? 'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', join(plain, fixture.path)], { encoding: 'utf8', windowsHide: true }));
    const video = info.streams.find(row => row.codec_type === 'video');
    assert.equal(video.codec_name, 'h264'); assert.equal(video.width, 640); assert.equal(video.height, 360);
    assert.equal(video.r_frame_rate, '24/1');
    assert.ok(Math.abs(Number(info.format.duration) - fixture.durationSeconds) < 0.1);
    assert.deepEqual(info.streams.map(row => row.codec_type), fixture.id === 1 ? ['video'] : ['video', 'audio']);
    if (fixture.id !== 1) assert.equal(info.streams[1].codec_name, 'aac');
    keys[fixture.id] = [...material.fdk];
  } finally { material.fdk.fill(0); material.baseNonce.fill(0); }
}
writeFileSync(join(runtime, 'fdks.local.json'), JSON.stringify(keys), { flag: 'wx' });
writeFileSync(join(out, 'fixtures/manifest.json'), JSON.stringify(fixtures, null, 2) + '\n', { flag: 'wx' });
for (const key of Object.values(keys)) key.fill(0);
console.log(JSON.stringify({ status: 'PASS', generatedOnce: 3, fullKasumiRoundTrips: 3, ffprobeVerified: 3 }));
