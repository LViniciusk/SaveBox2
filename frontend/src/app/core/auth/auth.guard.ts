import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
import { AppStateService, AppStatus } from '../state/app-state.service';

/**
 * Functional route guard that blocks access to protected routes
 * (e.g. /vault) if the user is not authenticated.
 *
 * Redirects to /login when status is Unauthenticated.
 */
export const authGuard: CanActivateFn = (route, state) => {
  const appState = inject(AppStateService);
  const router = inject(Router);

  const status = appState.status();

  if (status === AppStatus.Unauthenticated) {
    router.navigate(['/login']);
    return false;
  }

  // Se o utilizador está em onboarding mas não está a tentar aceder a /drive/setup, redireciona.
  if (status === AppStatus.Onboarding && !state.url.includes('/drive/setup')) {
    router.navigate(['/drive/setup']);
    return false;
  }

  // Se o utilizador já tem o cofre criado (Locked/Unlocked) mas tentar aceder a /drive/setup, redireciona para home.
  if ((status === AppStatus.Locked || status === AppStatus.Unlocked) && state.url.includes('/drive/setup')) {
    router.navigate(['/drive/home']);
    return false;
  }

  return true;
};
