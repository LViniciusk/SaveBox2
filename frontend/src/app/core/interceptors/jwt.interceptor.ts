import { type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from '../auth/auth.service';

/**
 * HTTP interceptor that attaches the JWT Bearer Token
 * from RAM to every outgoing request.
 *
 * The token is read from AuthService.getToken() which holds it
 * exclusively in a private variable (never in storage).
 */
export const jwtInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const token = authService.getToken();

  if (token) {
    req = req.clone({
      setHeaders: {
        Authorization: `Bearer ${token}`,
      },
      withCredentials: true,
    });
  }

  return next(req);
};
