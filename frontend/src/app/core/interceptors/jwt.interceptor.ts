import { type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { environment } from '../../../environments/environment';
import { AuthService } from '../auth/auth.service';
import { isUrlWithinBase } from './request-authority';

/**
 * Attaches the in-memory Nanika JWT only to configured backend authorities.
 *
 * The token is read from AuthService.getToken() which holds it
 * exclusively in a private variable (never in storage).
 */
export const jwtInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const token = authService.getToken();
  if (!token) return next(req);

  const isNanikaBackendRequest =
    isUrlWithinBase(req.url, environment.apiUrl)
    || isUrlWithinBase(req.url, environment.uploadApiUrl);

  if (!isNanikaBackendRequest) return next(req);

  return next(req.clone({
    setHeaders: {
      Authorization: `Bearer ${token}`,
    },
    withCredentials: true,
  }));
};
