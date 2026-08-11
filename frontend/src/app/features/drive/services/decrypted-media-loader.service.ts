import { Injectable, inject } from '@angular/core';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { DriveFile } from '../state/drive.store';
import { DriveService } from './drive.service';
import { ShareService } from './share.service';
import { previewMimeType } from './file-preview-resolver';
import { firstValueFromAbortable } from '../upload/abortable-observable';

export interface DecryptedMediaResource {
  url: string;
  mimeType: string;
  cleanup(): void;
}

@Injectable({ providedIn: 'root' })
export class DecryptedMediaLoaderService {
  private readonly driveService = inject(DriveService);
  private readonly shareService = inject(ShareService);
  private readonly cryptoService = inject(CryptoService);
  private readonly kasumi = inject(KasumiCryptoService);

  async load(file: DriveFile, signal?: AbortSignal): Promise<DecryptedMediaResource> {
    this.throwIfAborted(signal);
    const encryptedBlob = await this.downloadEncrypted(file, signal);
    this.throwIfAborted(signal);
    const fdk = await this.resolveOwnedFdk(file);
    let decryptedBlob: Blob;
    try {
      this.throwIfAborted(signal);
      decryptedBlob = await this.kasumi.decryptFile(encryptedBlob, fdk, file.sizeBytes);
      this.throwIfAborted(signal);
    } finally {
      fdk.fill(0);
    }

    const mimeType = previewMimeType(file);
    const url = URL.createObjectURL(new Blob([decryptedBlob], { type: mimeType }));
    let cleaned = false;
    return {
      url,
      mimeType,
      cleanup: () => {
        if (!cleaned) {
          cleaned = true;
          URL.revokeObjectURL(url);
        }
      },
    };
  }

  private async downloadEncrypted(file: DriveFile, signal?: AbortSignal): Promise<Blob> {
    if (file.shareUuid && file.shareFdk) {
      return this.shareService.downloadSharedFileInRanges(file.shareUuid, file.sizeBytes, undefined, signal);
    }
    if (file.storageProvider === 'google_drive') {
      const meta = await firstValueFromAbortable(this.driveService.downloadExternalMetadata(file.id), signal);
      const url = `https://www.googleapis.com/drive/v3/files/${meta.external_file_id}?alt=media`;
      return firstValueFromAbortable(this.driveService.downloadExternalFileRange(url, meta.access_token, 0, file.sizeBytes - 1), signal);
    }
    return this.driveService.downloadFileInRanges(file.id, file.sizeBytes, signal);
  }

  private async resolveOwnedFdk(file: DriveFile): Promise<Uint8Array> {
    if (file.shareUuid && file.shareFdk) return file.shareFdk.slice();
    if (!file.encryptedFdk) throw new Error('Chave de criptografia nao encontrada (FDK)');
    const base64 = await this.cryptoService.decryptName(file.encryptedFdk);
    const binary = atob(base64);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
}
