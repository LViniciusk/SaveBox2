import { Component, EventEmitter, Output, inject, signal } from '@angular/core';
import { CryptoService } from '../../../../core/crypto/crypto.service';
import { AppStateService } from '../../../../core/state/app-state.service';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-unlock-modal',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="modal-backdrop" (click)="onBackdropClick($event)">
      <div class="modal-content">
        <div class="modal-header">
          <h2>Desbloquear Cofre</h2>
          <button class="close-btn" (click)="close()">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>

        <div class="modal-body">
          <p>Insira sua Frase de Segurança para descriptografar os arquivos em memória.</p>
          
          <form (ngSubmit)="onSubmit()" #unlockForm="ngForm">
            <div class="form-group">
              <input
                type="password"
                id="phrase"
                name="phrase"
                [(ngModel)]="phrase"
                required
                placeholder="Frase de Segurança"
                autofocus
              />
            </div>

            @if (error()) {
              <div class="error-msg">{{ error() }}</div>
            }

            <div class="modal-actions">
              <button type="button" class="cancel-btn" (click)="close()">Cancelar</button>
              <button type="submit" class="unlock-btn" [disabled]="unlockForm.invalid || loading()">
                @if (loading()) {
                  <div class="spinner-small"></div>
                } @else {
                  Desbloquear
                }
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      .modal-backdrop {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        animation: fadeIn 0.2s ease-out;
      }
      .modal-content {
        background: white;
        border-radius: 8px;
        width: 100%;
        max-width: 400px;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        animation: slideUp 0.2s ease-out;
      }
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes slideUp {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 24px;
        border-bottom: 1px solid #dadce0;
      }
      .modal-header h2 {
        margin: 0;
        font-size: 18px;
        color: #202124;
        font-weight: 500;
      }
      .close-btn {
        background: transparent;
        border: none;
        color: #5f6368;
        cursor: pointer;
        padding: 4px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .close-btn:hover {
        background: #f1f3f4;
      }
      .modal-body {
        padding: 24px;
      }
      .modal-body p {
        margin: 0 0 20px;
        color: #5f6368;
        font-size: 14px;
        line-height: 1.5;
      }
      .form-group input {
        width: 100%;
        padding: 12px;
        border: 1px solid #dadce0;
        border-radius: 4px;
        font-size: 15px;
        box-sizing: border-box;
      }
      .form-group input:focus {
        outline: none;
        border-color: #1a73e8;
      }
      .error-msg {
        color: #d93025;
        font-size: 13px;
        margin-top: 8px;
      }
      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 12px;
        margin-top: 24px;
      }
      .cancel-btn {
        background: transparent;
        border: none;
        color: #5f6368;
        padding: 8px 16px;
        border-radius: 4px;
        font-weight: 500;
        cursor: pointer;
      }
      .cancel-btn:hover {
        background: #f1f3f4;
      }
      .unlock-btn {
        background: #1a73e8;
        color: white;
        border: none;
        padding: 8px 24px;
        border-radius: 4px;
        font-weight: 500;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 100px;
      }
      .unlock-btn:hover:not(:disabled) {
        background: #1557b0;
      }
      .unlock-btn:disabled {
        background: #8ab4f8;
        cursor: not-allowed;
      }
      .spinner-small {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.4);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    `,
  ],
})
export class UnlockModalComponent {
  private readonly cryptoService = inject(CryptoService);
  private readonly appState = inject(AppStateService);

  @Output() modalClosed = new EventEmitter<void>();

  phrase = '';
  error = signal<string | null>(null);
  loading = signal(false);

  onBackdropClick(event: MouseEvent) {
    if ((event.target as HTMLElement).classList.contains('modal-backdrop')) {
      this.close();
    }
  }

  close() {
    this.modalClosed.emit();
  }

  async onSubmit() {
    this.error.set(null);
    this.loading.set(true);

    try {
      await this.cryptoService.deriveVaultKey(this.phrase);
      this.appState.unlock();
      this.close();
    } catch (e) {
      console.error(e);
      this.error.set('Frase incorreta ou falha ao derivar chave.');
      this.loading.set(false);
    }
  }
}
