import { Injectable, Injector, inject, signal, computed } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, of, catchError, map, tap, switchMap, firstValueFrom } from 'rxjs';
import { AppStateService, UserInfo, AppStatus } from '../state/app-state.service';
import { CryptoService } from '../crypto/crypto.service';
import { environment } from '../../../environments/environment';
import { BYPASS_LOGOUT } from '../interceptors/http-context-tokens';
import { ComputerStore } from '../../features/drive/state/computer.store';
import { DriveStore } from '../../features/drive/state/drive.store';
import { StorageMoveEngineService } from '../../features/drive/storage-move/storage-move-engine.service';

interface GoogleLoginResponse {
  token: string;
}

interface GoogleLoginAttempt {
  state: string;
  nonce: string;
  createdAt: number;
}

/**
 * Authentication service handling OAuth 2.0 Implicit Flow and JWT management.
 *
 * Flow:
 * 1. User clicks "Entrar com Google"
 * 2. Frontend redirects to Google OAuth
 * 3. Frontend stores independent state/nonce values before redirecting
 * 4. Google redirects back to /auth/callback#id_token=...&state=...
 * 5. AuthCallbackComponent validates state and sends the stored nonce
 *    with { id_token, nonce } to POST /api/auth/google
 * 6. Backend validates and returns { token: "jwt" } + sets HttpOnly cookie
 * 7. JWT stored in RAM, state → Locked, navigate to /vault
 *
 * SECURITY:
 * - The JWT Bearer Token is stored exclusively in RAM.
 * - On F5, restoreSession() calls GET /api/auth/refresh to get a new JWT via HttpOnly cookie.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private static readonly GOOGLE_LOGIN_ATTEMPT_KEY = 'nanika.google-login-attempt.v1';
  private static readonly GOOGLE_LOGIN_ATTEMPT_MAX_AGE_MS = 10 * 60 * 1000;

  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly appState = inject(AppStateService);
  private readonly cryptoService = inject(CryptoService);
  private readonly injector = inject(Injector);

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
    this._error.set(null);

    let attempt: GoogleLoginAttempt;
    try {
      attempt = {
        state: crypto.randomUUID(),
        nonce: crypto.randomUUID(),
        createdAt: Date.now(),
      };
    } catch {
      this._error.set('Não foi possível iniciar o login com Google.');
      return;
    }

    if (!this.storeGoogleLoginAttempt(attempt)) {
      this._error.set('Não foi possível iniciar o login com Google.');
      return;
    }

    const params = new URLSearchParams({
      client_id: environment.googleClientId,
      redirect_uri: `${window.location.origin}/auth/callback`,
      response_type: 'id_token',
      scope: 'openid email profile',
      nonce: attempt.nonce,
      state: attempt.state,
      prompt: 'select_account',
    });

    this.redirectToGoogle(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  }

  async handleOAuthCallback(fragment: string): Promise<void> {
    const params = new URLSearchParams(fragment);
    const idToken = params.get('id_token');
    const returnedState = params.get('state');
    const providerError = params.get('error');
    const attempt = this.consumeGoogleLoginAttempt();

    if (!attempt || !returnedState || returnedState !== attempt.state) {
      this._loading.set(false);
      this._error.set('Tentativa de login inválida ou expirada.');
      await this.router.navigate(['/login']);
      return;
    }

    if (providerError) {
      this._loading.set(false);
      this._error.set(
        providerError === 'access_denied'
          ? 'Acesso negado. Tente novamente.'
          : 'Falha na autenticação com Google.',
      );
      await this.router.navigate(['/login']);
      return;
    }

    if (!idToken) {
      this._loading.set(false);
      this._error.set('Falha na autenticação: token não recebido.');
      await this.router.navigate(['/login']);
      return;
    }

    this._loading.set(true);
    this._error.set(null);

    try {
      const res = await firstValueFrom(
        this.http.post<GoogleLoginResponse>(`${environment.apiUrl}/api/auth/google`, {
          id_token: idToken,
          nonce: attempt.nonce,
        }, { withCredentials: true })
      );
      
      this.jwtToken = res.token;
      const userInfo = this.decodeUserFromIdToken(res.token);
      
      // Extrair a flag real do JWT
      const isVaultInitialized = this.isVaultInitializedFromToken(res.token);

      this.appState.login(userInfo, isVaultInitialized);

      this._loading.set(false);
      this.router.navigate([isVaultInitialized ? '/drive/home' : '/drive/setup']);
    } catch (err: any) {
      console.error('[AuthService] Google login failed:', err);
      this._error.set(
        err.error?.error || 'Falha na autenticação com Google.',
      );
      this._loading.set(false);
      this.router.navigate(['/login']);
    }
  }

  private redirectToGoogle(url: string): void {
    window.location.href = url;
  }

  private storeGoogleLoginAttempt(attempt: GoogleLoginAttempt): boolean {
    try {
      sessionStorage.removeItem(AuthService.GOOGLE_LOGIN_ATTEMPT_KEY);
      sessionStorage.setItem(
        AuthService.GOOGLE_LOGIN_ATTEMPT_KEY,
        JSON.stringify(attempt),
      );
      return true;
    } catch {
      try {
        sessionStorage.removeItem(AuthService.GOOGLE_LOGIN_ATTEMPT_KEY);
      } catch {
        // Storage indisponível: o login permanece bloqueado sem redirecionar.
      }
      return false;
    }
  }

  private consumeGoogleLoginAttempt(): GoogleLoginAttempt | null {
    let raw: string | null;

    try {
      raw = sessionStorage.getItem(AuthService.GOOGLE_LOGIN_ATTEMPT_KEY);
      sessionStorage.removeItem(AuthService.GOOGLE_LOGIN_ATTEMPT_KEY);
    } catch {
      return null;
    }

    if (!raw) {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }

      const candidate = parsed as Partial<GoogleLoginAttempt>;
      const now = Date.now();
      if (
        typeof candidate.state !== 'string' ||
        candidate.state.length === 0 ||
        typeof candidate.nonce !== 'string' ||
        candidate.nonce.length === 0 ||
        typeof candidate.createdAt !== 'number' ||
        !Number.isFinite(candidate.createdAt) ||
        candidate.createdAt > now ||
        now - candidate.createdAt > AuthService.GOOGLE_LOGIN_ATTEMPT_MAX_AGE_MS
      ) {
        return null;
      }

      return {
        state: candidate.state,
        nonce: candidate.nonce,
        createdAt: candidate.createdAt,
      };
    } catch {
      return null;
    }
  }

  private clearGoogleLoginAttempt(): void {
    try {
      sessionStorage.removeItem(AuthService.GOOGLE_LOGIN_ATTEMPT_KEY);
    } catch {
      // No pending attempt can remain authoritative when storage is unavailable.
    }
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
    } catch {
      console.error('Failed to decode Google identity');
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

  async updateProfile(name: string, avatarUrl: string): Promise<any> {
    try {
      const res = await firstValueFrom(this.http.put(`${environment.apiUrl}/users/me/profile`, {
        full_name: name,
        avatar_url: avatarUrl
      }, { withCredentials: true }));
      
      // Since the JWT token contains the old name/picture, 
      // we might need to refresh the token. Let's just call restoreSession()
      try {
        await firstValueFrom(this.restoreSession());
      } catch (err) {
        // ignore restore error, as the DB update succeeded
      }
      return res;
    } catch (err) {
      throw err;
    }
  }

  uploadProfilePic(file: File): Observable<any> {
    const formData = new FormData();
    formData.append('image', file);
    return this.http.post(`${environment.apiUrl}/users/me/profile-pic`, formData, { withCredentials: true }).pipe(
      switchMap(() => this.restoreSession())
    );
  }

  async linkGoogleDrive(code: string, state: string): Promise<void> {
    this._loading.set(true);
    this._error.set(null);

    try {
      await firstValueFrom(this.http.post(`${environment.apiUrl}/api/storage/google/link`, {
        auth_code: code,
        state: state
      }, { withCredentials: true }));

      await this.injector.get(ComputerStore, null, { optional: true })?.loadTargets({ force: true });
      await this.injector.get(DriveStore, null, { optional: true })?.loadLinkedAccounts();
      
      this._loading.set(false);
      this.router.navigate(['/drive/home'], { queryParams: { drive_linked: 'success' } });
    } catch (err: any) {
      console.error('[AuthService] Google Drive link failed:', err);
      this._error.set(err.error?.error || 'Falha ao vincular o Google Drive.');
      this._loading.set(false);
    }
  }

  loginWithCredentials(username: string, password: string):Observable<boolean> {
    return this.http.post<GoogleLoginResponse>(`${environment.apiUrl}/login`, { username, password }, { withCredentials: true })
      .pipe(
        tap(res => {
          this.clearGoogleLoginAttempt();
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

    this.clearGoogleLoginAttempt();
    this.jwtToken = null;
    this.injector.get(StorageMoveEngineService, null, { optional: true })?.resetRuntimeState();
    const driveStore = this.injector.get(DriveStore, null, { optional: true });
    driveStore?.resetUploadRuntimeState();
    driveStore?.resetDownloadRuntimeState();
    this.cryptoService.lockVault();
    this.appState.logout();

    if (token) {
      firstValueFrom(this.http.post(
        `${environment.apiUrl}/logout`,
        {},
        { 
          headers: { Authorization: `Bearer ${token}` },
          withCredentials: true 
        }
      )).catch(() => {});
    }

    this.router.navigate(['/login']);
  }

  logoutGlobal(): void {
    const token = this.jwtToken;

    this.clearGoogleLoginAttempt();
    this.jwtToken = null;
    this.injector.get(StorageMoveEngineService, null, { optional: true })?.resetRuntimeState();
    const driveStore = this.injector.get(DriveStore, null, { optional: true });
    driveStore?.resetUploadRuntimeState();
    driveStore?.resetDownloadRuntimeState();
    this.cryptoService.lockVault();
    this.appState.logout();

    if (token) {
      firstValueFrom(this.http.post(
        `${environment.apiUrl}/logout/global`,
        {},
        { 
          headers: { Authorization: `Bearer ${token}` },
          withCredentials: true 
        }
      )).catch(() => {});
    }

    this.router.navigate(['/login']);
  }
}
