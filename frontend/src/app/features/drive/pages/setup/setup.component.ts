import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { CryptoService } from '../../../../core/crypto/crypto.service';
import { AppStateService } from '../../../../core/state/app-state.service';
import { AuthService } from '../../../../core/auth/auth.service';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { downloadSecurityPhraseRecoveryFile } from '../../../../core/crypto/recovery-file';
@Component({
  selector: 'app-setup',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="setup-page">
      <div class="setup-card">
        <div class="header">
          <span class="material-symbols-outlined icon">key</span>
          <h1>Configurar Drive</h1>
        </div>

        <p class="description">
          Bem-vindo ao Nanika. Para garantir a arquitetura <strong>Zero-Knowledge</strong>,
          precisamos criar a sua Frase de Segurança. Ela será usada para gerar a sua chave de criptografia.
        </p>

        <div class="warning-box">
          <span class="material-symbols-outlined">warning</span>
          <p>
            <strong>Atenção:</strong> Nós NÃO salvamos esta frase. Se você a perder,
            seus arquivos estarão perdidos para sempre.
          </p>
        </div>

        <form (ngSubmit)="onSubmit()" #setupForm="ngForm">
          <div class="form-group">
            <label for="phrase">Frase de Segurança</label>
            <input
              type="password"
              id="phrase"
              name="phrase"
              [(ngModel)]="phrase"
              required
              minlength="8"
              placeholder="Digite uma frase forte"
            />
          </div>

          <div class="form-group">
            <label for="confirmPhrase">Confirme a Frase</label>
            <input
              type="password"
              id="confirmPhrase"
              name="confirmPhrase"
              [(ngModel)]="confirmPhrase"
              required
              placeholder="Digite novamente"
            />
          </div>

          @if (error()) {
            <div class="error-msg">{{ error() }}</div>
          }

          @if (warning()) {
            <div class="recovery-warning">
              <strong>Drive inicializado com sucesso.</strong>
              <span>{{ warning() }}</span>
              <div class="recovery-actions">
                <button type="button" class="secondary-btn" (click)="retryRecovery()" [disabled]="loading()">
                  Tentar baixar novamente
                </button>
                <button type="button" class="secondary-btn" (click)="continueWithoutRecovery()" [disabled]="loading()">
                  Continuar mesmo assim
                </button>
              </div>
            </div>
          }

          <button
            type="submit"
            class="submit-btn"
            [disabled]="setupForm.invalid || loading() || vaultInitialized()"
          >
            @if (loading()) {
              Criando Drive...
            } @else {
              Inicializar Drive
            }
          </button>
        </form>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 100vh;
        background: #F8FAFD;
      }
      .setup-page {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        padding: 24px;
      }
      .setup-card {
        background: #ffffff;
        border-radius: 12px;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        padding: 40px;
        max-width: 480px;
        width: 100%;
      }
      .header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 16px;
      }
      .header .icon {
        font-size: 32px;
        color: #1a73e8;
      }
      .header h1 {
        margin: 0;
        font-size: 24px;
        color: #202124;
        font-weight: 500;
      }
      .description {
        color: #5f6368;
        line-height: 1.6;
        margin-bottom: 24px;
      }
      .warning-box {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        background: #fef7e0;
        border: 1px solid #fbbc04;
        border-radius: 8px;
        padding: 16px;
        margin-bottom: 24px;
      }
      .warning-box .material-symbols-outlined {
        color: #e37400;
      }
      .warning-box p {
        margin: 0;
        color: #b06000;
        font-size: 14px;
        line-height: 1.5;
      }
      .form-group {
        margin-bottom: 20px;
      }
      .form-group label {
        display: block;
        font-size: 14px;
        font-weight: 500;
        color: #3c4043;
        margin-bottom: 8px;
      }
      .form-group input {
        width: 100%;
        padding: 12px 16px;
        border: 1px solid #dadce0;
        border-radius: 6px;
        font-size: 15px;
        transition: border-color 0.2s;
        box-sizing: border-box;
      }
      .form-group input:focus {
        outline: none;
        border-color: #1a73e8;
      }
      .error-msg {
        color: #d93025;
        font-size: 14px;
        margin-bottom: 16px;
      }
      .recovery-warning {
        display: flex;
        flex-direction: column;
        gap: 8px;
        color: #8a4b08;
        background: #fef7e0;
        border: 1px solid #fbbc04;
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 16px;
        font-size: 14px;
        line-height: 1.45;
      }
      .recovery-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .secondary-btn {
        background: #fff;
        color: #1a73e8;
        border: 1px solid #1a73e8;
        border-radius: 6px;
        padding: 8px 12px;
        cursor: pointer;
      }
      .secondary-btn:disabled {
        opacity: .6;
        cursor: not-allowed;
      }
      .submit-btn {
        width: 100%;
        background: #1a73e8;
        color: white;
        border: none;
        padding: 12px;
        border-radius: 6px;
        font-size: 16px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.2s;
      }
      .submit-btn:hover:not(:disabled) {
        background: #1557b0;
      }
      .submit-btn:disabled {
        background: #8ab4f8;
        cursor: not-allowed;
      }
    `,
  ],
})
export class SetupComponent {
  private readonly cryptoService = inject(CryptoService);
  private readonly appState = inject(AppStateService);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  phrase = '';
  confirmPhrase = '';
  error = signal<string | null>(null);
  warning = signal<string | null>(null);
  loading = signal(false);
  vaultInitialized = signal(false);
  private committedPhrase = '';

  async onSubmit() {
    this.error.set(null);
    this.warning.set(null);

    if (this.vaultInitialized()) return;

    if (this.phrase !== this.confirmPhrase) {
      this.error.set('As frases não coincidem.');
      return;
    }

    if (this.phrase.length < 8) {
      this.error.set('A frase deve ter pelo menos 8 caracteres.');
      return;
    }

    this.loading.set(true);

    // Yield to let the UI update the spinner before blocking the main thread with Argon2id
    await new Promise(resolve => setTimeout(resolve, 50));

    try {
      await this.cryptoService.initializeVault(this.phrase);
      this.vaultInitialized.set(true);
      this.committedPhrase = this.phrase;
      if (!this.tryDownloadRecovery()) {
        this.loading.set(false);
        return;
      }
      await this.finalizeSetupNavigation();
    } catch {
      this.error.set('Erro ao inicializar o drive.');
      this.loading.set(false);
    }
  }

  async retryRecovery(): Promise<void> {
    if (!this.vaultInitialized() || !this.committedPhrase) return;
    this.loading.set(true);
    this.warning.set(null);
    if (!this.tryDownloadRecovery()) {
      this.loading.set(false);
      return;
    }
    await this.finalizeSetupNavigation();
  }

  async continueWithoutRecovery(): Promise<void> {
    if (!this.vaultInitialized()) return;
    this.warning.set(null);
    await this.finalizeSetupNavigation();
  }

  private tryDownloadRecovery(): boolean {
    try {
      downloadSecurityPhraseRecoveryFile(this.committedPhrase);
      return true;
    } catch {
      this.warning.set('Não foi possível baixar o arquivo de recuperação. Guarde sua Frase de Segurança com segurança antes de continuar.');
      return false;
    }
  }

  private async finalizeSetupNavigation(): Promise<void> {
    try {
      await firstValueFrom(this.authService.restoreSession());
    } catch {
      // O vault já foi inicializado; preserve o fluxo atual mesmo sem refresh.
    }
    this.loading.set(false);
    this.phrase = '';
    this.confirmPhrase = '';
    this.appState.unlock();
    this.committedPhrase = '';
    this.router.navigate(['/drive/home']);
  }

}
