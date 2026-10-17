import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { executeFixture } from './e2e-fixture-characterization.mjs';
import { generateCredentials } from '../e2e/support/session.ts';

const root = resolve(import.meta.dirname, '../..'), out = resolve(root, process.env.AP06_EXPERIMENT_ROOT ?? '.quality/readiness-wave8');
const config = JSON.parse(readFileSync(join(out, 'baseline/backend-runtime.local.json'), 'utf8'));
Object.assign(process.env, config.environment);
const save = (name, data) => writeFileSync(join(out, name), JSON.stringify(data, null, 2) + '\n');
const environment = { executable: config.executable, cwd: config.cwd, storagePath: config.storagePath, storageId: config.storageId };
async function fixture(command, payload, env = environment) {
  return executeFixture({ command, payload, environment: env });
}
if (process.argv.includes('--cleanup')) {
  const r5 = /readiness-wave12-r[56]-/.test(out.split(/[\\/]/).at(-1));
  const credentials = JSON.parse(readFileSync(join(out, 'baseline/accounts.local.json'), 'utf8'));
  const results = []; let status = 'PASS';
  try {
    for (const account of credentials) {
      const result = await fixture('cleanup', { username: account.username });
      assert.equal(result.result, 'PASS'); results.push({ status: result.result, fileIds: result.fileIds ?? [], removedFileCount: result.removedFileCount ?? null });
    }
  } catch {
    status = 'FAIL';
    throw new Error('FIXTURE_ACCOUNT_CLEANUP_FAILED');
  } finally {
    if (r5) {
      for (const account of credentials) { account.username = ''; account.password = ''; account.vaultPhrase = ''; }
      save('baseline/accounts.local.json', []);
      save('baseline/player-auth.local.json', { username: '', password: '', fileIds: {} });
      save('pipeline/fixture-account-cleanup.json', { status, accountsRequested: credentials.length,
        accountsCleaned: results.length, removedFiles: results.reduce((sum, row) => sum + (row.removedFileCount ?? 0), 0),
        failureClass: status === 'PASS' ? null : 'FIXTURE_ACCOUNT_CLEANUP_FAILED' });
      save('pipeline/backend-account-cleanup.json', { status, fixtureAccountCleanupStatus: status,
        accountsCleaned: results.length, results });
    }
  }
  if (!r5) save('pipeline/backend-account-cleanup.json', { status: 'PASS', accounts: results.length, results });
  console.log('R8 accounts/files cleaned through original fixture');
} else {
  const tests = [], temporary = mkdtempSync(join(out, 'pipeline/guard-'));
  assert.ok(resolve(temporary).startsWith(resolve(out) + '\\') || resolve(temporary).startsWith(resolve(out) + '/'));
  try {
    writeFileSync(join(temporary, '.env'), 'DB_NAME=personal_not_e2e\n');
    let result = await fixture('provision', {}, { ...environment, cwd: temporary });
    assert.equal(result.fixtureSafeCode, 'FIXTURE_DATABASE_NOT_ISOLATED'); tests.push('non-E2E database rejected');
    result = await fixture('provision', {}, { ...environment, storagePath: temporary });
    assert.equal(result.fixtureSafeCode, 'FIXTURE_STORAGE_UNAVAILABLE'); tests.push('missing storage marker rejected');
    result = await fixture('provision', {}, { ...environment, storageId: '0'.repeat(64) });
    assert.equal(result.fixtureSafeCode, 'FIXTURE_STORAGE_IDENTITY_MISMATCH'); tests.push('wrong storage marker rejected');
  } finally { rmSync(temporary, { recursive: true }); }
  const accounts = [generateCredentials(), generateCredentials()];
  save('baseline/accounts.local.json', accounts);
  for (const account of accounts) assert.equal((await fixture('provision', account)).result, 'PASS');
  async function request(path, options = {}, token) {
    return fetch(config.backendOrigin + path, { redirect: 'error', ...options,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  }
  async function login(account) {
    const response = await request('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: account.username, password: account.password }) });
    assert.equal(response.status, 200); const body = await response.json(); assert.ok(body.token); return body.token;
  }
  let token = await login(accounts[0]), foreignToken = await login(accounts[1]);
  tests.push('two synthetic users provisioned and authenticated');
  const fixtures = JSON.parse(readFileSync(join(out, 'fixtures/manifest.json'), 'utf8')), mapping = [];
  for (const row of fixtures) {
    const bytes = readFileSync(join(out, 'fixtures/cipher', `video-${row.id}.bin`));
    const response = await request('/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      folder_id: null, encrypted_name: row.name + '.mp4', name_hash: `r8-fixture-${row.id}`, encrypted_fdk: 'synthetic-bypassed',
      size_bytes: bytes.length, total_chunks: Math.ceil(bytes.length / 4194304), storage_provider: 'local', is_hidden: false,
    }) }, token);
    assert.equal(response.status, 201); const { file_id: fileId } = await response.json(); assert.ok(Number.isSafeInteger(fileId));
    let completion;
    for (let offset = 0, index = 0; offset < bytes.length; offset += 4194304, index++) {
      const upload = await request(`/files/${fileId}/chunks`, { method: 'POST', headers: { 'X-Chunk-Index': String(index),
        'Content-Type': 'application/octet-stream' }, body: bytes.subarray(offset, offset + 4194304) }, token);
      assert.equal(upload.status, 200); completion = await upload.json();
    }
    assert.equal(completion.status, 'completed');
    const blocks = [];
    for (let offset = 0; offset < bytes.length; offset += 4194304) {
      const end = Math.min(offset + 4194304, bytes.length) - 1;
      const download = await request(`/files/${fileId}/download`, { headers: { Range: `bytes=${offset}-${end}` } }, token);
      assert.equal(download.status, 206);
      assert.equal(download.headers.get('content-range'), `bytes ${offset}-${end}/${bytes.length}`);
      blocks.push(Buffer.from(await download.arrayBuffer()));
    }
    const recovered = Buffer.concat(blocks);
    const hash = createHash('sha256').update(recovered).digest('hex');
    assert.equal(recovered.length, row.ciphertextBytes); assert.equal(hash, row.ciphertextSha256); assert.deepEqual(recovered, bytes);
    const range = await request(`/files/${fileId}/download`, { headers: { Range: 'bytes=0-1023' } }, token);
    assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 0-1023/${bytes.length}`);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 1024));
    const invalid = await request(`/files/${fileId}/download`, { headers: { Range: `bytes=${bytes.length}-` } }, token);
    assert.equal(invalid.status, 416); await invalid.arrayBuffer();
    const missing = await request(`/files/${fileId}/download`); assert.equal(missing.status, 401); await missing.arrayBuffer();
    const foreign = await request(`/files/${fileId}/download`, {}, foreignToken);
    assert.ok([403, 404].includes(foreign.status)); await foreign.arrayBuffer();
    mapping.push({ fixture: row.id, fileId, provider: 'local', ciphertextBytes: bytes.length, ciphertextSha256: hash,
      uploadCompletion: completion, range206: true, unauthenticatedStatus: missing.status, foreignStatus: foreign.status, invalidRangeStatus: invalid.status });
  }
  const treeResponse = await request('/tree?file_limit=100&file_offset=0', {}, token);
  assert.equal(treeResponse.status, 200); const tree = await treeResponse.json();
  for (const row of mapping) assert.ok(tree.files.some(file => file.id === row.fileId && file.storage_provider === 'local' && file.size_bytes === row.ciphertextBytes));
  const pendingResponse = await request('/pending-uploads', {}, token); assert.equal(pendingResponse.status, 200);
  const pending = await pendingResponse.json(); assert.deepEqual(pending.pending_uploads, []);
  tests.push('exact ciphertext uploaded through public endpoints', 'complete files visible in owner tree; no pending uploads',
    'full SHA/size/byte roundtrip', 'real 206 Content-Range and bytes', '416 rejected', 'missing token 401', 'foreign owner access denied');
  save('baseline/player-auth.local.json', { username: accounts[0].username, password: accounts[0].password,
    fileIds: Object.fromEntries(mapping.map(row => [row.fixture, row.fileId])) });
  save('baseline/backend-authority.json', { status: 'PASS', fileMapping: mapping, checks: tests,
    authentication: 'original credential endpoint; JWT retained only in memory', preparationOutsideMeasurement: true,
    ciphertextReencrypted: false, publicUploadEndpoints: true, backendOrigin: config.backendOrigin });
  if (out.endsWith('readiness-wave10-r3')) {
    for (let i=0;i<20;i++) token=await login(accounts[0]);
    const row=mapping[0],expected=readFileSync(join(out,'fixtures/cipher','video-0.bin')).subarray(0,16);
    for (let i=0;i<5002;i++) {
      const response=await request(`/files/${row.fileId}/download`,{headers:{Range:'bytes=0-15'}},token);
      assert.equal(response.status,206);assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);
    }
    save('baseline/network-bypass.json',{status:'PASS',legitimateLogins:20,authenticatedRanges:5002,
      rangeBytesEach:16,unexpected429:0,unexpectedBan:0,actualPeer:'127.0.0.1',productionPolicyUnchanged:true});
  }
  token = ''; foreignToken = '';
  console.log(JSON.stringify({ status: 'PASS', files: mapping.length, checks: tests.length }));
}
