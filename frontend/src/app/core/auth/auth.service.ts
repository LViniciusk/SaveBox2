import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, of, catchError, map, tap, switchMap } from 'rxjs';
import { AppStateService, UserInfo, AppStatus } from '../state/app-state.service';
import { CryptoService } from '../crypto/crypto.service';
import { environment } from '../../../environments/environment';
import { BYPASS_LOGOUT } from '../interceptors/error.interceptor';

interface GoogleLoginResponse {
  token: string;
}

/**
 * Authentication service handling OAuth 2.0 Implicit Flow and JWT management.
 *
 * Flow:
 * 1. User clicks "Entrar com Google"
 * 2. Frontend redirects to Google OAuth
 * 3. Google redirects back to /auth/callback#id_token=...&state=nonce
 * 4. AuthCallbackComponent sends { id_token, nonce } to POST /api/auth/google
 * 5. Backend validates and returns { token: "jwt" } + sets HttpOnly cookie
 * 6. JWT stored in RAM, state → Locked, navigate to /vault
 *
 * SECURITY:
 * - The JWT Bearer Token is stored exclusively in RAM.
 * - On F5, restoreSession() calls GET /api/auth/refresh to get a new JWT via HttpOnly cookie.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly appState = inject(AppStateService);
  private readonly cryptoService = inject(CryptoService);

  private jwtToken: string | null = null;

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  private readonly _error = signal<string | null>(null);
  readonly error = this._error.asReadonly();

  readonly isAuthenticated = computed(() => this.appState.status() !== AppStatus.Unauthenticated && this.appState.status() !== AppStatus.Loading);

  getToken(): string | null {
    return this.jwtToken;
  }

  /**
   * Called by APP_INITIALIZER to restore session on F5 using HttpOnly cookie.
   */
  restoreSession(): Observable<boolean> {
    return this.http
      .get<GoogleLoginResponse>(`${environment.apiUrl}/api/auth/refresh`, {
        withCredentials: true,
        context: new HttpContext().set(BYPASS_LOGOUT, true),
      })
      .pipe(
        map((res) => {
          this.jwtToken = res.token;
          
          // We can't decode user info from refresh without the backend returning it,
          // but for now we decode it from the new JWT if it has it, or use a placeholder.
          // In a real app, /refresh should return user info. We'll use a placeholder.
          const userInfo = this.decodeUserFromIdToken(res.token);
          
          // Extrair a flag real do JWT em vez de usar o mock
          const isVaultInitialized = this.isVaultInitializedFromToken(res.token);

          this.appState.login(userInfo, isVaultInitialized);
          return true;
        }),
        catchError(() => {
          this.appState.logout();
          return of(false);
        })
      );
  }

  loginWithGoogle(): void {
    const nonce = crypto.randomUUID();

    const params = new URLSearchParams({
      client_id: environment.googleClientId,
      redirect_uri: `${window.location.origin}/auth/callback`,
      response_type: 'id_token',
      scope: 'openid email profile',
      nonce,
      state: nonce,
      prompt: 'select_account',
    });

    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  handleOAuthCallback(fragment: string): void {
    const params = new URLSearchParams(fragment);
    const idToken = params.get('id_token');
    const state = params.get('state');

    if (!idToken || !state) {
      const error = params.get('error');
      this._error.set(
        error === 'access_denied'
          ? 'Acesso negado. Tente novamente.'
          : 'Falha na autenticação: token não recebido.',
      );
      this.router.navigate(['/login']);
      return;
    }

    this._loading.set(true);
    this._error.set(null);

    this.http
      .post<GoogleLoginResponse>(`${environment.apiUrl}/api/auth/google`, {
        id_token: idToken,
        nonce: state,
      }, { withCredentials: true })
      .subscribe({
        next: (res) => {
          this.jwtToken = res.token;
          const userInfo = this.decodeUserFromIdToken(res.token);
          
          // Extrair a flag real do JWT
          const isVaultInitialized = this.isVaultInitializedFromToken(res.token);

          this.appState.login(userInfo, isVaultInitialized);

          this._loading.set(false);
          this.router.navigate([isVaultInitialized ? '/drive/home' : '/drive/setup']);
        },
        error: (err) => {
          console.error('[AuthService] Google login failed:', err);
          this._error.set(
            err.error?.error || 'Falha na autenticação com Google.',
          );
          this._loading.set(false);
          this.router.navigate(['/login']);
        },
      });
  }

  private decodeUserFromIdToken(idToken: string): UserInfo {
    try {
      let payloadSegment = idToken.split('.')[1];
      payloadSegment = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
      while (payloadSegment.length % 4) {
        payloadSegment += '=';
      }
      // Decode unicode properly via encodeURIComponent/escape
      const decodedStr = decodeURIComponent(
        atob(payloadSegment).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
      );
      const decoded = JSON.parse(decodedStr);
      return {
        email: decoded.email,
        name: decoded.name || '',
        picture: decoded.picture || '',
      };
    } catch (e) {
      console.error('Failed to decode id token', e);
      return { email: '', name: '', picture: '' };
    }
  }

  /**
   * Helper to extract is_vault_initialized from the JWT
   */
  private isVaultInitializedFromToken(token: string): boolean {
    try {
      let payloadSegment = token.split('.')[1];
      payloadSegment = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
      while (payloadSegment.length % 4) {
        payloadSegment += '=';
      }
      const decoded = JSON.parse(atob(payloadSegment));
      return decoded.is_vault_initialized === true || decoded.is_vault_initialized === 'true';
    } catch {
      return false;
    }
  }

  updateProfile(name: string, avatarUrl: string): Promise<any> {
    return new Promise((resolve, reject) => {
      this.http.put(`${environment.apiUrl}/users/me/profile`, {
        full_name: name,
        avatar_url: avatarUrl
      }, { withCredentials: true }).subscribe({
        next: (res) => {
          // Since the JWT token contains the old name/picture, 
          // we might need to refresh the token. Let's just call restoreSession()
          this.restoreSession().subscribe({
            next: () => resolve(res),
            error: (err) => resolve(res) // resolve anyway, as the DB update succeeded
          });
        },
        error: (err) => reject(err)
      });
    });
  }

  uploadProfilePic(file: File): Observable<any> {
    const formData = new FormData();
    formData.append('image', file);
    return this.http.post(`${environment.apiUrl}/users/me/profile-pic`, formData, { withCredentials: true }).pipe(
      switchMap(() => this.restoreSession())
    );
  }

  linkGoogleDrive(code: string, state: string): void {
    this._loading.set(true);
    this._error.set(null);

    this.http.post(`${environment.apiUrl}/api/storage/google/link`, {
      auth_code: code,
      state: state
    }, { withCredentials: true }).subscribe({
      next: () => {
        this._loading.set(false);
        this.router.navigate(['/drive/home'], { queryParams: { drive_linked: 'success' } });
      },
      error: (err) => {
        console.error('[AuthService] Google Drive link failed:', err);
        this._error.set(err.error?.error || 'Falha ao vincular o Google Drive.');
        this._loading.set(false);
      }
    });
  }

  loginWithCredentials(username: string, password: string):Observable<boolean> {
    return this.http.post<GoogleLoginResponse>(`${environment.apiUrl}/login`, { username, password }, { withCredentials: true })
      .pipe(
        tap(res => {
          this.jwtToken = res.token;
          const userInfo = this.decodeUserFromIdToken(res.token);
          const isVaultInitialized = this.isVaultInitializedFromToken(res.token);
          this.appState.login(userInfo, isVaultInitialized);
        }),
        map(() => true)
      );
  }

  register(username: string, email: string, password: string): Observable<any> {
    return this.http.post(`${environment.apiUrl}/register`, { username, email, password });
  }

  verifyEmail(token: string): Observable<any> {
    return this.http.get(`${environment.apiUrl}/verify?token=${token}`);
  }

  // --- GETTERS ---
  logout(): void {
    const token = this.jwtToken;

    this.jwtToken = null;
    this.cryptoService.lockVault();
    this.appState.logout();

    if (token) {
      this.http
        .post(
          `${environment.apiUrl}/logout`,
          {},
          { 
            headers: { Authorization: `Bearer ${token}` },
            withCredentials: true 
          }
        )
        .subscribe({ error: () => {} });
    }

    this.router.navigate(['/login']);
  }

  logoutGlobal(): void {
    const token = this.jwtToken;

    this.jwtToken = null;
    this.cryptoService.lockVault();
    this.appState.logout();

    if (token) {
      this.http
        .post(
          `${environment.apiUrl}/logout/global`,
          {},
          { 
            headers: { Authorization: `Bearer ${token}` },
            withCredentials: true 
          }
        )
        .subscribe({ error: () => {} });
    }

    this.router.navigate(['/login']);
  }
}
