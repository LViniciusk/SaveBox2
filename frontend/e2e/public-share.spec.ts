import { test, expect, installE2EBackendRouting } from './support/fixtures';
import {
  deterministicFile,
  driveItem,
  loginAndUnlock,
  sha256File,
  uniqueFileName,
  uploadLocalFile,
} from './support/session';

test('downloads and decrypts a local public share anonymously', async ({ page, browser, credentials }, testInfo) => {
  await loginAndUnlock(page, credentials);
  const filename = uniqueFileName('share-e2e', 'txt');
  const filePath = await deterministicFile(testInfo.outputPath(filename), 1024);
  const expected = await sha256File(filePath);
  await uploadLocalFile(page, filePath, filename);

  await driveItem(page, filename).click({ button: 'right' });
  await page.getByRole('button', { name: /Compartilhar/ }).click();
  const generateButton = page.getByRole('button', { name: /Gerar Link Publico/ });
  await expect(generateButton).toBeVisible({ timeout: 30_000 });
  const shareResponse = page.waitForResponse(response =>
    response.request().method() === 'POST' && /\/share$/.test(new URL(response.url()).pathname),
  );
  await generateButton.click();
  expect((await shareResponse).status()).toBeGreaterThanOrEqual(200);
  expect((await shareResponse).status()).toBeLessThan(300);
  const shareError = page.locator('.error-msg');
  if (await shareError.isVisible().catch(() => false)) {
    throw new Error(`Share generation failed: ${(await shareError.textContent())?.trim() || 'unknown error'}`);
  }
  await expect(page.locator('#share-url')).toBeVisible({ timeout: 30_000 });
  const shareUrl = await page.locator('#share-url').inputValue();
  const fragment = new URL(shareUrl).hash;
  expect(fragment).not.toBe('');

  let fragmentLeaked = false;
  const anonymousContext = await browser.newContext({
    serviceWorkers: 'block',
    acceptDownloads: true,
  });
  try {
    anonymousContext.on('request', request => {
      if (request.url().includes(fragment)) fragmentLeaked = true;
    });
    const publicPage = await anonymousContext.newPage();
    await installE2EBackendRouting(publicPage);
    await publicPage.goto(shareUrl);
    await expect(publicPage).not.toHaveURL(/\/drive\//);
    const downloadPromise = publicPage.waitForEvent('download');
    await publicPage.getByRole('button', { name: 'Baixar Arquivo' }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error('Anonymous share download did not produce a file');
    expect(await sha256File(downloadPath)).toBe(expected);
  } finally {
    await anonymousContext.close();
  }
  expect(fragmentLeaked).toBe(false);
});
