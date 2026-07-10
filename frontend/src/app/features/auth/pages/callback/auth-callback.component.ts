import { Component, inject, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../../../core/auth/auth.service';

/**
 * OAuth 2.0 callback page.
 *
 * Google redirects here after authentication:
 *   /auth/callback#id_token=<jwt>&state=<nonce>&...
 *
 * This component reads the URL fragment (hash), extracts the id_token
 * and state (nonce), and delegates to AuthService.handleOAuthCallback()
 * which sends them to the backend for validation.
 */
@Component({
  selector: 'app-auth-callback',
  standalone: true,
  template: `
    <div class="callback-page">
      <div class="callback-card">
        @if (authService.loading()) {
          <div class="spinner"></div>
          <p class="callback-text">Autenticando com Google...</p>
          <p class="callback-subtext">Aguarde enquanto verificamos sua identidade.</p>
        } @else if (authService.error()) {
          <span class="material-symbols-outlined" style="color: #d93025; font-size: 48px;">error</span>
          <p class="callback-text">Erro na Autenticação</p>
          <p class="callback-subtext" style="color: #d93025;">{{ authService.error() }}</p>
          <button class="retry-btn" (click)="goToLogin()">Voltar ao Login</button>
        } @else {
          <div class="spinner"></div>
          <p class="callback-text">Redirecionando...</p>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 100vh;
      }

      .callback-page {
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
      }

      .callback-card {
        background: white;
        border-radius: 24px;
        padding: 48px;
        box-shadow:
          0 1px 3px 0 rgba(60, 64, 67, 0.3),
          0 4px 8px 3px rgba(60, 64, 67, 0.15);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 20px;
        animation: fadeIn 400ms ease-out;
      }

      @keyframes fadeIn {
        from {
          opacity: 0;
          transform: translateY(12px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .spinner {
        width: 40px;
        height: 40px;
        border: 3px solid #e8eaed;
        border-top-color: #1a73e8;
        border-radius: 50%;
        animation: spin 800ms linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      .callback-text {
        font-size: 16px;
        font-weight: 500;
        color: #202124;
        margin: 0;
      }

      .callback-subtext {
        font-size: 14px;
        color: #5f6368;
        margin: 0;
      }
      .retry-btn {
        margin-top: 16px;
        padding: 10px 20px;
        background: white;
        border: 1px solid #dadce0;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 500;
        color: #1a73e8;
        cursor: pointer;
        transition: background 0.2s;
      }
      .retry-btn:hover {
        background: #f8f9fa;
      }
    `,
  ],
})
export class AuthCallbackComponent implements OnInit {
  protected readonly authService = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  ngOnInit() {
    // Angular router can sometimes clear window.location.hash or take time to sync.
    // It's safer to read the fragment and queryParams directly from ActivatedRoute.
    
    // Some OAuth providers might return data in queryParams if misconfigured, let's catch that too just for debugging
    const queryParams = this.route.snapshot.queryParams;
    if (queryParams['error'] || queryParams['code']) {
        console.error("Recebeu resposta via Query Params ao inves de Fragment! Isso significa que o Google retornou um Authorization Code ao inves de um Implicit Token.", queryParams);
    }

    this.route.fragment.subscribe((fragment) => {
      console.log("[AuthCallback] Fragment received:", fragment);
      
      if (fragment) {
        this.authService.handleOAuthCallback(fragment);
      } else {
        // Fallback for cases where fragment is empty but data might be in queryParams
        if (Object.keys(queryParams).length > 0) {
            const simulatedFragment = new URLSearchParams(queryParams).toString();
            this.authService.handleOAuthCallback(simulatedFragment);
        } else {
            console.error("[AuthCallback] Fragment is empty!");
            this.authService.handleOAuthCallback('');
        }
      }
    });
  }

  goToLogin() {
    this.router.navigate(['/login']);
  }
}
