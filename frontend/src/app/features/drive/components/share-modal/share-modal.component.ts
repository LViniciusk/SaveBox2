import { Component, EventEmitter, Output, inject, input, output, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DriveService } from '../../services/drive.service';
import { CryptoService } from '../../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../../core/crypto/kasumi-crypto.service';
import { DriveFile } from '../../state/drive.store';
import { firstValueFrom } from 'rxjs';
@Component({
  selector: 'app-share-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="modal-backdrop" (click)="onBackdropClick($event)">
      <div class="modal-content">
        <div class="modal-header">
          <h2>Gerenciar Compartilhamento</h2>
          <button class="close-btn" (click)="closeModal()">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>

        <div class="modal-body">
          <p class="file-info">
            Arquivo: {{ file().decryptedName || file().encryptedName }}
          </p>

          @if (error()) {
            <div class="error-msg">{{ error() }}</div>
          }

          @if (loading()) {
            <div class="loading-state">
              <div class="spinner-small"></div>
              <span>Carregando...</span>
            </div>
          } @else {
            <!-- Link Generation Area -->
            @if (generatedLink()) {
              <div class="link-display">
                <label for="share-url">Link de Acesso:</label>
                <div class="link-input-group">
                  <input
                    type="text"
                    id="share-url"
                    [value]="generatedLink()"
                    readonly
                    #shareInput
                  />
                  <button class="action-btn-primary" (click)="copyToClipboard(shareInput)">
                    Copiar
                  </button>
                </div>
                @if (copySuccess()) {
                  <span class="success-msg">Copiado para a area de transferencia!</span>
                }
              </div>
            } @else {
              <div class="empty-state">
                <p>Nao ha links de compartilhamento ativos para este arquivo.</p>
                <button class="generate-btn" (click)="generateLink()" [disabled]="loading()">
                  Gerar Link Publico
                </button>
              </div>
            }

            <!-- Active Shares List -->
            @if (activeShares().length > 0) {
              <div class="shares-section">
                <h3>Links Ativos</h3>
                <div class="shares-list">
                  @for (share of activeShares(); track share.id) {
                    <div class="share-item">
                      <div class="share-info">
                        <span class="share-id-label">ID: {{ share.share_id }}</span>
                        <span class="share-date">Criado em: {{ share.created_at }}</span>
                      </div>
                      <button class="revoke-btn" (click)="revokeShare(share.share_id)" [disabled]="revokingId() === share.share_id">
                        @if (revokingId() === share.share_id) {
                          <span>Revogando...</span>
                        } @else {
                          <span>Revogar</span>
                        }
                      </button>
                    </div>
                  }
                </div>
              </div>
            }
          }

          <div class="modal-actions">
            <button type="button" class="cancel-btn" (click)="closeModal()">Fechar</button>
          </div>
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
        max-width: 500px;
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
      .file-info {
        margin: 0 0 16px;
        color: #202124;
        font-weight: 500;
        font-size: 14px;
      }
      .loading-state {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 24px 0;
        color: #5f6368;
      }
      .spinner-small {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(0, 0, 0, 0.1);
        border-top-color: #1a73e8;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      .error-msg {
        color: #d93025;
        font-size: 13px;
        margin-bottom: 12px;
        padding: 8px 12px;
        background: #fce8e6;
        border-radius: 4px;
      }
      .success-msg {
        color: #137333;
        font-size: 12px;
        display: block;
        margin-top: 6px;
      }
      .link-display {
        margin-bottom: 24px;
        display: flex;
        flex-direction: column;
      }
      .link-display label {
        font-size: 13px;
        font-weight: 500;
        color: #5f6368;
        margin-bottom: 6px;
      }
      .link-input-group {
        display: flex;
        gap: 8px;
      }
      .link-input-group input {
        flex: 1;
        padding: 10px 12px;
        border: 1px solid #dadce0;
        border-radius: 4px;
        font-size: 14px;
        background: #f1f3f4;
        color: #3c4043;
        outline: none;
      }
      .action-btn-primary {
        background: #1a73e8;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        font-weight: 500;
        cursor: pointer;
        font-size: 14px;
      }
      .action-btn-primary:hover {
        background: #1557b0;
      }
      .empty-state {
        padding: 24px 0;
        text-align: center;
        border: 1px dashed #dadce0;
        border-radius: 8px;
        margin-bottom: 24px;
      }
      .empty-state p {
        color: #5f6368;
        font-size: 14px;
        margin: 0 0 16px;
      }
      .generate-btn {
        background: #1a73e8;
        color: white;
        border: none;
        padding: 10px 20px;
        border-radius: 4px;
        font-weight: 500;
        cursor: pointer;
        font-size: 14px;
      }
      .generate-btn:hover {
        background: #1557b0;
      }
      .shares-section {
        border-top: 1px solid #dadce0;
        padding-top: 16px;
        margin-bottom: 24px;
      }
      .shares-section h3 {
        margin: 0 0 12px;
        font-size: 14px;
        font-weight: 500;
        color: #202124;
      }
      .shares-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 150px;
        overflow-y: auto;
      }
      .share-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 12px;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
      }
      .share-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .share-id-label {
        font-size: 13px;
        font-weight: 500;
        color: #1e293b;
      }
      .share-date {
        font-size: 11px;
        color: #64748b;
      }
      .revoke-btn {
        background: transparent;
        border: 1px solid #cbd5e1;
        color: #dc2626;
        padding: 6px 12px;
        border-radius: 4px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
      }
      .revoke-btn:hover:not(:disabled) {
        background: #fef2f2;
        border-color: #fca5a5;
      }
      .modal-actions {
        display: flex;
        justify-content: flex-end;
        border-top: 1px solid #dadce0;
        padding-top: 16px;
        margin-top: 16px;
      }
      .cancel-btn {
        background: #f1f3f4;
        border: none;
        color: #3c4043;
        padding: 8px 16px;
        border-radius: 4px;
        font-weight: 500;
        cursor: pointer;
        font-size: 14px;
      }
      .cancel-btn:hover {
        background: #e8eaed;
      }
    `
  ]
})
export class ShareModalComponent implements OnInit {
  readonly file = input.required<DriveFile>();
  readonly close = output<void>();

  private readonly driveService = inject(DriveService);
  private readonly cryptoService = inject(CryptoService);
  private readonly kasumi = inject(KasumiCryptoService);

  readonly loading = signal(false);
  readonly revokingId = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly generatedLink = signal<string | null>(null);
  readonly activeShares = signal<{ id: number, share_id: string, created_at: string }[]>([]);
  readonly copySuccess = signal(false);

  ngOnInit() {
    this.loadActiveShares();
  }

  async loadActiveShares() {
    this.loading.set(true);
    this.error.set(null);
    try {
      const shares = await firstValueFrom(this.driveService.listShares(this.file().id));
      this.activeShares.set(shares);
      if (shares.length > 0) {
        // A share already exists, rebuild the final URL with the decrypted FDK
        await this.buildShareUrl(shares[0].share_id);
      } else {
        this.generatedLink.set(null);
      }
      this.loading.set(false);
    } catch (err: any) {
      console.error('Erro ao buscar compartilhamentos', err);
      this.error.set(err?.error?.error || 'Nao foi possivel carregar a lista de compartilhamentos.');
      this.loading.set(false);
    }
  }

  async generateLink() {
    this.loading.set(true);
    this.error.set(null);

    try {
      const encryptedFdk = this.file().encryptedFdk;
      if (!encryptedFdk) {
        throw new Error('Chave de criptografia do ficheiro ausente.');
      }
      const decryptedFdkBase64 = await this.cryptoService.decryptName(encryptedFdk);
      const fdkString = atob(decryptedFdkBase64);
      const fdkArray = new Uint8Array(fdkString.length);
      for (let i = 0; i < fdkString.length; i++) {
        fdkArray[i] = fdkString.charCodeAt(i);
      }

      const filename = this.file().decryptedName || this.file().encryptedName;
      const encryptedNameFdk = await this.kasumi.encryptName(filename, fdkArray);

      try {
        const res = await firstValueFrom(this.driveService.createShareLink(this.file().id, encryptedNameFdk));
        await this.buildShareUrl(res.share_id);
        
        try {
          const shares = await firstValueFrom(this.driveService.listShares(this.file().id));
          this.activeShares.set(shares);
          this.loading.set(false);
        } catch {
          this.loading.set(false);
        }
      } catch (err: any) {
        console.error('Erro ao gerar link de compartilhamento', err);
        this.error.set(err?.error?.error || 'Nao foi possivel gerar o link de compartilhamento.');
        this.loading.set(false);
      }
    } catch (e: any) {
      console.error('Erro ao preparar FDK ou nome criptografado', e);
      this.error.set(e?.message || 'Falha ao descriptografar chave do arquivo.');
      this.loading.set(false);
    }
  }

  async buildShareUrl(shareId: string) {
    try {
      const encryptedFdk = this.file().encryptedFdk;
      if (!encryptedFdk) {
        throw new Error('Chave de criptografia do ficheiro ausente.');
      }
      const decryptedFdkBase64 = await this.cryptoService.decryptName(encryptedFdk);
      const fdkString = atob(decryptedFdkBase64);
      const fdkArray = new Uint8Array(fdkString.length);
      for (let i = 0; i < fdkString.length; i++) {
        fdkArray[i] = fdkString.charCodeAt(i);
      }

      // Convert standard Base64 to Base64 URL-Safe (replacing + with -, / with _, and removing trailing =)
      const binString = String.fromCharCode(...fdkArray);
      const fdkBase64UrlSafe = btoa(binString)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const shareUrl = `${window.location.origin}/share/${shareId}#${fdkBase64UrlSafe}`;
      this.generatedLink.set(shareUrl);
    } catch (e: any) {
      console.error('Erro ao descriptografar FDK', e);
      this.error.set(e?.message || 'Falha ao descriptografar chave do arquivo.');
    }
  }

  async revokeShare(shareId: string) {
    this.revokingId.set(shareId);
    this.error.set(null);
    try {
      await firstValueFrom(this.driveService.revokeShare(shareId));
      this.generatedLink.set(null);
      this.activeShares.update(shares => shares.filter(s => s.share_id !== shareId));
      this.revokingId.set(null);
    } catch (err: any) {
      console.error('Erro ao revogar compartilhamento', err);
      this.error.set(err?.error?.error || 'Nao foi possivel revogar o link de compartilhamento.');
      this.revokingId.set(null);
    }
  }

  copyToClipboard(inputElement: HTMLInputElement) {
    inputElement.select();
    navigator.clipboard.writeText(inputElement.value).then(() => {
      this.copySuccess.set(true);
      setTimeout(() => this.copySuccess.set(false), 2000);
    });
  }

  onBackdropClick(event: MouseEvent) {
    if ((event.target as HTMLElement).classList.contains('modal-backdrop')) {
      this.closeModal();
    }
  }

  closeModal() {
    this.close.emit();
  }
}
