import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AppStateService, AppStatus } from '../state/app-state.service';

/**
 * Functional route guard that blocks access to protected routes
 * (e.g. /vault) if the user is not authenticated.
 *
 * Redirects to /login when status is Unauthenticated.
 */
export const authGuard: CanActivateFn = () => {
  const appState = inject(AppStateService);
  const router = inject(Router);

  if (appState.status() === AppStatus.Unauthenticated) {
    router.navigate(['/login']);
    return false;
  }

  return true;
};
