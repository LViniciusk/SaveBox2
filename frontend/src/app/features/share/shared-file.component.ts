import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { ShareService, EncryptedFileMetadata } from '../drive/services/share.service';
import { KasumiCryptoService } from '../../core/crypto/kasumi-crypto.service';
import { PublicMediaPlayerComponent } from './public-media-player.component';
import { firstValueFromAbortable } from '../drive/upload/abortable-observable';

const SHARE_FDK_BYTES = 32;
const CANONICAL_SHARE_FDK = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

@Component({
  selector: 'app-shared-file',
  standalone: true,
  imports: [CommonModule, PublicMediaPlayerComponent],
  template: `
    <div class="public-share-container">
      @if (securityError()) {
        <div class="share-card">
          <div class="brand-header">
            <span class="brand-title">Nanika Secure Share</span>
          </div>
          <div class="error-state">
            <span class="material-symbols-outlined error-icon">gpp_maybe</span>
            <h2>Erro de Seguranca</h2>
            <p>{{ securityError() }}</p>
          </div>
        </div>
      } @else if (error()) {
        <div class="share-card">
          <div class="brand-header">
            <span class="brand-title">Nanika Secure Share</span>
          </div>
          <div class="error-state">
            <span class="material-symbols-outlined error-icon">error</span>
            <h2>Falha ao Carregar</h2>
            <p>{{ error() }}</p>
            <button class="retry-btn" (click)="loadMetadata()">Tentar Novamente</button>
          </div>
        </div>
      } @else if (loading()) {
        <div class="share-card">
          <div class="brand-header">
            <span class="brand-title">Nanika Secure Share</span>
          </div>
          <div class="loading-state">
            <div class="spinner"></div>
            <p>Buscando e descriptografando metadados do arquivo...</p>
          </div>
        </div>
      } @else if (fdkUint8) {
        <!-- Universal Public Media Player Overlay (Video, Photo & Others) -->
        <app-public-media-player
          [shareId]="shareId"
          [fdk]="fdkUint8!"
          [filename]="decryptedName()"
          [sizeBytes]="sizeBytes()"
          [isVideo]="isVideo()"
          [isImage]="isImage()">
        </app-public-media-player>
      }
    </div>
  `,
  styles: [
    `
      .public-share-container {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100vw;
        height: 100vh;
        background: #090d16;
        font-family: 'Outfit', 'Inter', sans-serif;
        box-sizing: border-box;
        padding: 20px;
        overflow: hidden;
      }
      .share-card {
        background: white;
        border-radius: 14px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.05);
        border: 1px solid #e2e8f0;
        width: 100%;
        max-width: 460px;
        padding: 32px;
        box-sizing: border-box;
      }
      .brand-header {
        text-align: center;
        margin-bottom: 28px;
      }
      .brand-title {
        font-size: 18px;
        font-weight: 600;
        color: #0f172a;
        letter-spacing: -0.025em;
      }
      .error-state {
        text-align: center;
        padding: 16px 0;
      }
      .error-icon {
        font-size: 48px;
        color: #ef4444;
        margin-bottom: 16px;
      }
      .error-state h2 {
        font-size: 18px;
        font-weight: 600;
        color: #0f172a;
        margin: 0 0 8px;
      }
      .error-state p {
        font-size: 14px;
        color: #64748b;
        line-height: 1.5;
        margin: 0 0 20px;
      }
      .retry-btn {
        background: #ef4444;
        color: white;
        border: none;
        padding: 10px 20px;
        border-radius: 6px;
        font-weight: 500;
        cursor: pointer;
        font-size: 14px;
        transition: background 0.2s;
      }
      .retry-btn:hover {
        background: #dc2626;
      }
      .loading-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 32px 0;
        text-align: center;
      }
      .spinner {
        width: 40px;
        height: 40px;
        border: 3px solid rgba(0, 0, 0, 0.05);
        border-top-color: #3b82f6;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        margin-bottom: 20px;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    `
  ]
})
export class SharedFileComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly shareService = inject(ShareService);
  private readonly kasumi = inject(KasumiCryptoService);

  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly securityError = signal<string | null>(null);

  readonly decryptedName = signal<string>('');
  readonly sizeBytes = signal<number>(0);
  readonly metadata = signal<EncryptedFileMetadata | null>(null);

  shareId = '';
  // A página é o owner explícito da FDK raiz do compartilhamento.
  fdkUint8: Uint8Array | null = null;
  private readonly lifecycleController = new AbortController();

  ngOnInit() {
    this.shareId = this.route.snapshot.paramMap.get('id') || '';
    const hash = window.location.hash.substring(1);

    if (!hash) {
      this.securityError.set('Link invalido (Chave ausente)');
      this.loading.set(false);
      return;
    }

    try {
      this.fdkUint8 = this.decodeShareFdk(hash);
    } catch {
      this.securityError.set('Link invalido (Chave ausente)');
      this.loading.set(false);
      return;
    }

    this.loadMetadata();
  }

  private decodeShareFdk(fragment: string): Uint8Array {
    if (!CANONICAL_SHARE_FDK.test(fragment)) {
      throw new Error('Formato de chave de compartilhamento invalido.');
    }

    const base64 = fragment.replace(/-/g, '+').replace(/_/g, '/') + '=';
    let binary: string;
    try {
      binary = atob(base64);
    } catch {
      throw new Error('Formato de chave de compartilhamento invalido.');
    }

    if (binary.length !== SHARE_FDK_BYTES) {
      throw new Error('Tamanho de chave de compartilhamento invalido.');
    }

    const fdk = new Uint8Array(SHARE_FDK_BYTES);
    for (let i = 0; i < SHARE_FDK_BYTES; i++) {
      fdk[i] = binary.charCodeAt(i);
    }
    return fdk;
  }

  async loadMetadata() {
    if (this.lifecycleController.signal.aborted) return;
    this.loading.set(true);
    this.error.set(null);
    let decryptingName = false;

    try {
      const meta = await firstValueFromAbortable(
        this.shareService.getSharedFileMetadata(this.shareId),
        this.lifecycleController.signal,
      );
      this.throwIfAborted();
      const rootFdk = this.fdkUint8;
      if (!rootFdk) {
        throw new Error('Chave FDK ausente no escopo.');
      }
      const operationFdk = rootFdk.slice();
      let name: string;
      decryptingName = true;
      try {
        name = await this.kasumi.decryptName(meta.encrypted_name, operationFdk);
      } finally {
        operationFdk.fill(0);
      }
      decryptingName = false;
      this.throwIfAborted();
      this.metadata.set(meta);
      this.decryptedName.set(name);
      this.sizeBytes.set(meta.size_bytes);
      this.loading.set(false);
    } catch (err: any) {
      if (this.isLifecycleAbort(err)) return;
      if ((err instanceof Error && err.message === 'Chave FDK ausente no escopo.') || decryptingName) {
        this.error.set('Nao foi possivel descriptografar os metadados do arquivo com a chave fornecida.');
      } else {
        const msg = err?.error?.error || 'Link de compartilhamento expirou ou nao existe mais.';
        this.error.set(msg);
      }
      this.loading.set(false);
    }
  }

  ngOnDestroy() {
    this.lifecycleController.abort();
    const rootFdk = this.fdkUint8;
    this.fdkUint8 = null;
    rootFdk?.fill(0);
  }

  private throwIfAborted(): void {
    if (this.lifecycleController.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
  }

  private isLifecycleAbort(error: unknown): boolean {
    return this.lifecycleController.signal.aborted ||
      (error instanceof DOMException && error.name === 'AbortError') ||
      (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError');
  }

  isImage(): boolean {
    const name = this.decryptedName().toLowerCase();
    return /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/.test(name);
  }

  isVideo(): boolean {
    const name = this.decryptedName().toLowerCase();
    return /\.(mp4|webm|ogv|mov|mkv)$/.test(name);
  }

}
