import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CryptoService } from '../../../../core/crypto/crypto.service';
import { AppStateService } from '../../../../core/state/app-state.service';

/**
 * Unlock modal with passphrase input, visibility toggle, and unlock button.
 * Placed inside the LockOverlayComponent via content projection.
 *
 * On unlock:
 * 1. Derives vault key from passphrase via PBKDF2 (CryptoService).
 * 2. Transitions app state from Locked → Unlocked.
 * 3. Wipes the passphrase from component memory.
 */
@Component({
  selector: 'app-unlock-modal',
  imports: [FormsModule],
  template: `
    <div class="unlock-card" [class.shake]="shakeError()">
      <span class="material-symbols-outlined lock-icon">lock</span>
      <h2>Cofre Trancado</h2>
      <p class="description">
        Insira sua Frase de Segurança para desbloquear e visualizar os arquivos.
      </p>

      <div class="input-group">
        <div class="input-wrapper">
          <input
            [type]="showPassword() ? 'text' : 'password'"
            [(ngModel)]="passphrase"
            placeholder="Frase de Segurança"
            (keydown.enter)="unlock()"
            [disabled]="loading()"
            autocomplete="off"
            id="passphrase-input"
          />
          <button
            class="toggle-visibility"
            (click)="showPassword.set(!showPassword())"
            type="button"
            aria-label="Alternar visibilidade da senha"
          >
            <span class="material-symbols-outlined">
              {{ showPassword() ? 'visibility_off' : 'visibility' }}
            </span>
          </button>
        </div>
        @if (errorMessage()) {
          <span class="error-text">{{ errorMessage() }}</span>
        }
      </div>

      <button
        class="unlock-btn"
        (click)="unlock()"
        [disabled]="loading() || !passphrase"
        id="unlock-vault-btn"
      >
        @if (loading()) {
          <span class="spinner"></span>
          Derivando chave...
        } @else {
          <span class="material-symbols-outlined">lock_open</span>
          Destrancar Cofre
        }
      </button>
    </div>
  `,
  styles: [
    `
      @keyframes shake {
        0%,
        100% {
          transform: translateX(0);
        }
        10%,
        30%,
        50%,
        70%,
        90% {
          transform: translateX(-6px);
        }
        20%,
        40%,
        60%,
        80% {
          transform: translateX(6px);
        }
      }

      .unlock-card {
        background: white;
        border-radius: 16px;
        padding: 48px 40px;
        box-shadow:
          0 1px 3px 0 rgba(60, 64, 67, 0.3),
          0 4px 8px 3px rgba(60, 64, 67, 0.15);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
        max-width: 400px;
        width: 100%;
        text-align: center;
        animation: cardSlideUp 400ms cubic-bezier(0.4, 0, 0.2, 1);
      }

      @keyframes cardSlideUp {
        from {
          opacity: 0;
          transform: translateY(16px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      .unlock-card.shake {
        animation: shake 500ms ease-in-out;
      }

      .lock-icon {
        font-size: 56px;
        color: #1a73e8;
        font-variation-settings: 'FILL' 1;
      }

      h2 {
        font-size: 22px;
        font-weight: 500;
        color: #202124;
        margin: 0;
      }

      .description {
        font-size: 14px;
        color: #5f6368;
        margin: 0;
        line-height: 1.5;
      }

      .input-group {
        width: 100%;
        margin-top: 8px;
      }

      .input-wrapper {
        position: relative;
        width: 100%;
      }

      input {
        width: 100%;
        padding: 14px 48px 14px 16px;
        border: 1px solid #dadce0;
        border-radius: 8px;
        font-size: 15px;
        font-family: 'Roboto', sans-serif;
        color: #202124;
        outline: none;
        transition:
          border-color 200ms ease,
          box-shadow 200ms ease;
        background: #fff;
      }

      input:focus {
        border-color: #1a73e8;
        box-shadow: 0 0 0 2px rgba(26, 115, 232, 0.2);
      }

      input:disabled {
        background: #f1f3f4;
        color: #9aa0a6;
      }

      .toggle-visibility {
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        color: #5f6368;
        transition: background 150ms ease;
      }

      .toggle-visibility:hover {
        background: #f1f3f4;
      }

      .toggle-visibility .material-symbols-outlined {
        font-size: 20px;
      }

      .error-text {
        display: block;
        color: #d93025;
        font-size: 12px;
        margin-top: 8px;
        text-align: left;
      }

      .unlock-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        width: 100%;
        padding: 12px 24px;
        background: #1a73e8;
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 15px;
        font-weight: 500;
        font-family: 'Roboto', sans-serif;
        cursor: pointer;
        transition:
          background 200ms ease,
          box-shadow 200ms ease;
        margin-top: 8px;
      }

      .unlock-btn:hover:not(:disabled) {
        background: #1967d2;
        box-shadow:
          0 1px 3px 0 rgba(60, 64, 67, 0.3),
          0 4px 8px 3px rgba(60, 64, 67, 0.15);
      }

      .unlock-btn:active:not(:disabled) {
        background: #185abc;
      }

      .unlock-btn:disabled {
        background: #dadce0;
        color: #9aa0a6;
        cursor: not-allowed;
      }

      .unlock-btn .material-symbols-outlined {
        font-size: 20px;
      }

      .spinner {
        width: 18px;
        height: 18px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 800ms linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class UnlockModalComponent {
  private readonly cryptoService = inject(CryptoService);
  private readonly appState = inject(AppStateService);

  passphrase = '';
  readonly showPassword = signal(false);
  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly shakeError = signal(false);

  async unlock(): Promise<void> {
    if (!this.passphrase || this.loading()) return;

    this.loading.set(true);
    this.errorMessage.set(null);

    try {
      await this.cryptoService.deriveVaultKey(this.passphrase);
      this.appState.unlock();
      // Wipe passphrase from component memory immediately
      this.passphrase = '';
    } catch {
      this.errorMessage.set('Falha ao derivar a chave. Verifique sua frase e tente novamente.');
      this.shakeError.set(true);
      setTimeout(() => this.shakeError.set(false), 500);
    } finally {
      this.loading.set(false);
    }
  }
}
