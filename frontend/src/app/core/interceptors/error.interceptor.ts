import { type HttpInterceptorFn, HttpContextToken } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { AppStateService } from '../state/app-state.service';

/**
 * Token para ignorar o redirect global de logout em chamadas específicas (ex: restoreSession).
 */
export const BYPASS_LOGOUT = new HttpContextToken<boolean>(() => false);

/**
 * HTTP error interceptor for centralized error handling:
 *
 * - 401 Unauthorized → Forces logout and redirects to /login.
 * - 403 Forbidden    → Forces vault lock state.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const appState = inject(AppStateService);

  return next(req).pipe(
    tap({
      error: (error) => {
        if (error.status === 401 && !req.context.get(BYPASS_LOGOUT)) {
          authService.logout();
        } else if (error.status === 403) {
          appState.lock();
        }
      },
    }),
  );
};
