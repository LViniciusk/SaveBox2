import { type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { tap } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { AppStateService } from '../state/app-state.service';
import { BYPASS_LOGOUT } from './http-context-tokens';
import { environment } from '../../../environments/environment';
import { isUrlWithinBase } from './request-authority';

/**
 * HTTP error interceptor for centralized error handling:
 *
 * - Nanika backend 401 → Forces logout and redirects to /login.
 * - Nanika backend 403 → Forces vault lock state.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const appState = inject(AppStateService);

  return next(req).pipe(
    tap({
      error: (error) => {
        const isNanikaBackendRequest =
          isUrlWithinBase(req.url, environment.apiUrl) ||
          isUrlWithinBase(req.url, environment.uploadApiUrl);
        if (!isNanikaBackendRequest) return;

        const isPublicShare = req.url.includes('/share/');
        if (error.status === 401 && !req.context.get(BYPASS_LOGOUT) && !isPublicShare) {
          authService.logout();
        } else if (error.status === 403 && !isPublicShare) {
          appState.lock();
        }
      },
    }),
  );
};
