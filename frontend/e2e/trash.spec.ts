import { test, expect } from './support/fixtures';
import type { Page, Response, TestInfo } from '@playwright/test';
import {
  deterministicFile,
  driveItem,
  loginAndUnlock,
  uniqueFileName,
  uploadLocalFile,
} from './support/session';

type TrashPhase =
  | 'upload'
  | 'first-trash'
  | 'open-trash'
  | 'restore'
  | 'return-home'
  | 'second-trash'
  | 'reopen-trash'
  | 'hard-delete'
  | 'cycle-complete';

interface UnauthorizedDiagnostic {
  cycle: number;
  phase: TrashPhase;
  method: string;
  pathname: string;
  hasAuthorization: boolean;
}

const DEFAULT_TRASH_CYCLES = 1;
const MAX_TRASH_CYCLES = 20;

function readTrashCycleCount(): number {
  const raw = process.env['NANIKA_E2E_TRASH_CYCLES'];
  if (raw === undefined) return DEFAULT_TRASH_CYCLES;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TRASH_CYCLES) {
    throw new Error(
      `NANIKA_E2E_TRASH_CYCLES must be an integer between 1 and ${MAX_TRASH_CYCLES}`,
    );
  }

  return value;
}

function unauthorizedSummary(items: readonly UnauthorizedDiagnostic[]): string {
  return items
    .map(item =>
      `cycle=${item.cycle} phase=${item.phase} ${item.method} ${item.pathname} ` +
      `auth=${item.hasAuthorization ? 'present' : 'missing'}`,
    )
    .join('; ');
}

async function runTrashCycle(
  page: Page,
  testInfo: TestInfo,
  cycle: number,
  setPhase: (phase: TrashPhase) => void,
  assertNoUnauthorized: () => void,
): Promise<void> {
  const filename = uniqueFileName(`trash-e2e-${cycle}`, 'txt');
  const filePath = await deterministicFile(testInfo.outputPath(filename), 1024);

  setPhase('upload');
  await uploadLocalFile(page, filePath, filename);
  assertNoUnauthorized();

  const item = driveItem(page, filename);
  setPhase('first-trash');
  await item.click({ button: 'right' });
  await page.getByRole('button', { name: /Mover para a lixeira/ }).click();
  const trashResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'DELETE' && /\/files\/\d+$/.test(url.pathname);
  });
  await page.getByRole('button', { name: /Mover para a lixeira/ }).last().click();
  const trashResult = await trashResponse;
  expect(
    trashResult.ok(),
    `Trash request failed: ${trashResult.status()} ${new URL(trashResult.url()).pathname}`,
  ).toBeTruthy();
  await expect(page).toHaveURL(/\/drive\/home$/);
  await expect(item).toHaveCount(0);
  assertNoUnauthorized();

  setPhase('open-trash');
  const trashButton = page.getByRole('button', { name: /Lixeira/ });
  await expect(trashButton).toBeVisible();
  await trashButton.click();
  const trashedItem = driveItem(page, filename);
  await expect(trashedItem).toBeVisible();
  assertNoUnauthorized();

  setPhase('restore');
  await trashedItem.click({ button: 'right' });
  const restoreResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'POST' && /\/files\/\d+\/restore$/.test(url.pathname);
  });
  await page.getByRole('button', { name: /Restaurar/ }).click();
  const restoreResult = await restoreResponse;
  expect(
    restoreResult.ok(),
    `Restore request failed: ${restoreResult.status()} ${new URL(restoreResult.url()).pathname}`,
  ).toBeTruthy();

  setPhase('return-home');
  await expect(page).toHaveURL(/\/drive\/home$/);
  await expect(trashedItem).toHaveCount(0);
  assertNoUnauthorized();
  const driveButton = page.getByRole('button', { name: /Meu Drive/ });
  await expect(driveButton).toBeVisible();
  await driveButton.click();
  await expect(driveItem(page, filename)).toBeVisible();

  setPhase('second-trash');
  const restoredItem = driveItem(page, filename);
  await restoredItem.click({ button: 'right' });
  await page.getByRole('button', { name: /Mover para a lixeira/ }).click();
  const secondTrashResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'DELETE' && /\/files\/\d+$/.test(url.pathname);
  });
  await page.getByRole('button', { name: /Mover para a lixeira/ }).last().click();
  const secondTrashResult = await secondTrashResponse;
  expect(
    secondTrashResult.ok(),
    `Trash request failed: ${secondTrashResult.status()} ${new URL(secondTrashResult.url()).pathname}`,
  ).toBeTruthy();
  await expect(page).toHaveURL(/\/drive\/home$/);
  await expect(restoredItem).toHaveCount(0);
  assertNoUnauthorized();

  setPhase('reopen-trash');
  await expect(trashButton).toBeVisible();
  await trashButton.click();
  const finalItem = driveItem(page, filename);
  await expect(finalItem).toBeVisible();

  setPhase('hard-delete');
  await finalItem.click({ button: 'right' });
  await page.getByRole('button', { name: /Excluir permanentemente/ }).click();
  await expect(page.getByText('Excluir permanentemente?', { exact: false })).toBeVisible();
  const hardDeleteResponse = page.waitForResponse(response => {
    const url = new URL(response.url());
    return response.request().method() === 'DELETE' && /\/trash\/files\/\d+$/.test(url.pathname);
  });
  await page.getByRole('button', { name: /Excluir permanentemente/ }).last().click();
  const hardDeleteResult = await hardDeleteResponse;
  expect(
    hardDeleteResult.ok(),
    `Hard delete request failed: ${hardDeleteResult.status()} ${new URL(hardDeleteResult.url()).pathname}`,
  ).toBeTruthy();
  await expect(finalItem).toHaveCount(0);
  assertNoUnauthorized();

  setPhase('cycle-complete');
  await driveButton.click();
  await expect(page).toHaveURL(/\/drive\/home$/);
}

const cycles = readTrashCycleCount();
const title = cycles === 1
  ? 'moves a local file to trash, restores it, and permanently deletes it'
  : `moves a local file to trash, restores it, and permanently deletes it (${cycles} cycles)`;

test(title, async ({ page, credentials }, testInfo) => {
  if (cycles > 1) testInfo.setTimeout(cycles * 10_000);
  await loginAndUnlock(page, credentials);

  const unauthorized: UnauthorizedDiagnostic[] = [];
  let currentCycle = 1;
  let currentPhase: TrashPhase = 'upload';
  const collectUnauthorized = (response: Response) => {
    if (response.status() !== 401) return;

    const request = response.request();
    const authorization = request.headers()['authorization'];
    unauthorized.push({
      cycle: currentCycle,
      phase: currentPhase,
      method: request.method(),
      pathname: new URL(response.url()).pathname,
      hasAuthorization: authorization !== undefined,
    });
  };
  const setPhase = (phase: TrashPhase) => {
    currentPhase = phase;
  };
  const assertNoUnauthorized = () => {
    expect(
      unauthorized,
      `Unexpected protected 401 responses: ${unauthorizedSummary(unauthorized)}`,
    ).toEqual([]);
  };

  page.on('response', collectUnauthorized);
  try {
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      currentCycle = cycle;
      await runTrashCycle(page, testInfo, cycle, setPhase, assertNoUnauthorized);
    }
  } finally {
    page.off('response', collectUnauthorized);
  }
});
