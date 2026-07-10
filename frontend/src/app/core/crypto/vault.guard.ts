import { inject } from '@angular/core';
import { type CanActivateFn } from '@angular/router';
import { AppStateService } from '../state/app-state.service';
import { CryptoService } from './crypto.service';

/**
 * Functional route guard for /vault routes.
 *
 * Checks if the Vault Key is present in RAM:
 * - If NOT → sets state to Locked (the LockOverlay handles the visual block).
 * - Always returns true (allows route access; the overlay handles UX).
 */
export const vaultGuard: CanActivateFn = () => {
  const appState = inject(AppStateService);
  const cryptoService = inject(CryptoService);

  if (!cryptoService.isVaultUnlocked()) {
    appState.lock();
  }

  return true;
};
