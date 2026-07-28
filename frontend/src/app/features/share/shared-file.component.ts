import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { ShareService, EncryptedFileMetadata } from '../drive/services/share.service';
import { KasumiCryptoService } from '../../core/crypto/kasumi-crypto.service';
import { PublicMediaPlayerComponent } from './public-media-player.component';
import { firstValueFrom } from 'rxjs';

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
          [isImage]="isImage()"
          [storageProvider]="metadata()?.storage_provider || 'local'">
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
      .file-details-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
      }
      .file-icon-wrapper {
        width: 80px;
        height: 80px;
        border-radius: 50%;
        background: #eff6ff;
        color: #3b82f6;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 20px;
      }
      .file-large-icon {
        font-size: 40px;
      }
      .file-name {
        font-size: 18px;
        font-weight: 600;
        color: #0f172a;
        margin: 0 0 6px;
        word-break: break-all;
        max-width: 100%;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .file-size {
        font-size: 14px;
        color: #64748b;
        margin: 0 0 28px;
      }
      .actions-container {
        width: 100%;
      }
      .download-btn {
        width: 100%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        background: #2563eb;
        color: white;
        border: none;
        padding: 12px 24px;
        border-radius: 8px;
        font-weight: 500;
        cursor: pointer;
        font-size: 15px;
        transition: background 0.2s;
      }
      .download-btn:hover {
        background: #1d4ed8;
      }
      .btn-icon {
        font-size: 20px;
      }
      .download-progress-container {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 12px;
        background: #f1f5f9;
        border-radius: 8px;
        color: #475569;
        font-size: 14px;
      }
      .spinner-small {
        width: 18px;
        height: 18px;
        border: 2px solid rgba(0, 0, 0, 0.1);
        border-top-color: #2563eb;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
    `
  ]
})
export class SharedFileComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly shareService = inject(ShareService);
  private readonly kasumi = inject(KasumiCryptoService);

  readonly loading = signal(true);
  readonly downloading = signal(false);
  readonly error = signal<string | null>(null);
  readonly securityError = signal<string | null>(null);

  readonly decryptedName = signal<string>('');
  readonly sizeBytes = signal<number>(0);
  readonly metadata = signal<EncryptedFileMetadata | null>(null);

  shareId = '';
  fdkUint8: Uint8Array | null = null;

  ngOnInit() {
    this.shareId = this.route.snapshot.paramMap.get('id') || '';
    const hash = window.location.hash.substring(1);

    if (!hash) {
      this.securityError.set('Link invalido (Chave ausente)');
      this.loading.set(false);
      return;
    }

    try {
      this.fdkUint8 = this.decodeBase64UrlSafe(hash);
    } catch (e) {
      console.error('Falha ao decodificar FDK do hash', e);
      this.securityError.set('Link invalido (Chave ausente)');
      this.loading.set(false);
      return;
    }

    this.loadMetadata();
  }

  decodeBase64UrlSafe(base64Url: string): Uint8Array {
    let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  async loadMetadata() {
    this.loading.set(true);
    this.error.set(null);

    try {
      const meta = await firstValueFrom(this.shareService.getSharedFileMetadata(this.shareId));
      if (!this.fdkUint8) {
        throw new Error('Chave FDK ausente no escopo.');
      }
      this.metadata.set(meta);
      const name = await this.kasumi.decryptName(meta.encrypted_name, this.fdkUint8);
      this.decryptedName.set(name);
      this.sizeBytes.set(meta.size_bytes);
      this.loading.set(false);
    } catch (err: any) {
      if (err instanceof Error && err.message === 'Chave FDK ausente no escopo.') {
        console.error('Erro ao descriptografar nome do arquivo', err);
        this.error.set('Nao foi possivel descriptografar os metadados do arquivo com a chave fornecida.');
      } else {
        console.error('Erro ao buscar metadados do compartilhamento', err);
        const msg = err?.error?.error || 'Link de compartilhamento expirou ou nao existe mais.';
        this.error.set(msg);
      }
      this.loading.set(false);
    }
  }

  async downloadAndDecryptFile() {
    if (this.downloading() || !this.fdkUint8) return;
    this.downloading.set(true);
    this.error.set(null);

    try {
      const encryptedBlob = await this.shareService.downloadSharedFileInRanges(this.shareId, this.sizeBytes());
      if (!this.fdkUint8) return;
      
      try {
        const rawDecrypted = await this.kasumi.decryptFile(encryptedBlob, this.fdkUint8);
        const url = URL.createObjectURL(rawDecrypted);
        const a = document.createElement('a');
        a.href = url;
        a.download = this.decryptedName();
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.downloading.set(false);
      } catch (e: any) {
        console.error('Erro ao descriptografar arquivo', e);
        this.error.set('Falha na descriptografia do arquivo. A chave pode estar incorreta.');
        this.downloading.set(false);
      }
    } catch (err: any) {
      console.error('Erro ao descarregar arquivo compartilhado', err);
      const msg = err?.error?.error || 'Nao foi possivel descarregar o arquivo do servidor.';
      this.error.set(msg);
      this.downloading.set(false);
    }
  }

  isImage(): boolean {
    const name = this.decryptedName().toLowerCase();
    return /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/.test(name);
  }

  isVideo(): boolean {
    const name = this.decryptedName().toLowerCase();
    return /\.(mp4|webm|ogv|mov|mkv)$/.test(name);
  }

  isMedia(): boolean {
    return this.isImage() || this.isVideo();
  }

  getFileIcon(): string {
    const name = this.decryptedName().toLowerCase();
    if (this.isImage()) {
      return 'image';
    }
    if (this.isVideo()) {
      return 'movie';
    }
    if (/\.(mp3|wav|ogg|flac|m4a)$/.test(name)) {
      return 'audiotrack';
    }
    if (/\.(pdf)$/.test(name)) {
      return 'picture_as_pdf';
    }
    if (/\.(zip|rar|7z|tar|gz)$/.test(name)) {
      return 'zip_box';
    }
    if (/\.(txt|md|rtf|docx|doc|pdf|xlsx|xls|csv|pptx|ppt)$/.test(name)) {
      return 'description';
    }
    return 'insert_drive_file';
  }

  getFormattedSize(): string {
    const bytes = this.sizeBytes();
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}
