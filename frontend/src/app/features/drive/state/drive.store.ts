import { Injectable, signal, computed, inject, untracked } from '@angular/core';
import { DriveService } from '../services/drive.service';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { firstValueFrom, Subscription } from 'rxjs';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { HttpClient, HttpEventType } from '@angular/common/http';
import { DialogService } from '../../../core/dialog/dialog.service';

export interface TransferItem {
  id: string;
  fileName: string;
  type: 'upload' | 'download';
  status: 'pending' | 'processing' | 'paused' | 'success' | 'error';
  progress: number;
  errorMsg?: string;
  timestamp: Date;
  speed?: string;
  eta?: string;
  bytesTransferred?: number;
  totalBytes?: number;
}

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
  storageProvider?: string;
  parentId?: number | null;
  folderId?: number | null;
}

export interface QuotaState {
  usedBytes: number;
  maxBytes: number;
  gdriveUsedBytes?: number;
  gdriveMaxBytes?: number;
}

@Injectable({ providedIn: 'root' })
export class DriveStore {
  private readonly driveService = inject(DriveService);
  private readonly cryptoService = inject(CryptoService);
  private readonly http = inject(HttpClient);
  private readonly dialogService = inject(DialogService);

  readonly files = signal<DriveFile[]>([]);
  readonly quota = signal<QuotaState>({ usedBytes: 0, maxBytes: 10 * 1024 * 1024 * 1024 });
  readonly isLoading = signal(false);
  
  readonly isUploading = signal(false);
  readonly uploadProgress = signal(0);
  readonly isDownloading = signal(false);
  readonly downloadProgress = signal(0);
  private readonly kasumi = inject(KasumiCryptoService);

  readonly storageProvider = signal<'local' | 'google_drive'>((localStorage.getItem('preferred_storage_provider') as 'local' | 'google_drive') || 'local');
  readonly linkedAccounts = signal<any[]>([]);
  readonly trashFiles = signal<DriveFile[]>([]);
  readonly transfers = signal<TransferItem[]>([]);

  readonly currentFolderId = signal<number | null>(null);

  // States to persist active/paused uploads and downloads in RAM
  private activeUploads = new Map<string, {
    file: File;
    fileId: number;
    fdk: Uint8Array;
    encryptedBlob: Blob;
    totalChunks: number;
    folderId: number | null;
  }>();

  private activeDownloads = new Map<string, {
    file: DriveFile;
    fdk: Uint8Array;
    baseNonce: Uint8Array;
    expectedSize: number;
    plaintextChunks: Blob[];
    decryptedBytes: number;
    currentOffset: number;
    chunkIndex: number;
  }>();

  private pausedTransfers = new Set<string>();
  private activeSubscriptions = new Map<string, Subscription>();
  private transferHistory = new Map<string, { bytes: number, time: number }[]>();

  readonly currentTrashFolderFiles = computed(() => {
    const currentId = this.currentFolderId();
    const trash = this.trashFiles();

    if (currentId === null) {
      const trashFolderIds = new Set(trash.filter(f => f.isFolder).map(f => f.id));
      return trash.filter(f => {
        if (f.isFolder) {
          return f.parentId === null || f.parentId === undefined || !trashFolderIds.has(f.parentId);
        } else {
          return f.folderId === null || f.folderId === undefined || !trashFolderIds.has(f.folderId);
        }
      });
    }

    return trash.filter(f => {
      if (f.isFolder) {
        return f.parentId === currentId;
      } else {
        return f.folderId === currentId;
      }
    });
  });

  readonly currentFolderFiles = computed(() => {
    const currentId = this.currentFolderId();
    return this.files().filter(f => {
      if (f.isFolder) {
        return f.parentId === currentId;
      } else {
        return f.folderId === currentId;
      }
    });
  });

  readonly currentPath = computed(() => {
    const path: { id: number | null; name: string }[] = [{ id: null, name: 'Meu Drive' }];
    let currentId = this.currentFolderId();
    
    const foldersMap = new Map(
      this.files()
        .filter(f => f.isFolder)
        .map(f => [f.id, f])
    );

    const ancestors: { id: number; name: string }[] = [];
    while (currentId !== null) {
      const folder = foldersMap.get(currentId);
      if (!folder) break;
      ancestors.push({
        id: folder.id,
        name: folder.decryptedName || folder.encryptedName
      });
      currentId = folder.parentId ?? null;
    }
    
    return [...path, ...ancestors.reverse()];
  });

  navigateTo(folderId: number | null): void {
    this.currentFolderId.set(folderId);
  }

  navigateUp(): void {
    const currentId = this.currentFolderId();
    if (currentId === null) return;
    const currentFolder = this.files().find(f => f.isFolder && f.id === currentId);
    this.currentFolderId.set(currentFolder?.parentId ?? null);
  }

  setStorageProvider(provider: 'local' | 'google_drive'): void {
    this.storageProvider.set(provider);
    localStorage.setItem('preferred_storage_provider', provider);
  }

  async loadLinkedAccounts(): Promise<void> {
    try {
      const res: any = await firstValueFrom(this.driveService.getLinkedGoogleAccounts());
      const accounts = Array.isArray(res) ? res : (res?.accounts ?? []);
      this.linkedAccounts.set(accounts);
    } catch (e) {
      console.error('Failed to load linked accounts', e);
      this.linkedAccounts.set([]);
    }
  }

  async linkGoogleDrive(): Promise<void> {
    try {
      const res = await firstValueFrom(this.driveService.generateGoogleState());
      const state = res.state;
      
      const params = new URLSearchParams({
        client_id: '887718014727-2jnaobb94ff4imesa6iqiodrgivr9mvb.apps.googleusercontent.com',
        redirect_uri: `${window.location.origin}/auth/callback`,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',
        state: state,
        access_type: 'offline',
        prompt: 'consent select_account',
      });
      window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    } catch (e) {
      console.error('Failed to generate Google Drive OAuth URL', e);
    }
  }

  async unlinkGoogleAccount(accountId: number): Promise<void> {
    try {
      await firstValueFrom(this.driveService.unlinkGoogleAccount(accountId));
      await this.loadLinkedAccounts();
      await this.loadTree();
      await this.loadQuota();
    } catch (e) {
      console.error('Failed to unlink account', e);
    }
  }

  clearDecryptedNames(): void {
    this.files.update(current =>
      current.map(f => ({ ...f, decryptedName: null }))
    );
  }

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
      this.quota.set({ 
        usedBytes: res.used_bytes, 
        maxBytes: res.max_bytes,
        gdriveUsedBytes: res.gdrive_used_bytes || 0,
        gdriveMaxBytes: res.gdrive_max_bytes || 0
      });
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
          owner: 'eu',
          parentId: (folder.parent_id !== undefined && folder.parent_id !== null) ? folder.parent_id : null
        });
      }

      for (const file of res.files) {
        let decName = null;
        if (this.cryptoService.isVaultUnlocked()) {
          decName = await this.cryptoService.decryptName(file.encrypted_name);
        }
        
        let type = 'unknown';
        if (decName) {
           const lower = decName.toLowerCase();
           if (lower.endsWith('.pdf')) type = 'pdf';
           else if (lower.match(/\.(jpg|jpeg|png|gif|webp)$/i)) type = 'image';
           else if (lower.match(/\.(doc|docx)$/i)) type = 'doc';
           else if (lower.match(/\.(xls|xlsx)$/i)) type = 'spreadsheet';
           else if (lower.match(/\.(mp4|webm|mkv|avi|mov)$/i)) type = 'video';
           else if (lower.match(/\.(mp3|wav|ogg|aac|flac)$/i)) type = 'audio';
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
          encryptedFdk: file.encrypted_fdk,
          storageProvider: (file as any).storage_provider || 'local',
          folderId: (file.folder_id !== undefined && file.folder_id !== null) ? file.folder_id : null
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
         const lower = decName.toLowerCase();
         if (lower.endsWith('.pdf')) type = 'pdf';
         else if (lower.match(/\.(jpg|jpeg|png|gif|webp)$/i)) type = 'image';
         else if (lower.match(/\.(doc|docx)$/i)) type = 'doc';
         else if (lower.match(/\.(xls|xlsx)$/i)) type = 'spreadsheet';
         else if (lower.match(/\.(mp4|webm|mkv|avi|mov)$/i)) type = 'video';
         else if (lower.match(/\.(mp3|wav|ogg|aac|flac)$/i)) type = 'audio';
      }
      
      updated.push({
        ...f,
        decryptedName: decName,
        type: type
      });
    }
    this.files.set(updated);
  }

  async createFolder(name: string, parentId: number | null = this.currentFolderId()): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Drive trancado');
    const encName = await this.cryptoService.encryptName(name);
    const hash = await this.cryptoService.hashName(name);
    
    await firstValueFrom(this.driveService.createFolder(encName, hash, parentId));
    await this.loadTree();
  }

  addTransfer(item: Omit<TransferItem, 'timestamp'>) {
    this.transfers.update(list => [{ ...item, timestamp: new Date() }, ...list]);
  }

  updateTransfer(id: string, updates: Partial<TransferItem>) {
    this.transfers.update(list => list.map(item => item.id === id ? { ...item, ...updates } : item));
  }

  clearCompletedTransfers() {
    this.transfers.update(list => list.filter(item => item.status !== 'success' && item.status !== 'error'));
  }

  updateTransferProgress(id: string, progress: number, bytesTransferred: number, totalBytes: number) {
    const now = Date.now();
    let history = this.transferHistory.get(id) || [];
    
    history.push({ bytes: bytesTransferred, time: now });
    history = history.filter(p => now - p.time <= 2000);
    this.transferHistory.set(id, history);

    let speedStr = 'Calculando...';
    let etaStr = '--:-- restante';

    if (history.length >= 2) {
      const oldest = history[0];
      const latest = history[history.length - 1];
      const timeDeltaSec = (latest.time - oldest.time) / 1000;
      const bytesDelta = latest.bytes - oldest.bytes;

      if (timeDeltaSec > 0 && bytesDelta >= 0) {
        const speedBytesPerSec = bytesDelta / timeDeltaSec;
        
        if (speedBytesPerSec < 1024) {
          speedStr = `${speedBytesPerSec.toFixed(1)} B/s`;
        } else if (speedBytesPerSec < 1024 * 1024) {
          speedStr = `${(speedBytesPerSec / 1024).toFixed(1)} KB/s`;
        } else {
          speedStr = `${(speedBytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
        }

        const remainingBytes = totalBytes - bytesTransferred;
        if (speedBytesPerSec > 0) {
          const etaSeconds = Math.max(0, Math.ceil(remainingBytes / speedBytesPerSec));
          const mins = Math.floor(etaSeconds / 60);
          const secs = etaSeconds % 60;
          etaStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')} restantes`;
        } else {
          etaStr = 'Pausado';
        }
      }
    }

    this.updateTransfer(id, { 
      progress, 
      speed: speedStr, 
      eta: etaStr,
      bytesTransferred,
      totalBytes
    });
  }

  async uploadFile(file: File, folderId: number | null = this.currentFolderId()): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Drive trancado');
    this.isUploading.set(true);
    this.uploadProgress.set(0);

    try {
      await this._doUpload(file, folderId);
    } catch (e: any) {
      if (e?.status === 409) {
        const confirmed = await this.dialogService.confirm(
          'Substituir arquivo?',
          `Já existe um arquivo chamado "${file.name}" nesta pasta. Deseja substituir o arquivo existente?`,
          'Substituir',
          true
        );
        if (!confirmed) {
          return;
        }
        const existing = this.files().find(f =>
          !f.isFolder && (f.folderId === folderId) && (f.decryptedName === file.name)
        );
        if (existing) {
          await firstValueFrom(this.driveService.trashFile(existing.id));
          await firstValueFrom(this.driveService.hardDeleteFile(existing.id));
        }
        await this._doUpload(file, folderId);
      } else {
        console.error('Falha no upload', e);
        throw e;
      }
    } finally {
      this.isUploading.set(false);
      this.uploadProgress.set(0);
    }
  }

  private async _doUpload(file: File, folderId: number | null = null): Promise<void> {
    const transferId = 'up_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    this.addTransfer({
      id: transferId,
      fileName: file.name,
      type: 'upload',
      status: 'processing',
      progress: 0
    });

    try {
      const encName = await this.cryptoService.encryptName(file.name);
      const hash = await this.cryptoService.hashName(file.name);
      
      const fdk = new Uint8Array(32);
      crypto.getRandomValues(fdk);

      const fdkBase64 = btoa(String.fromCharCode(...fdk));
      const encryptedFdk = await this.cryptoService.encryptName(fdkBase64);

      const encryptedBlob = await this.kasumi.encryptFile(file, fdk);
      
      const CHUNK_SIZE = 4 * 1024 * 1024;
      const totalChunks = Math.ceil(encryptedBlob.size / CHUNK_SIZE);

      const activeProvider = this.storageProvider();

      const initRes = await firstValueFrom(this.driveService.initFileUpload(
        folderId, encName, hash, encryptedFdk, encryptedBlob.size, totalChunks, activeProvider
      ));
      const fileId = initRes.file_id;

      // Save upload context in activeUploads to allow Pause & Resume
      this.activeUploads.set(transferId, {
        file,
        fileId,
        fdk,
        encryptedBlob,
        totalChunks,
        folderId
      });

      await this.runUploadLoop(transferId, fileId, encryptedBlob, totalChunks, activeProvider, initRes);
    } catch (e: any) {
      this.updateTransfer(transferId, { status: 'error', errorMsg: e?.message || 'Falha no upload' });
      this.activeUploads.delete(transferId);
      throw e;
    }
  }

  private async runUploadLoop(
    transferId: string,
    fileId: number,
    encryptedBlob: Blob,
    totalChunks: number,
    activeProvider: 'local' | 'google_drive',
    initRes: any
  ): Promise<void> {
    const CHUNK_SIZE = 4 * 1024 * 1024;

    if (activeProvider === 'google_drive') {
      const metadata = {
        name: initRes.name_hash || 'file',
        parents: [initRes.root_folder_id]
      };

      const boundary = '-------314159265358979323846';
      const firstDelimiter = `--${boundary}\r\n`;
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelim = `\r\n--${boundary}--\r\n`;

      const metadataPart = JSON.stringify(metadata);
      const arrayBuffer = await encryptedBlob.arrayBuffer();

      const chunks: any[] = [];
      chunks.push(new TextEncoder().encode(
        firstDelimiter + 
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' + 
        metadataPart + 
        delimiter + 
        'Content-Type: application/octet-stream\r\n\r\n'
      ));
      chunks.push(new Uint8Array(arrayBuffer));
      chunks.push(new TextEncoder().encode(closeDelim));

      const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
      const bodyUint8 = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        bodyUint8.set(chunk, offset);
        offset += chunk.length;
      }

      const uploadResPromise = new Promise<any>((resolve, reject) => {
        const sub = this.http.post<any>(
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
          new Blob([bodyUint8]),
          {
            headers: {
              'Authorization': `Bearer ${initRes.access_token}`,
              'Content-Type': `multipart/related; boundary=${boundary}`
            },
            reportProgress: true,
            observe: 'events'
          }
        ).subscribe({
          next: (event: any) => {
            if (event.type === HttpEventType.UploadProgress) {
              const percent = Math.round((event.loaded / event.total) * 100);
              this.uploadProgress.set(percent);
              this.updateTransferProgress(transferId, percent, event.loaded, event.total);
            } else if (event.type === HttpEventType.Response) {
              resolve(event.body);
            }
          },
          error: (err) => reject(err)
        });
        this.activeSubscriptions.set(transferId, sub);
      });

      const uploadRes = await uploadResPromise;
      this.activeSubscriptions.delete(transferId);

      if (this.pausedTransfers.has(transferId)) {
        this.updateTransfer(transferId, { status: 'paused' });
        return;
      }

      if (!uploadRes || !uploadRes.id) {
        throw new Error('Google Drive upload failed: ID missing from response');
      }

      await firstValueFrom(this.driveService.finalizeExternalUpload(fileId, uploadRes.id));
    } else {
      // Local chunked upload
      let uploadedChunks = new Set<number>();
      try {
        const res = await firstValueFrom(this.driveService.getUploadedChunks(fileId));
        uploadedChunks = new Set(res.uploaded_chunks);
      } catch {
        // Fallback
      }

      for (let i = 0; i < totalChunks; i++) {
        if (this.pausedTransfers.has(transferId)) {
          this.updateTransfer(transferId, { status: 'paused' });
          return;
        }

        if (uploadedChunks.has(i)) {
          const percent = Math.round(((i + 1) / totalChunks) * 100);
          const bytesTransferred = Math.min((i + 1) * CHUNK_SIZE, encryptedBlob.size);
          this.updateTransferProgress(transferId, percent, bytesTransferred, encryptedBlob.size);
          continue;
        }

        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, encryptedBlob.size);
        const chunk = encryptedBlob.slice(start, end);
        
        await firstValueFrom(this.driveService.uploadChunk(fileId, i, chunk));
        
        const percent = Math.round(((i + 1) / totalChunks) * 100);
        const bytesTransferred = Math.min((i + 1) * CHUNK_SIZE, encryptedBlob.size);
        this.updateTransferProgress(transferId, percent, bytesTransferred, encryptedBlob.size);
      }
    }

    this.updateTransfer(transferId, { status: 'success', progress: 100 });
    this.activeUploads.delete(transferId);
    await this.loadTree();
    await this.loadQuota();
  }

  async downloadFile(file: DriveFile): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Drive trancado');
    if (file.isFolder || !file.encryptedFdk) return;

    this.isDownloading.set(true);
    this.downloadProgress.set(0);

    const transferId = 'dl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    this.addTransfer({
      id: transferId,
      fileName: file.decryptedName || file.encryptedName,
      type: 'download',
      status: 'processing',
      progress: 0
    });

    const setProgress = (prog: number, bytes: number, total: number) => {
      this.downloadProgress.set(prog);
      this.updateTransferProgress(transferId, prog, bytes, total);
    };

    try {
      setProgress(5, 0, file.sizeBytes);
      const fdkBase64 = await this.cryptoService.decryptName(file.encryptedFdk);
      
      const fdkString = atob(fdkBase64);
      const fdk = new Uint8Array(fdkString.length);
      for (let i = 0; i < fdkString.length; i++) {
        fdk[i] = fdkString.charCodeAt(i);
      }

      setProgress(10, 0, file.sizeBytes);

      if (file.storageProvider === 'google_drive') {
        const meta = await firstValueFrom(this.driveService.downloadExternalMetadata(file.id));
        setProgress(30, 0, file.sizeBytes);

        const dlPromise = new Promise<Blob>((resolve, reject) => {
          const sub = this.driveService.downloadExternalFile(
            `https://www.googleapis.com/drive/v3/files/${meta.external_file_id}?alt=media`,
            meta.access_token
          ).subscribe({
            next: (blob) => resolve(blob),
            error: (err) => reject(err)
          });
          this.activeSubscriptions.set(transferId, sub);
        });

        const encryptedBlob = await dlPromise;
        this.activeSubscriptions.delete(transferId);

        if (this.pausedTransfers.has(transferId)) {
          this.updateTransfer(transferId, { status: 'paused' });
          return;
        }

        setProgress(70, encryptedBlob.size / 2, encryptedBlob.size);
        const decryptedBlob = await this.kasumi.decryptFile(encryptedBlob, fdk);
        setProgress(95, encryptedBlob.size, encryptedBlob.size);

        const url = URL.createObjectURL(decryptedBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.decryptedName || 'arquivo_desconhecido';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        this.updateTransfer(transferId, { status: 'success', progress: 100 });
      } else {
        // Local file chunked download
        setProgress(15, 0, file.sizeBytes);
        const headerBlob = await firstValueFrom(this.driveService.downloadFileRange(file.id, 0, 31));
        const headerBuffer = await headerBlob.arrayBuffer();
        const baseNonce = new Uint8Array(headerBuffer, 0, 24);
        const headerView = new DataView(headerBuffer);
        const expectedSize = Number(headerView.getBigUint64(24, true));

        const plaintextChunks: Blob[] = [];
        const state = {
          file,
          fdk,
          baseNonce,
          expectedSize,
          plaintextChunks,
          decryptedBytes: 0,
          currentOffset: 32,
          chunkIndex: 0
        };
        this.activeDownloads.set(transferId, state);

        await this.runDownloadLoop(transferId, state);
      }
    } catch (e: any) {
      console.error('Falha no download', e);
      this.updateTransfer(transferId, { status: 'error', errorMsg: e?.message || 'Falha no download' });
      this.activeDownloads.delete(transferId);
    } finally {
      this.isDownloading.set(false);
    }
  }

  private async runDownloadLoop(transferId: string, state: any): Promise<void> {
    const CHUNK_SIZE = 4 * 1024 * 1024;
    const { file, fdk, baseNonce, expectedSize, plaintextChunks } = state;

    while (state.decryptedBytes < expectedSize) {
      if (this.pausedTransfers.has(transferId)) {
        this.updateTransfer(transferId, { status: 'paused' });
        return;
      }

      const plaintextSize = Math.min(CHUNK_SIZE, expectedSize - state.decryptedBytes);
      const encryptedSize = 16 + plaintextSize;

      const start = state.currentOffset;
      const end = state.currentOffset + encryptedSize - 1;

      const percent = Math.round((state.decryptedBytes / expectedSize) * 100);
      this.updateTransferProgress(transferId, percent, state.decryptedBytes, expectedSize);

      const chunkBlob = await firstValueFrom(this.driveService.downloadFileRange(file.id, start, end));
      const chunkBuffer = await chunkBlob.arrayBuffer();
      const chunkUint8 = new Uint8Array(chunkBuffer);

      if (chunkUint8.length < encryptedSize) {
        throw new Error('File corrupted or truncated');
      }

      const mac = chunkUint8.slice(0, 16);
      const ciphertext = chunkUint8.slice(16);

      const plaintext = await this.kasumi.decryptFileChunk(
        ciphertext,
        mac,
        baseNonce,
        state.chunkIndex,
        fdk
      );

      plaintextChunks.push(new Blob([plaintext as any]));

      state.decryptedBytes += plaintextSize;
      state.currentOffset += encryptedSize;
      state.chunkIndex++;
    }

    const decryptedBlob = new Blob(plaintextChunks, { type: 'application/octet-stream' });
    this.updateTransferProgress(transferId, 95, expectedSize, expectedSize);

    const url = URL.createObjectURL(decryptedBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.decryptedName || 'arquivo_desconhecido';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    this.updateTransfer(transferId, { status: 'success', progress: 100 });
    this.activeDownloads.delete(transferId);
  }

  pauseTransfer(id: string) {
    this.pausedTransfers.add(id);
    this.updateTransfer(id, { status: 'paused', speed: 'Pausado', eta: '--:--' });

    // Cancel active Google Drive HTTP request if applicable
    const sub = this.activeSubscriptions.get(id);
    if (sub) {
      sub.unsubscribe();
      this.activeSubscriptions.delete(id);
    }
  }

  async resumeUpload(id: string) {
    const data = this.activeUploads.get(id);
    if (!data) return;

    this.pausedTransfers.delete(id);
    this.updateTransfer(id, { status: 'processing', speed: 'Calculando...', eta: '--:--' });

    try {
      const activeProvider = this.storageProvider();
      // Google drive simple uploads are restarted, local ones are resumed from last chunk
      const initRes = { access_token: '', root_folder_id: '' };
      await this.runUploadLoop(id, data.fileId, data.encryptedBlob, data.totalChunks, activeProvider, initRes);
    } catch (e: any) {
      this.updateTransfer(id, { status: 'error', errorMsg: e?.message || 'Falha no upload' });
    }
  }

  async resumeDownload(id: string) {
    const state = this.activeDownloads.get(id);
    if (!state) return;

    this.pausedTransfers.delete(id);
    this.updateTransfer(id, { status: 'processing', speed: 'Calculando...', eta: '--:--' });

    try {
      this.isDownloading.set(true);
      await this.runDownloadLoop(id, state);
    } catch (e: any) {
      this.updateTransfer(id, { status: 'error', errorMsg: e?.message || 'Falha no download' });
    } finally {
      this.isDownloading.set(false);
    }
  }

  async renameItem(file: DriveFile, newName: string): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Drive trancado');
    const encName = await this.cryptoService.encryptName(newName);
    const hash = await this.cryptoService.hashName(newName);

    if (file.isFolder) {
      await firstValueFrom(this.driveService.updateFolder(file.id, { encrypted_name: encName, name_hash: hash }));
    } else {
      await firstValueFrom(this.driveService.updateFile(file.id, { encrypted_name: encName, name_hash: hash }));
    }
    await this.loadTree();
  }

  async moveItem(file: DriveFile, targetFolderId: number | null): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Drive trancado');

    if (file.isFolder) {
      if (file.id === targetFolderId) throw new Error('Não é possível mover uma pasta para dentro de si mesma');
      await firstValueFrom(this.driveService.updateFolder(file.id, { parent_id: targetFolderId }));
    } else {
      await firstValueFrom(this.driveService.updateFile(file.id, { folder_id: targetFolderId }));
    }
    await this.loadTree();
  }

  async trashItem(file: DriveFile): Promise<void> {
    if (file.isFolder) {
      await firstValueFrom(this.driveService.trashFolder(file.id));
    } else {
      await firstValueFrom(this.driveService.trashFile(file.id));
    }
    await this.loadTree();
    await this.loadQuota();
  }

  async loadTrash(): Promise<void> {
    this.isLoading.set(true);
    try {
      const res = await firstValueFrom(this.driveService.getTrash());
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
          owner: 'eu',
          parentId: (folder.parent_id !== undefined && folder.parent_id !== null) ? folder.parent_id : null
        });
      }

      for (const file of res.files) {
        let decName = null;
        if (this.cryptoService.isVaultUnlocked()) {
          decName = await this.cryptoService.decryptName(file.encrypted_name);
        }
        let type = 'unknown';
        if (decName) {
           const lower = decName.toLowerCase();
           if (lower.endsWith('.pdf')) type = 'pdf';
           else if (lower.match(/\.(jpg|jpeg|png|gif|webp)$/i)) type = 'image';
           else if (lower.match(/\.(doc|docx)$/i)) type = 'doc';
           else if (lower.match(/\.(xls|xlsx)$/i)) type = 'spreadsheet';
           else if (lower.match(/\.(mp4|webm|mkv|avi|mov)$/i)) type = 'video';
           else if (lower.match(/\.(mp3|wav|ogg|aac|flac)$/i)) type = 'audio';
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
          folderId: (file.folder_id !== undefined && file.folder_id !== null) ? file.folder_id : null
        });
      }

      this.trashFiles.set(parsedFiles);
    } catch (e) {
      console.error('Failed to load trash', e);
    } finally {
      this.isLoading.set(false);
    }
  }

  async restoreItem(file: DriveFile): Promise<void> {
    if (file.isFolder) {
      await firstValueFrom(this.driveService.restoreFolder(file.id));
    } else {
      await firstValueFrom(this.driveService.restoreFile(file.id));
    }
    await this.loadTrash();
    await this.loadTree();
    await this.loadQuota();
  }

  async permanentDeleteItem(file: DriveFile): Promise<void> {
    if (file.isFolder) {
      await firstValueFrom(this.driveService.hardDeleteFolder(file.id));
    } else {
      await firstValueFrom(this.driveService.hardDeleteFile(file.id));
    }
    await this.loadTrash();
    await this.loadQuota();
  }

  async emptyTrash(): Promise<void> {
    await firstValueFrom(this.driveService.emptyTrash());
    await this.loadTrash();
    await this.loadQuota();
  }
}
