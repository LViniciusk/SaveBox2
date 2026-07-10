import { Injectable, signal, inject, untracked } from '@angular/core';
import { DriveService } from '../services/drive.service';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { firstValueFrom } from 'rxjs';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';

export interface DriveFile {
  id: number;
  isFolder: boolean;
  encryptedName: string;
  decryptedName: string | null; // Null if locked or failed to decrypt
  type: string;
  sizeBytes: number;
  sizeFormatted: string;
  modifiedAt: string;
  owner: string;
  encryptedFdk?: string;
}

export interface QuotaState {
  usedBytes: number;
  maxBytes: number;
}

@Injectable({ providedIn: 'root' })
export class DriveStore {
  private readonly driveService = inject(DriveService);
  private readonly cryptoService = inject(CryptoService);

  readonly files = signal<DriveFile[]>([]);
  readonly quota = signal<QuotaState>({ usedBytes: 0, maxBytes: 10 * 1024 * 1024 * 1024 });
  readonly isLoading = signal(false);
  
  readonly isUploading = signal(false);
  readonly uploadProgress = signal(0);
  private readonly kasumi = inject(KasumiCryptoService);

  private formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  async loadQuota(): Promise<void> {
    try {
      const res = await firstValueFrom(this.driveService.getQuota());
      this.quota.set({ usedBytes: res.used_bytes, maxBytes: res.max_bytes });
    } catch (e) {
      console.error('Failed to load quota', e);
    }
  }

  async loadTree(): Promise<void> {
    this.isLoading.set(true);
    try {
      const res = await firstValueFrom(this.driveService.getTree());
      
      const parsedFiles: DriveFile[] = [];
      
      for (const folder of res.folders) {
        let decName = null;
        if (this.cryptoService.isVaultUnlocked()) {
          decName = await this.cryptoService.decryptName(folder.encrypted_name);
        }
        parsedFiles.push({
          id: folder.id,
          isFolder: true,
          encryptedName: folder.encrypted_name,
          decryptedName: decName,
          type: 'folder',
          sizeBytes: 0,
          sizeFormatted: '—',
          modifiedAt: '—',
          owner: 'eu'
        });
      }

      for (const file of res.files) {
        let decName = null;
        if (this.cryptoService.isVaultUnlocked()) {
          decName = await this.cryptoService.decryptName(file.encrypted_name);
        }
        
        let type = 'unknown';
        if (decName) {
           if (decName.endsWith('.pdf')) type = 'pdf';
           else if (decName.match(/\.(jpg|jpeg|png)$/i)) type = 'image';
           else if (decName.match(/\.(doc|docx)$/i)) type = 'doc';
           else if (decName.match(/\.(xls|xlsx)$/i)) type = 'spreadsheet';
        }

        parsedFiles.push({
          id: file.id,
          isFolder: false,
          encryptedName: file.encrypted_name,
          decryptedName: decName,
          type: type,
          sizeBytes: file.size_bytes,
          sizeFormatted: this.formatSize(file.size_bytes),
          modifiedAt: '—',
          owner: 'eu',
          encryptedFdk: file.encrypted_fdk
        });
      }

      this.files.set(parsedFiles);
    } catch (e) {
      console.error('Failed to load tree', e);
    } finally {
      this.isLoading.set(false);
    }
  }

  async reDecryptAll(): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) return;
    
    const currentFiles = untracked(() => this.files());
    const updated = [];
    
    for (const f of currentFiles) {
      const decName = await this.cryptoService.decryptName(f.encryptedName);
      
      let type = f.isFolder ? 'folder' : 'unknown';
      if (!f.isFolder && decName) {
         if (decName.endsWith('.pdf')) type = 'pdf';
         else if (decName.match(/\.(jpg|jpeg|png)$/i)) type = 'image';
         else if (decName.match(/\.(doc|docx)$/i)) type = 'doc';
         else if (decName.match(/\.(xls|xlsx)$/i)) type = 'spreadsheet';
      }
      
      updated.push({
        ...f,
        decryptedName: decName,
        type: type
      });
    }
    this.files.set(updated);
  }

  async createFolder(name: string, parentId: number | null = null): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Cofre trancado');
    const encName = await this.cryptoService.encryptName(name);
    const hash = await this.cryptoService.hashName(name);
    
    await firstValueFrom(this.driveService.createFolder(encName, hash, parentId));
    await this.loadTree();
  }

  async uploadFile(file: File, folderId: number | null = null): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Cofre trancado');
    this.isUploading.set(true);
    this.uploadProgress.set(0);

    try {
      const encName = await this.cryptoService.encryptName(file.name);
      const hash = await this.cryptoService.hashName(file.name);
      
      // Generate 32-byte FDK
      const fdk = new Uint8Array(32);
      crypto.getRandomValues(fdk);

      // Encrypt FDK (encode to base64, then encrypt as string)
      const fdkBase64 = btoa(String.fromCharCode(...fdk));
      const encryptedFdk = await this.cryptoService.encryptName(fdkBase64);

      // Init upload
      const initRes = await firstValueFrom(this.driveService.initFileUpload(
        folderId, encName, hash, encryptedFdk, file.size
      ));
      const fileId = initRes.file_id;

      // Encrypt file into Kasumi blob
      const encryptedBlob = await this.kasumi.encryptFile(file, fdk);
      
      // Upload chunks (4MB each max)
      const CHUNK_SIZE = 4 * 1024 * 1024;
      const totalChunks = Math.ceil(encryptedBlob.size / CHUNK_SIZE);

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, encryptedBlob.size);
        const chunk = encryptedBlob.slice(start, end);
        
        await firstValueFrom(this.driveService.uploadChunk(fileId, i, chunk));
        
        // Update progress
        this.uploadProgress.set(Math.round(((i + 1) / totalChunks) * 100));
      }

      await this.loadTree();
      await this.loadQuota();
    } catch (e) {
      console.error('Falha no upload', e);
      throw e;
    } finally {
      this.isUploading.set(false);
      this.uploadProgress.set(0);
    }
  }

  async downloadFile(file: DriveFile): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Cofre trancado');
    if (file.isFolder || !file.encryptedFdk) return;

    try {
      // Fetch encrypted blob
      const encryptedBlob = await firstValueFrom(this.driveService.downloadFile(file.id));

      // Decrypt FDK string using Vault Key
      const fdkBase64 = await this.cryptoService.decryptName(file.encryptedFdk);
      
      // Decode base64 to Uint8Array
      const fdkString = atob(fdkBase64);
      const fdk = new Uint8Array(fdkString.length);
      for (let i = 0; i < fdkString.length; i++) {
        fdk[i] = fdkString.charCodeAt(i);
      }

      // Decrypt the blob using Kasumi XChaCha20
      const decryptedBlob = await this.kasumi.decryptFile(encryptedBlob, fdk);

      // Create object URL and trigger download
      const url = URL.createObjectURL(decryptedBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.decryptedName || 'arquivo_desconhecido';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Falha no download', e);
      throw e;
    }
  }
}
