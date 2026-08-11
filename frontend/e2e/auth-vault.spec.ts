import { deterministicFile, driveItem, ensureVaultUnlocked, lockDrive, loginAndUnlock, logout, uploadLocalFile } from './support/session';
import { test, expect } from './support/fixtures';

test('authenticates, initializes, locks, unlocks, and logs out of the Vault', async ({ page, credentials }, testInfo) => {
  await loginAndUnlock(page, credentials);
  const filename = `auth-vault-${testInfo.workerIndex}.txt`;
  const filePath = await deterministicFile(testInfo.outputPath(filename), 1024);
  await uploadLocalFile(page, filePath, filename);
  await expect(driveItem(page, filename)).toBeVisible();

  await lockDrive(page);
  await expect(page.getByText(filename, { exact: true })).toHaveCount(0);

  await ensureVaultUnlocked(page, credentials);
  await expect(driveItem(page, filename)).toBeVisible();

  await logout(page);
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
});
