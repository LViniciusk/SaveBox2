import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { expect, type Frame, type Page, type Request, type Response } from '@playwright/test';
import {
  appendLoginEvent,
  classifyLoginUiError,
  safeLoginPath,
  safeRequestFailure,
  summarizeLoginDiagnostic,
  type LoginDiagnosticEvent,
} from '../../tools/e2e-login-diagnostics.mjs';

export interface E2ECredentials {
  username: string;
  email: string;
  password: string;
  vaultPhrase: string;
}

export interface LoginToDriveObserver {
  timeoutMs?: number;
  onPageReady?: () => void;
  onLoginActionTriggered?: () => void;
}

export function generateCredentials(): E2ECredentials {
  const id = randomBytes(12).toString('hex');
  return {
    username: `nanika_e2e_${id}`,
    email: `nanika_e2e_${id}@example.test`,
    password: `Password-${randomBytes(24).toString('base64url')}`,
    vaultPhrase: `Phrase-${randomBytes(24).toString('base64url')}`,
  };
}

function isCredentialLoginRequest(request: Request): boolean {
  if (request.method() !== 'POST') return false;
  try {
    return new URL(request.url()).pathname === '/login';
  } catch {
    return false;
  }
}

async function loginUiError(page: Page): Promise<'none' | 'verification-required' | 'credentials-invalid' | 'other-present'> {
  const banner = page.locator('.error-banner').first();
  const present = await banner.isVisible().catch(() => false);
  const text = present ? await banner.innerText().catch(() => '') : '';
  return classifyLoginUiError(present, text);
}

export async function loginAndUnlock(page: Page, credentials: E2ECredentials): Promise<void> {
  page.on('download', download => {
    if (download.suggestedFilename() === 'nanika-recovery.txt') {
      void download.cancel().catch(() => undefined);
    }
  });
  const startedAt = performance.now();
  const events: LoginDiagnosticEvent[] = [];
  const loginRequests = new WeakMap<Request, number>();
  let loginRequestCount = 0;
  let responseStatus: number | undefined;
  let requestFailure: string | undefined;
  let currentPath: ReturnType<typeof safeLoginPath>;
  let truncated = false;
  const elapsed = () => Math.max(0, Math.round(performance.now() - startedAt));
  const record = (event: LoginDiagnosticEvent) => {
    if (!appendLoginEvent(events, event)) truncated = true;
  };
  const requestDuration = (request: Request) => {
    const started = loginRequests.get(request);
    return started === undefined ? undefined : Math.max(0, Math.round(performance.now() - started));
  };
  const onRequest = (request: Request) => {
    if (!isCredentialLoginRequest(request)) return;
    loginRequestCount += 1;
    loginRequests.set(request, performance.now());
    record({ kind: 'login-request', atMs: elapsed() });
  };
  const onResponse = (response: Response) => {
    const request = response.request();
    if (!isCredentialLoginRequest(request)) return;
    responseStatus = response.status();
    record({ kind: 'login-response', atMs: elapsed(), status: responseStatus, elapsedMs: requestDuration(request) });
  };
  const onRequestFinished = (request: Request) => {
    if (!isCredentialLoginRequest(request)) return;
    record({ kind: 'login-finished', atMs: elapsed(), elapsedMs: requestDuration(request) });
  };
  const onRequestFailed = (request: Request) => {
    if (!isCredentialLoginRequest(request)) return;
    requestFailure = safeRequestFailure(request.failure()?.errorText);
    record({ kind: 'login-failed', atMs: elapsed() });
  };
  const onFrameNavigated = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    currentPath = safeLoginPath(frame.url());
    if (!currentPath) return;
    record({ kind: 'login-navigation', atMs: elapsed(), path: currentPath });
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onRequestFinished);
  page.on('requestfailed', onRequestFailed);
  page.on('framenavigated', onFrameNavigated);
  try {
    await loginToDrive(page, credentials, {
      onPageReady: () => {
        currentPath = safeLoginPath(page.url());
        record({ kind: 'login-page-ready', atMs: elapsed(), path: currentPath });
      },
      onLoginActionTriggered: () => record({ kind: 'login-clicked', atMs: elapsed() }),
    });
    currentPath = safeLoginPath(page.url());
    record({ kind: 'login-navigation-complete', atMs: elapsed(), path: currentPath });
  } catch (error) {
    const uiError = await loginUiError(page);
    const summary = summarizeLoginDiagnostic({
      events,
      loginRequestCount,
      responseStatus,
      requestFailure,
      path: safeLoginPath(page.url()),
      uiError,
      truncated,
    });
    if (error instanceof Error) {
      error.message = `${error.message}\n${summary}`;
      throw error;
    }
    throw new Error(`${summary}`);
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfinished', onRequestFinished);
    page.off('requestfailed', onRequestFailed);
    page.off('framenavigated', onFrameNavigated);
  }

  if (page.url().endsWith('/setup')) {
    await page.locator('#phrase').fill(credentials.vaultPhrase);
    await page.locator('#confirmPhrase').fill(credentials.vaultPhrase);
    await page.getByRole('button', { name: 'Inicializar Drive' }).click();
    await page.waitForURL(/\/drive\/home$/);
  }

  await ensureVaultUnlocked(page, credentials);
}

export async function loginToDrive(
  page: Page,
  credentials: E2ECredentials,
  observer: LoginToDriveObserver = {},
): Promise<'/drive/setup' | '/drive/home'> {
  await page.goto('/login');
  const username = page.getByPlaceholder('E-mail ou Usuário');
  const password = page.getByPlaceholder('Senha');
  const submit = page.getByRole('button', { name: 'Fazer Login' });
  await Promise.all([
    username.waitFor({ state: 'visible' }),
    password.waitFor({ state: 'visible' }),
    submit.waitFor({ state: 'visible' }),
  ]);
  observer.onPageReady?.();
  await username.fill(credentials.username);
  await password.fill(credentials.password);
  observer.onLoginActionTriggered?.();
  await submit.click();
  await page.waitForURL(/\/drive\/(home|setup)$/, observer.timeoutMs ? { timeout: observer.timeoutMs } : undefined);
  const path = new URL(page.url()).pathname;
  if (path === '/drive/setup' || path === '/drive/home') return path;
  throw new Error('E2E login did not reach the drive.');
}

export async function ensureVaultUnlocked(page: Page, credentials: E2ECredentials): Promise<void> {
  const lockedButton = page.getByRole('button', { name: /Desbloquear(?: Drive)?/ }).first();
  if (await lockedButton.isVisible().catch(() => false)) {
    await lockedButton.click();
    const modal = page.locator('.modal-content');
    await expect(modal.getByRole('heading', { name: 'Desbloquear Drive' })).toBeVisible();
    await modal.getByPlaceholder('Frase de Segurança').fill(credentials.vaultPhrase);
    const verificationResponse = page.waitForResponse(response =>
      response.request().method() === 'GET' && /\/api\/vault\/verification$/.test(new URL(response.url()).pathname),
    );
    await modal.getByRole('button', { name: 'Desbloquear', exact: true }).click();
    const verification = await verificationResponse;
    if (verification.status() !== 200) throw new Error(`Vault unlock verification failed (${verification.status()})`);
  }

  await expect(page.locator('button[aria-label="Trancar Drive"], button[title="Trancar Drive"], button.toolbar-icon').filter({ hasText: /lock/ }).first()).toBeVisible({ timeout: 30_000 });
}

export async function lockDrive(page: Page): Promise<void> {
  await page.locator('button[aria-label="Trancar Drive"], button[title="Trancar Drive"], button.toolbar-icon').filter({ hasText: /lock/ }).first().click();
  await expect(page.getByRole('button', { name: /Desbloquear(?: Drive)?/ }).first()).toBeVisible();
}

export async function logout(page: Page): Promise<void> {
  await page.locator('.avatar-btn').click();
  await page.getByRole('button', { name: 'Sair da conta' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

export async function deterministicFile(testPath: string, size: number): Promise<string> {
  const data = Buffer.alloc(size);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = (index * 31 + 17) & 0xff;
  }
  await writeFile(testPath, data);
  return testPath;
}

export async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export function uniqueFileName(prefix: string, extension: string): string {
  return `${prefix}-${randomBytes(8).toString('hex')}.${extension}`;
}

export function driveItem(page: Page, filename: string) {
  return page.locator('.file-row, .grid-card').filter({ hasText: filename }).first();
}

export async function uploadLocalFile(page: Page, filePath: string, filename: string): Promise<void> {
  const actualFilename = basename(filePath);
  if (actualFilename !== filename) {
    throw new Error(`E2E upload filename mismatch: expected "${filename}", got "${actualFilename}".`);
  }

  await page.getByTestId('drive-file-input').setInputFiles(filePath);
  await waitForUploadCompleted(page, filename);
}

async function waitForUploadCompleted(page: Page, filename: string): Promise<void> {
  await page.getByRole('button', { name: /Transferências|Pendentes/ }).click();
  const transfer = page.locator('.transfer-card').filter({ hasText: filename }).first();
  await expect(transfer).toContainText(/Conclu[ií]do/, { timeout: 30_000 });
  await page.getByRole('button', { name: /Meu Drive/ }).click();
  await expect(driveItem(page, filename)).toBeVisible();
  const closeTransfers = page.getByRole('button', { name: /Fechar transferências/ });
  if (await closeTransfers.isVisible().catch(() => false)) await closeTransfers.click();
}

export async function downloadDriveFile(page: Page, filename: string): Promise<string> {
  const downloadPromise = page.waitForEvent('download');
  await driveItem(page, filename).click({ button: 'right' });
  await page.getByRole('button', { name: /Baixar/ }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error('E2E download did not produce a file');
  return path;
}
