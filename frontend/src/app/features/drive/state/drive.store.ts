import { Injectable, signal, computed, inject, untracked } from '@angular/core';
import { DriveService } from '../services/drive.service';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { firstValueFrom } from 'rxjs';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { HttpClient, HttpEventType } from '@angular/common/http';

export interface TransferItem {
  id: string;
  fileName: string;
  type: 'upload' | 'download';
  status: 'pending' | 'processing' | 'success' | 'error';
  progress: number;
  errorMsg?: string;
  timestamp: Date;
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
}

@Injectable({ providedIn: 'root' })
export class DriveStore {
  private readonly driveService = inject(DriveService);
  private readonly cryptoService = inject(CryptoService);
  private readonly http = inject(HttpClient);

  readonly files = signal<DriveFile[]>([]);
  readonly quota = signal<QuotaState>({ usedBytes: 0, maxBytes: 10 * 1024 * 1024 * 1024 });
  readonly isLoading = signal(false);
  
  readonly isUploading = signal(false);
  readonly uploadProgress = signal(0);
  private readonly kasumi = inject(KasumiCryptoService);

  readonly storageProvider = signal<'local' | 'google_drive'>((localStorage.getItem('preferred_storage_provider') as 'local' | 'google_drive') || 'local');
  readonly linkedAccounts = signal<any[]>([]);
  readonly trashFiles = signal<DriveFile[]>([]);
  readonly transfers = signal<TransferItem[]>([]);

  readonly currentFolderId = signal<number | null>(null);

  readonly currentTrashFolderFiles = computed(() => {
    const currentId = this.currentFolderId();
    const trash = this.trashFiles();

    // If currentId is null (the root of the trash):
    // we only want to show files/folders that either have parentId/folderId as null,
    // OR whose parent folder is NOT in the trash (meaning they are explicitly deleted).
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

    // If currentId is NOT null (inside a deleted folder in the trash):
    // we show items that are inside this folder
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
      // Backend returns { accounts: [...] }, extract the array
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

  /** Clears all decrypted names in the files list when the vault is locked. */
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

  async createFolder(name: string, parentId: number | null = this.currentFolderId()): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Cofre trancado');
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

  async uploadFile(file: File, folderId: number | null = this.currentFolderId()): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Cofre trancado');
    this.isUploading.set(true);
    this.uploadProgress.set(0);

    try {
      await this._doUpload(file, folderId);
    } catch (e: any) {
      // 409 = file with same name already exists → ask user to overwrite
      if (e?.status === 409) {
        const confirmed = window.confirm(
          `Já existe um arquivo chamado "${file.name}" nesta pasta.\n\nDeseja substituir o arquivo existente?`
        );
        if (!confirmed) {
          return;
        }
        // Find the existing file and permanently delete it, then retry
        const existing = this.files().find(f =>
          !f.isFolder && (f.folderId === folderId) && (f.decryptedName === file.name)
        );
        if (existing) {
          await firstValueFrom(this.driveService.trashFile(existing.id));
          await firstValueFrom(this.driveService.hardDeleteFile(existing.id));
        }
        // Retry upload
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
      
      // Generate 32-byte FDK
      const fdk = new Uint8Array(32);
      crypto.getRandomValues(fdk);

      // Encrypt FDK (encode to base64, then encrypt as string)
      const fdkBase64 = btoa(String.fromCharCode(...fdk));
      const encryptedFdk = await this.cryptoService.encryptName(fdkBase64);

      // Encrypt file into Kasumi blob first to get the exact encrypted size
      const encryptedBlob = await this.kasumi.encryptFile(file, fdk);
      
      // Upload chunks (4MB each max)
      const CHUNK_SIZE = 4 * 1024 * 1024;
      const totalChunks = Math.ceil(encryptedBlob.size / CHUNK_SIZE);

      const activeProvider = this.storageProvider();

      // Init upload with the ENCRYPTED size, total chunks, and active provider
      const initRes = await firstValueFrom(this.driveService.initFileUpload(
        folderId, encName, hash, encryptedFdk, encryptedBlob.size, totalChunks, activeProvider
      ));
      const fileId = initRes.file_id;

      if (activeProvider === 'google_drive') {
        // Upload via Google Drive using access token
        const metadata = {
          name: hash,
          parents: [initRes.root_folder_id]
        };

        const boundary = '-------314159265358979323846';
        const delimiter = `\r\n--${boundary}\r\n`;
        const closeDelim = `\r\n--${boundary}--`;

        const metadataPart = JSON.stringify(metadata);
        
        // Convert to ArrayBuffer
        const arrayBuffer = await encryptedBlob.arrayBuffer();
        
        // Build multipart/related body
        const chunks: any[] = [];
        chunks.push(new TextEncoder().encode(delimiter + 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + metadataPart + delimiter + 'Content-Type: application/octet-stream\r\n\r\n'));
        chunks.push(new Uint8Array(arrayBuffer));
        chunks.push(new TextEncoder().encode(closeDelim));

        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const bodyUint8 = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          bodyUint8.set(chunk, offset);
          offset += chunk.length;
        }

        const uploadRes = await new Promise<any>((resolve, reject) => {
          this.http.post<any>(
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
                this.updateTransfer(transferId, { progress: percent });
              } else if (event.type === HttpEventType.Response) {
                resolve(event.body);
              }
            },
            error: (err) => reject(err)
          });
        });

        if (!uploadRes || !uploadRes.id) {
          throw new Error('Google Drive upload failed: ID missing from response');
        }

        // Finalize upload on backend
        await firstValueFrom(this.driveService.finalizeExternalUpload(fileId, uploadRes.id));
      } else {
        // Local upload
        for (let i = 0; i < totalChunks; i++) {
          const start = i * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, encryptedBlob.size);
          const chunk = encryptedBlob.slice(start, end);
          
          await firstValueFrom(this.driveService.uploadChunk(fileId, i, chunk));
          
          // Update progress
          const percent = Math.round(((i + 1) / totalChunks) * 100);
          this.uploadProgress.set(percent);
          this.updateTransfer(transferId, { progress: percent });
        }
      }

      this.updateTransfer(transferId, { status: 'success', progress: 100 });
      await this.loadTree();
      await this.loadQuota();
    } catch (e: any) {
      this.updateTransfer(transferId, { status: 'error', errorMsg: e?.message || 'Falha no upload' });
      throw e;
    }
  }

  async downloadFile(file: DriveFile): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Cofre trancado');
    if (file.isFolder || !file.encryptedFdk) return;

    const transferId = 'dl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    this.addTransfer({
      id: transferId,
      fileName: file.decryptedName || file.encryptedName,
      type: 'download',
      status: 'processing',
      progress: 0
    });

    try {
      let encryptedBlob: Blob;

      this.updateTransfer(transferId, { progress: 20 });
      if (file.storageProvider === 'google_drive') {
        const meta = await firstValueFrom(this.driveService.downloadExternalMetadata(file.id));
        this.updateTransfer(transferId, { progress: 40 });
        encryptedBlob = await firstValueFrom(this.driveService.downloadExternalFile(
          `https://www.googleapis.com/drive/v3/files/${meta.external_file_id}?alt=media`,
          meta.access_token
        ));
      } else {
        encryptedBlob = await firstValueFrom(this.driveService.downloadFile(file.id));
      }

      this.updateTransfer(transferId, { progress: 70 });
      // Decrypt FDK string using Vault Key
      const fdkBase64 = await this.cryptoService.decryptName(file.encryptedFdk);
      
      // Decode base64 to Uint8Array
      const fdkString = atob(fdkBase64);
      const fdk = new Uint8Array(fdkString.length);
      for (let i = 0; i < fdkString.length; i++) {
        fdk[i] = fdkString.charCodeAt(i);
      }

      this.updateTransfer(transferId, { progress: 85 });
      // Decrypt the blob using Kasumi XChaCha20
      const decryptedBlob = await this.kasumi.decryptFile(encryptedBlob, fdk);

      this.updateTransfer(transferId, { progress: 95 });
      // Create object URL and trigger download
      const url = URL.createObjectURL(decryptedBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.decryptedName || 'arquivo_desconhecido';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.updateTransfer(transferId, { status: 'success', progress: 100 });
    } catch (e: any) {
      console.error('Falha no download', e);
      this.updateTransfer(transferId, { status: 'error', errorMsg: e?.message || 'Falha no download' });
      throw e;
    }
  }

  async renameItem(file: DriveFile, newName: string): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Cofre trancado');
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
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Cofre trancado');

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
