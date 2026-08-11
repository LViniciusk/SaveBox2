import { test, expect } from './support/fixtures';
import {
  deterministicFile,
  downloadDriveFile,
  loginAndUnlock,
  sha256File,
  uniqueFileName,
  uploadLocalFile,
} from './support/session';

test('uploads and downloads a deterministic local file byte-for-byte', async ({ page, credentials }, testInfo) => {
  await loginAndUnlock(page, credentials);
  const filename = uniqueFileName('local-e2e', 'txt');
  const filePath = await deterministicFile(testInfo.outputPath(filename), 64 * 1024);
  const expected = await sha256File(filePath);
  let plaintextLeaked = false;

  page.on('request', request => {
    if (request.url().includes('/chunks')) return;
    if (request.url().includes(filename) || (request.postData() ?? '').includes(filename)) {
      plaintextLeaked = true;
    }
  });

  await uploadLocalFile(page, filePath, filename);
  expect(plaintextLeaked).toBe(false);
  expect(await sha256File(await downloadDriveFile(page, filename))).toBe(expected);
});
