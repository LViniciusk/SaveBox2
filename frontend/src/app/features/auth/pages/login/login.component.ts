import {
  Component,
  inject,
  afterNextRender,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../../../core/auth/auth.service';
import { AppStateService } from '../../../../core/state/app-state.service';

/**
 * Login page styled after Google Sign-In.
 *
 * Features a centered card with SaveBox branding and a custom
 * "Entrar com Google" button that initiates the OAuth 2.0 Implicit Flow.
 *
 * Flow: Click → redirect to Google → authenticate → redirect back to /auth/callback
 */
@Component({
  selector: 'app-login',
  template: `
    <div class="login-page">
      <div class="login-card" [class.slide-up]="cardVisible()">
        <!-- Logo -->
        <div class="logo">
          <span class="material-symbols-outlined logo-icon">
            enhanced_encryption
          </span>
          <h1>SaveBox</h1>
        </div>

        <p class="subtitle">
          Armazenamento seguro com criptografia ponta-a-ponta
        </p>

        <div class="divider"></div>

        <p class="signin-text">Faça login para acessar seu cofre</p>

        <!-- Custom Google Sign-In Button -->
        <button
          class="google-signin-btn"
          (click)="signInWithGoogle()"
          [disabled]="authService.loading()"
          id="google-signin-btn"
        >
          <svg class="google-logo" viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Entrar com Google
        </button>

        <!-- Error Banner -->
        @if (authService.error()) {
          <div class="error-banner">
            <span class="material-symbols-outlined">error</span>
            {{ authService.error() }}
          </div>
        }

        <!-- Loading Bar -->
        @if (authService.loading()) {
          <div class="loading-bar">
            <div class="loading-bar-inner"></div>
          </div>
        }

        <!-- Footer -->
        <p class="footer-text">
          <span class="material-symbols-outlined shield-icon">shield</span>
          Zero-Knowledge · E2EE · Os seus dados, apenas seus.
        </p>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 100vh;
      }

      .login-page {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(
          160deg,
          #eef2ff 0%,
          #fafbff 40%,
          #f5f3ff 100%
        );
        padding: 24px;
      }

      .login-card {
        background: white;
        border-radius: 24px;
        padding: 48px 40px;
        box-shadow:
          0 1px 3px 0 rgba(60, 64, 67, 0.3),
          0 4px 8px 3px rgba(60, 64, 67, 0.15);
        max-width: 420px;
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        opacity: 0;
        transform: translateY(24px);
        transition:
          opacity 600ms cubic-bezier(0.4, 0, 0.2, 1),
          transform 600ms cubic-bezier(0.4, 0, 0.2, 1);
      }

      .login-card.slide-up {
        opacity: 1;
        transform: translateY(0);
      }

      /* Logo */
      .logo {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
      }

      .logo-icon {
        font-size: 52px;
        color: #1a73e8;
        font-variation-settings: 'FILL' 1;
      }

      .logo h1 {
        font-size: 28px;
        font-weight: 500;
        color: #202124;
        margin: 0;
        letter-spacing: -0.5px;
        font-family: 'Roboto', sans-serif;
      }

      .subtitle {
        font-size: 14px;
        color: #5f6368;
        text-align: center;
        line-height: 1.5;
        margin: 0;
      }

      .divider {
        width: 100%;
        height: 1px;
        background: #e0e0e0;
        margin: 8px 0;
      }

      .signin-text {
        font-size: 16px;
        color: #202124;
        font-weight: 400;
        margin: 0 0 8px;
      }

      /* Google Sign-In Button — follows Google branding guidelines */
      .google-signin-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        width: 100%;
        max-width: 320px;
        height: 48px;
        padding: 0 24px;
        background: white;
        border: 1px solid #dadce0;
        border-radius: 8px;
        font-size: 15px;
        font-weight: 500;
        font-family: 'Roboto', sans-serif;
        color: #3c4043;
        cursor: pointer;
        transition:
          background 200ms ease,
          box-shadow 200ms ease,
          border-color 200ms ease;
        user-select: none;
      }

      .google-signin-btn:hover:not(:disabled) {
        background: #f8f9fa;
        box-shadow: 0 1px 3px rgba(60, 64, 67, 0.3);
        border-color: #c6c9cd;
      }

      .google-signin-btn:active:not(:disabled) {
        background: #f1f3f4;
        box-shadow: none;
      }

      .google-signin-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .google-logo {
        flex-shrink: 0;
      }

      /* Error Banner */
      .error-banner {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        background: #fce8e6;
        color: #d93025;
        border-radius: 8px;
        font-size: 13px;
        width: 100%;
        animation: fadeIn 250ms ease;
      }

      .error-banner .material-symbols-outlined {
        font-size: 18px;
        flex-shrink: 0;
      }

      @keyframes fadeIn {
        from {
          opacity: 0;
          transform: translateY(-4px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      /* Loading Bar */
      .loading-bar {
        width: 100%;
        height: 3px;
        background: #e8eaed;
        border-radius: 2px;
        overflow: hidden;
      }

      .loading-bar-inner {
        width: 30%;
        height: 100%;
        background: #1a73e8;
        border-radius: 2px;
        animation: loadingSlide 1.5s ease-in-out infinite;
      }

      @keyframes loadingSlide {
        0% {
          transform: translateX(-100%);
        }
        100% {
          transform: translateX(400%);
        }
      }

      /* Footer */
      .footer-text {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: #9aa0a6;
        margin-top: 12px;
      }

      .shield-icon {
        font-size: 16px;
        color: #34a853;
      }

      /* Responsive */
      @media (max-width: 480px) {
        .login-card {
          padding: 36px 24px;
          border-radius: 16px;
        }

        .logo-icon {
          font-size: 44px;
        }

        .logo h1 {
          font-size: 24px;
        }
      }
    `,
  ],
})
export class LoginComponent {
  protected readonly authService = inject(AuthService);
  private readonly appState = inject(AppStateService);
  private readonly router = inject(Router);

  readonly cardVisible = signal(false);

  constructor() {
    // If already authenticated, skip login and go to vault
    if (this.appState.isAuthenticated()) {
      this.router.navigate(['/vault']);
      return;
    }

    afterNextRender(() => {
      requestAnimationFrame(() => this.cardVisible.set(true));
    });
  }

  signInWithGoogle(): void {
    this.authService.loginWithGoogle();
  }
}
