import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, expect, cleanupE2EAccount } from '../e2e/support/fixtures';
import { loginAndUnlock, uniqueFileName, uploadLocalFile } from '../e2e/support/session';

function e2eStoragePath(): string {
  const path = process.env['NANIKA_E2E_STORAGE_PATH'];
  const identity = process.env['NANIKA_E2E_STORAGE_ID'];
  if (!path || !identity || !/^[0-9a-f]{64}$/.test(identity)) {
    throw new Error('E2E storage identity is not configured.');
  }
  const root = resolve(path);
  if (readFileSync(join(root, '.nanika-e2e-storage-id'), 'utf8').trim() !== identity) {
    throw new Error('E2E storage identity does not match.');
  }
  return root;
}

test('E2E cleanup removes a real local upload from its isolated storage', async ({ page, credentials }, testInfo) => {
  const filename = uniqueFileName('b89-cleanup-integrity', 'bin');
  const filePath = testInfo.outputPath(filename);
  const storage = e2eStoragePath();
  writeFileSync(filePath, Buffer.alloc(16 * 1024, 0x5a));

  try {
    await loginAndUnlock(page, credentials);
    const createResponsePromise = page.waitForResponse(response =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/files');
    await uploadLocalFile(page, filePath, filename);
    const createResponse = await createResponsePromise;
    expect(createResponse.ok()).toBe(true);
    const body = await createResponse.json() as Record<string, unknown>;
    const fileId = body['file_id'] ?? body['fileId'] ?? body['id'];
    expect(String(fileId)).toMatch(/^\d+$/);

    const artifact = join(storage, `${fileId}.dat`);
    await expect.poll(() => existsSync(artifact), { timeout: 5_000 }).toBe(true);
    const uploadedBytes = statSync(artifact).size;
    expect(uploadedBytes).toBeGreaterThan(0);

    const removedFileIds = await cleanupE2EAccount(credentials.username);
    const physicalFileAfter = existsSync(artifact);
    expect(removedFileIds).toContain(Number(fileId));
    expect(physicalFileAfter).toBe(false);
    console.log(JSON.stringify({
      kind: 'isolated-small-upload-cleanup',
      fileId: Number(fileId),
      physicalFileBefore: true,
      physicalBytes: uploadedBytes,
      databaseFileIdReturnedByCleanup: removedFileIds.includes(Number(fileId)),
      databaseUserAndFileRowsAfterCleanup: 'fixture verified absent before success response',
      physicalFileAfter,
    }));
  } finally {
    await rm(filePath, { force: true });
  }
});
