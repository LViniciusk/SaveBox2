import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { uploadLocalFile } from '../e2e/support/session';

test('upload helper rejects a filename mismatch before browser I/O', async () => {
  let touchedPage = false;
  const page = {
    getByTestId: () => {
      touchedPage = true;
      return { setInputFiles: async () => { touchedPage = true; } };
    },
  } as unknown as Page;

  await expect(uploadLocalFile(page, join('fixture', 'actual.mp4'), 'other.mp4'))
    .rejects.toThrow('E2E upload filename mismatch: expected "other.mp4", got "actual.mp4".');
  expect(touchedPage).toBe(false);
});
