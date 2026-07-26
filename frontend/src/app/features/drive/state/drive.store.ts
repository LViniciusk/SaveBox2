import { Injectable, signal, computed, inject, untracked, effect } from '@angular/core';
import { DriveService } from '../services/drive.service';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { firstValueFrom, Subscription } from 'rxjs';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { HttpClient } from '@angular/common/http';
import { DialogService } from '../../../core/dialog/dialog.service';
import { VideoTranscoderService } from '../services/video-transcoder.service';
import { environment } from '../../../../environments/environment';
import { AppStateService, AppStatus } from '../../../core/state/app-state.service';
import { UploadEngineService } from '../upload/upload-engine.service';
import { UploadBatchCoordinatorService } from '../upload/upload-batch-coordinator.service';
import { PreparedUpload, UploadBatchCandidate, UploadBatchSummary, UploadProvider } from '../upload/upload.models';
import { FolderUploadCoordinatorService } from '../upload/folder-upload-coordinator.service';
import { FolderUploadSourceFile } from '../upload/upload.models';

export interface TransferItem {
  id: string;
  fileName: string;
  type: 'upload' | 'download';
  status: 'pending' | 'processing' | 'paused' | 'success' | 'error';
  statusMessage?: string;
  progress: number;
  errorMsg?: string;
  timestamp: Date;
  speed?: string;
  eta?: string;
  speedBytesPerSecond?: number;
  groupId?: string;
  isRecovery?: boolean;
  pendingData?: any;
  bytesTransferred?: number;
  totalBytes?: number;
  history?: { bytes: number, time: number }[];
}

export type TransferGroupSource = 'multiple-files' | 'folder-upload' | 'drop-files' | 'drop-folders' | 'mixed-drop';
export type TransferGroupStatus = 'queued' | 'active' | 'paused' | 'success' | 'error' | 'partial' | 'cancelled';

export interface TransferGroup {
  id: string;
  source: TransferGroupSource;
  transferIds: readonly string[];
  createdAt: number;
  cancelledTransferIds: readonly string[];
  cancelledBytes: Readonly<Record<string, { totalBytes: number; transferredBytes: number }>>;
}

export interface TransferGroupViewModel {
  id: string;
  source: TransferGroupSource;
  transferIds: readonly string[];
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  cancelledFiles: number;
  pausedFiles: number;
  activeFiles: number;
  totalBytes: number;
  transferredBytes: number;
  progress: number;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
  status: TransferGroupStatus;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  canClear: boolean;
}
export interface PendingUpload {
  id: number;
  folder_id: number | null;
  encrypted_name: string;
  size_bytes: number;
  total_chunks: number;
  encrypted_fdk: string;
  uploaded_chunks_count: number;
  storage_provider: 'local' | 'google_drive';
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
  proxyExternalFileId?: string;
  proxySizeBytes?: number;
  proxyEncryptedFdk?: string;
  isHidden?: boolean;
  forceOriginal?: boolean;
  shareUuid?: string;
  shareFdk?: Uint8Array;
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
  private readonly videoTranscoder = inject(VideoTranscoderService);
  private readonly appState = inject(AppStateService);
  private readonly uploadEngine = inject(UploadEngineService);
  private readonly uploadBatchCoordinator = inject(UploadBatchCoordinatorService);
  private readonly folderUploadCoordinator = inject(FolderUploadCoordinatorService);

  constructor() {
    effect(() => {
      if (this.appState.status() === AppStatus.Locked) {
        untracked(() => {
          this.thumbnails.set({});
        });
      }
    });
  }

  readonly files = signal<DriveFile[]>([]);
  readonly quota = signal<QuotaState>({ usedBytes: 0, maxBytes: 10 * 1024 * 1024 * 1024 });
  readonly isLoading = signal(false);
  
  readonly visibleFiles = computed(() => {
    return this.files().filter(f => !f.isHidden);
  });

  readonly isUploading = computed(() => {
    return this.transfers().some(t => t.type === 'upload' && t.status === 'processing');
  });

  readonly uploadProgress = computed(() => {
    const active = this.transfers().slice().reverse().find(t => t.type === 'upload' && t.status === 'processing');
    return active ? active.progress : 0;
  });
  
  readonly uploadStatusMessage = computed(() => {
    const active = this.transfers().slice().reverse().find(t => t.type === 'upload' && (t.status === 'processing' || t.status === 'success'));
    if (active) {
      if (active.status === 'success') return 'Concluído!';
      return active.statusMessage || active.fileName;
    }
    return 'Fazendo upload...';
  });

  readonly isDownloading = computed(() => {
    return this.transfers().some(t => t.type === 'download' && t.status === 'processing');
  });

  readonly downloadProgress = computed(() => {
    const active = this.transfers().slice().reverse().find(t => t.type === 'download' && t.status === 'processing');
    return active ? active.progress : 0;
  });
  private readonly kasumi = inject(KasumiCryptoService);

  readonly storageProvider = signal<'local' | 'google_drive'>((localStorage.getItem('preferred_storage_provider') as 'local' | 'google_drive') || 'local');
  readonly convertIncompatibleVideos = signal<boolean>(localStorage.getItem('preferred_convert_incompatible') !== 'false');
  readonly incompatibleVideoConversionMode = signal<'pure' | 'compressed'>((localStorage.getItem('preferred_incompatible_mode') as 'pure' | 'compressed') || 'pure');

  readonly selectedFileIds = signal<Set<number>>(new Set());

  readonly displayMode = signal<'list' | 'grid'>((localStorage.getItem('preferred_display_mode') as 'list' | 'grid') || 'list');
  readonly linkedAccounts = signal<any[]>([]);
  readonly trashFiles = signal<DriveFile[]>([]);
  readonly transfers = signal<TransferItem[]>([]);
  readonly transferGroups = signal<TransferGroup[]>([]);
  readonly transferGroupViews = computed(() => this.transferGroups().map(group => this.toTransferGroupView(group)));
  readonly thumbnails = signal<Record<number, string>>({});

  readonly currentFolderId = signal<number | null>(null);
  private readonly backHistory = signal<Array<number | null>>([]);
  private readonly forwardHistory = signal<Array<number | null>>([]);
  readonly canGoBack = computed(() => this.backHistory().length > 0);
  readonly canGoForward = computed(() => this.forwardHistory().length > 0);
  readonly canGoUp = computed(() => this.currentFolderId() !== null);

  // States to persist active/paused uploads and downloads in RAM
  private activeUploads = new Map<string, {
    transferId: string;
    file: File;
    fileId: number;
    prepared: PreparedUpload;
    folderId: number | null;
    provider: UploadProvider;
    initRes?: any;
    isHiddenProxy: boolean;
  }>();

  private activeDownloads = new Map<string, {
    file: DriveFile;
    isGoogleDrive?: boolean;
    meta?: any;
    fdk?: Uint8Array;
    baseNonce?: Uint8Array;
    expectedSize?: number;
    decryptedBytes?: number;
    currentOffset?: number;
    chunkIndex?: number;
    plaintextChunks?: Blob[];
  }>();

  private pausedTransfers = new Set<string>();
  private cancelledTransfers = new Set<string>();

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
      if (f.isHidden) return false;
      if (f.isFolder) {
        return f.parentId === currentId;
      } else {
        return f.folderId === currentId;
      }
    });
  });

  readonly currentFolderFiles = computed(() => {
    const currentId = this.currentFolderId();
    return this.visibleFiles().filter(f => {
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
        name: folder.decryptedName || (this.appState.isLocked() ? 'Pasta protegida' : 'Pasta indisponível')
      });
      currentId = folder.parentId ?? null;
    }
    
    return [...path, ...ancestors.reverse()];
  });

  navigateTo(folderId: number | null): void {
    const currentId = this.currentFolderId();
    if (currentId === folderId) return;
    this.backHistory.update(history => [...history, currentId]);
    this.forwardHistory.set([]);
    this.setCurrentFolder(folderId);
  }

  goBack(): void {
    const history = this.backHistory();
    const target = history.at(-1);
    if (target === undefined) return;
    this.backHistory.set(history.slice(0, -1));
    this.forwardHistory.update(items => [...items, this.currentFolderId()]);
    this.setCurrentFolder(target);
  }

  goForward(): void {
    const history = this.forwardHistory();
    const target = history.at(-1);
    if (target === undefined) return;
    this.forwardHistory.set(history.slice(0, -1));
    this.backHistory.update(items => [...items, this.currentFolderId()]);
    this.setCurrentFolder(target);
  }

  private setCurrentFolder(folderId: number | null): void {
    this.currentFolderId.set(folderId);
    this.selectedFileIds.set(new Set());
  }

  navigateUp(): void {
    const currentId = this.currentFolderId();
    if (currentId === null) return;
    const currentFolder = this.files().find(f => f.isFolder && f.id === currentId);
    const target = currentFolder?.parentId ?? null;
    if (target === currentId) return;
    this.backHistory.update(history => [...history, currentId]);
    this.forwardHistory.set([]);
    this.currentFolderId.set(target);
  }

  setStorageProvider(provider: 'local' | 'google_drive'): void {
    this.storageProvider.set(provider);
    localStorage.setItem('preferred_storage_provider', provider);
  }

  setConvertIncompatibleVideos(value: boolean): void {
    this.convertIncompatibleVideos.set(value);
    localStorage.setItem('preferred_convert_incompatible', value ? 'true' : 'false');
  }

  setIncompatibleVideoConversionMode(mode: 'pure' | 'compressed'): void {
    this.incompatibleVideoConversionMode.set(mode);
    localStorage.setItem('preferred_incompatible_mode', mode);
  }

  setDisplayMode(mode: 'list' | 'grid'): void {
    this.displayMode.set(mode);
    localStorage.setItem('preferred_display_mode', mode);
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
      const pageSize = 100;
      let page = await firstValueFrom(this.driveService.getTree(pageSize, 0));
      const folders = page.folders;
      const files = [...page.files];
      let offset = files.length;

      while (page.files.length === pageSize) {
        page = await firstValueFrom(this.driveService.getTree(pageSize, offset));
        files.push(...page.files);
        offset += page.files.length;
      }

      const parsedFiles: DriveFile[] = [];
      
      for (const folder of folders) {
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

      for (const file of files) {
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
          folderId: (file.folder_id !== undefined && file.folder_id !== null) ? file.folder_id : null,
          isHidden: !!(file as any).is_hidden
        });
      }

      this.files.set(parsedFiles);
      await this.loadPendingUploads();
    } catch (e) {
      console.error('Failed to load tree', e);
    } finally {
      this.isLoading.set(false);
    }
  }

  async loadPendingUploads(): Promise<void> {
    try {
      const res = await firstValueFrom(this.driveService.getPendingUploads());
      if (res.pending_uploads && res.pending_uploads.length > 0) {
        // Remove existing recovery items to avoid duplicates
        this.transfers.update(list => list.filter(t => !t.isRecovery));
        
        for (const pending of res.pending_uploads) {
          const id = `pending_${pending.id}`;
          const decryptedName = await this.cryptoService.decryptName(pending.encrypted_name);
          const percent = pending.total_chunks > 0 ? Math.round((pending.uploaded_chunks_count / pending.total_chunks) * 100) : 0;
          
          this.addTransfer({
            id,
            fileName: decryptedName || 'Arquivo Desconhecido',
            type: 'upload',
            status: 'paused',
            statusMessage: 'Aguardando arquivo original...',
            progress: percent,
            isRecovery: true,
            pendingData: pending
          });
        }
      }
    } catch (e) {
      console.error('Failed to load pending uploads', e);
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

    const currentTransfers = untracked(() => this.transfers());
    for (const t of currentTransfers) {
      if (t.isRecovery && t.pendingData?.encrypted_name) {
        const decName = await this.cryptoService.decryptName(t.pendingData.encrypted_name);
        if (decName) {
          this.updateTransfer(t.id, { fileName: decName });
        }
      }
    }
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
    const groupedIds = new Set(this.transferGroups().flatMap(group => group.transferIds));
    this.transfers.update(list => list.filter(item =>
      groupedIds.has(item.id) || (item.status !== 'success' && item.status !== 'error'))
    );
  }

  private newTransferId(prefix: 'up' | 'dl' = 'up'): string {
    return `${prefix}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  }

  private createTransferGroup(source: TransferGroupSource, transferIds: readonly string[]): string {
    const id = crypto.randomUUID();
    this.transferGroups.update(groups => [...groups, {
      id,
      source,
      transferIds: [...transferIds],
      createdAt: Date.now(),
      cancelledTransferIds: [],
      cancelledBytes: {},
    }]);
    return id;
  }

  private recordCancelledTransfer(transfer: TransferItem): void {
    if (!transfer.groupId) return;
    this.transferGroups.update(groups => groups.map(group => {
      if (group.id !== transfer.groupId || group.cancelledTransferIds.includes(transfer.id)) return group;
      return {
        ...group,
        cancelledTransferIds: [...group.cancelledTransferIds, transfer.id],
        cancelledBytes: {
          ...group.cancelledBytes,
          [transfer.id]: {
            totalBytes: transfer.totalBytes ?? 0,
            transferredBytes: transfer.bytesTransferred ?? 0,
          },
        },
      };
    }));
  }

  private toTransferGroupView(group: TransferGroup): TransferGroupViewModel {
    const byId = new Map(this.transfers().map(item => [item.id, item]));
    const cancelled = new Set(group.cancelledTransferIds);
    const members = group.transferIds.map(id => byId.get(id)).filter((item): item is TransferItem => !!item);
    const completedFiles = members.filter(item => item.status === 'success').length;
    const failedFiles = members.filter(item => item.status === 'error').length;
    const pausedFiles = members.filter(item => item.status === 'paused').length;
    const activeFiles = members.filter(item => item.status === 'processing' || item.status === 'pending').length;
    const cancelledFiles = cancelled.size;
    const terminalFiles = completedFiles + failedFiles + cancelledFiles;
    const totalBytes = members.reduce((sum, item) => sum + (item.totalBytes ?? 0), 0) +
      [...cancelled].reduce((sum, id) => sum + (group.cancelledBytes[id]?.totalBytes ?? 0), 0);
    const transferredBytes = members.reduce((sum, item) => {
      const total = item.totalBytes ?? 0;
      return sum + (total > 0 ? Math.min(Math.max(item.bytesTransferred ?? 0, 0), total) : 0);
    }, 0) + [...cancelled].reduce((sum, id) => {
      const bytes = group.cancelledBytes[id];
      return sum + (bytes?.totalBytes ? Math.min(Math.max(bytes.transferredBytes, 0), bytes.totalBytes) : 0);
    }, 0);
    const speedBytesPerSecond = members
      .filter(item => item.status === 'processing')
      .reduce((sum, item) => sum + Math.max(item.speedBytesPerSecond ?? 0, 0), 0);
    const allTerminal = terminalFiles >= group.transferIds.length;
    let status: TransferGroupStatus = 'queued';
    if (completedFiles === group.transferIds.length) status = 'success';
    else if (cancelledFiles === group.transferIds.length) status = 'cancelled';
    else if (allTerminal) {
      status = completedFiles > 0 || failedFiles > 0 ? (completedFiles > 0 && (failedFiles > 0 || cancelledFiles > 0) ? 'partial' : failedFiles > 0 ? 'error' : 'partial') : 'cancelled';
    } else if (activeFiles > 0) status = 'active';
    else if (pausedFiles + cancelledFiles === group.transferIds.length) status = 'paused';

    const progress = totalBytes > 0
      ? Math.min(Math.max(transferredBytes / totalBytes, 0), 1)
      : status === 'success' ? 1 : 0;
    const remainingBytes = Math.max(totalBytes - transferredBytes, 0);
    return {
      id: group.id,
      source: group.source,
      transferIds: group.transferIds,
      totalFiles: group.transferIds.length,
      completedFiles,
      failedFiles,
      cancelledFiles,
      pausedFiles,
      activeFiles,
      totalBytes,
      transferredBytes,
      progress,
      speedBytesPerSecond,
      etaSeconds: speedBytesPerSecond > 0 ? Math.ceil(remainingBytes / speedBytesPerSecond) : null,
      status,
      canPause: activeFiles > 0,
      canResume: pausedFiles > 0 && activeFiles === 0,
      canCancel: !allTerminal,
      canClear: allTerminal,
    };
  }

  pauseTransferGroup(id: string): void {
    const group = this.transferGroups().find(item => item.id === id);
    if (!group) return;
    for (const transferId of group.transferIds) {
      const transfer = this.transfers().find(item => item.id === transferId);
      if (transfer?.status === 'processing' || transfer?.status === 'pending') this.pauseTransfer(transferId);
    }
  }

  async resumeTransferGroup(id: string): Promise<void> {
    const group = this.transferGroups().find(item => item.id === id);
    if (!group) return;
    for (const transferId of group.transferIds) {
      const transfer = this.transfers().find(item => item.id === transferId);
      if (transfer?.status !== 'paused') continue;
      if (transfer.type === 'upload') await this.resumeUpload(transferId);
      else await this.resumeDownload(transferId);
    }
  }

  async cancelTransferGroup(id: string): Promise<void> {
    const group = this.transferGroups().find(item => item.id === id);
    if (!group) return;
    for (const transferId of group.transferIds) {
      const transfer = this.transfers().find(item => item.id === transferId);
      if (transfer && transfer.status !== 'success' && transfer.status !== 'error') await this.cancelTransfer(transferId);
    }
  }

  clearTransferGroup(id: string): void {
    const view = this.transferGroupViews().find(group => group.id === id);
    if (!view?.canClear) return;
    const group = this.transferGroups().find(item => item.id === id);
    if (!group) return;
    const ids = new Set(group.transferIds);
    this.transfers.update(list => list.filter(item => !ids.has(item.id)));
    this.transferGroups.update(groups => groups.filter(item => item.id !== id));
  }

  updateTransferProgress(id: string, progress: number, bytesTransferred: number, totalBytes: number) {
    const now = Date.now();
    let history = this.transfers().find(t => t.id === id)?.history || [];
    
    history.push({ bytes: bytesTransferred, time: now });
    history = history.filter(p => now - p.time <= 2000);

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
      speedBytesPerSecond: history.length >= 2 ? Math.max(0, (history.at(-1)!.bytes - history[0].bytes) / Math.max((history.at(-1)!.time - history[0].time) / 1000, 0.001)) : 0,
      bytesTransferred,
      totalBytes,
      history
    });
  }

  async uploadFile(file: File, folderId: number | null = this.currentFolderId(), refresh = true, groupId?: string, transferId?: string): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Drive trancado');

    try {
      await this._doUpload(file, folderId, refresh, groupId, transferId);
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
        await this._doUpload(file, folderId, refresh, groupId, transferId);
      } else {
        console.error('Falha no upload', e);
        throw e;
      }
    } finally {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  async uploadFiles(
    files: readonly File[],
    folderId: number | null = this.currentFolderId(),
    source: TransferGroupSource = 'multiple-files'
  ): Promise<void> {
    if (files.length === 0) return;
    if (files.length === 1) {
      await this.uploadFile(files[0], folderId);
      return;
    }
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Drive trancado');

    const transferIds = files.map(() => this.newTransferId());
    const transferIdByFile = new Map(files.map((file, index) => [file, transferIds[index]]));
    const groupId = files.length >= 2 ? this.createTransferGroup(source, transferIds) : undefined;

    const individualVideoFiles = environment.logs.ffmpeg === undefined ? [] : files.filter(file =>
      this.videoTranscoder.isVideo(file) && !this.videoTranscoder.isFormatNativelySupported(file)
    );
    const batchFiles = files.filter(file => !individualVideoFiles.includes(file));
    if (individualVideoFiles.length > 0) {
      await Promise.all(individualVideoFiles.map(file => this.uploadFile(file, folderId, true, groupId, transferIdByFile.get(file))));
    }
    if (batchFiles.length === 0) return;
    if (batchFiles.length === 1) {
      await this.uploadFile(batchFiles[0], folderId, true, groupId, transferIdByFile.get(batchFiles[0]));
      return;
    }

    await this.uploadBatchFiles(batchFiles.map(file => ({ file, folderId, groupId, transferId: transferIdByFile.get(file) })));
  }

  async uploadFolder(
    files: readonly File[],
    rootParentId: number | null = this.currentFolderId(),
    source: TransferGroupSource = 'folder-upload'
  ): Promise<void> {
    if (!files.length) return;
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Drive trancado');

    const mapped = await this.folderUploadCoordinator.prepare(files, rootParentId);
    await this.uploadFolderCandidates(mapped, source);
  }

  async uploadFolderSources(
    sources: readonly FolderUploadSourceFile[],
    rootParentId: number | null = this.currentFolderId(),
    source: TransferGroupSource = 'drop-folders'
  ): Promise<void> {
    if (!sources.length) return;
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Drive trancado');
    const mapped = await this.folderUploadCoordinator.prepareSources(sources, rootParentId);
    await this.uploadFolderCandidates(mapped, source);
  }

  private async uploadFolderCandidates(mapped: readonly { file: File; folderId: number | null }[], source: TransferGroupSource): Promise<void> {
    const individualVideoFiles = environment.logs.ffmpeg === undefined ? [] : mapped.filter(item =>
      this.videoTranscoder.isVideo(item.file) && !this.videoTranscoder.isFormatNativelySupported(item.file)
    );
    const batchFiles = mapped.filter(item => !individualVideoFiles.includes(item));
    const transferIds = mapped.map(() => this.newTransferId());
    const groupId = mapped.length >= 2 ? this.createTransferGroup(source, transferIds) : undefined;
    const transferIdByFile = new Map(mapped.map((item, index) => [item.file, transferIds[index]]));
    try {
      await Promise.all(individualVideoFiles.map(item => this.uploadFile(item.file, item.folderId, false, groupId, transferIdByFile.get(item.file))));
      if (batchFiles.length > 0) await this.uploadBatchFiles(batchFiles.map(item => ({ ...item, groupId, transferId: transferIdByFile.get(item.file) })), false);
    } finally {
      await this.loadTree();
      await this.loadQuota();
    }
  }

  private async uploadBatchFiles(
    items: readonly { file: File; folderId: number | null; groupId?: string; transferId?: string }[],
    refresh = true
  ): Promise<UploadBatchSummary> {
    const candidates: UploadBatchCandidate[] = items.map(item => {
      const { file, folderId } = item;
      const transferId = item.transferId ?? this.newTransferId();
      this.cancelledTransfers.delete(transferId);
      this.addTransfer({
        id: transferId,
        fileName: file.name,
        type: 'upload',
        status: 'processing',
        statusMessage: 'Preparando...',
        progress: 0,
        groupId: item.groupId,
      });
      return {
        file,
        folderId,
        transferId,
        provider: this.storageProvider(),
        control: {
          shouldPause: () => this.pausedTransfers.has(transferId),
          shouldCancel: () => this.cancelledTransfers.has(transferId),
        }
      };
    });

    const summary = await this.uploadBatchCoordinator.upload(candidates, {
      onInitialized: (candidate, prepared, response) => {
        this.activeUploads.set(candidate.transferId + '_batch', {
          transferId: candidate.transferId,
          file: candidate.file,
          fileId: response.file_id,
          prepared,
          folderId: candidate.folderId,
          provider: response.storage_provider,
          initRes: response,
          isHiddenProxy: false
        });
      },
      onProgress: (candidate, progress, transferredBytes, totalBytes) =>
        this.updateTransferProgress(candidate.transferId, progress, transferredBytes, totalBytes),
      onResult: result => {
        if (result.status === 'success') {
          this.activeUploads.delete(result.transferId + '_batch');
          this.updateTransfer(result.transferId, { status: 'success', progress: 100, statusMessage: 'Concluído!' });
        } else if (result.status === 'paused') {
          this.updateTransfer(result.transferId, { status: 'paused' });
        } else {
          const error = result.error as { message?: string } | undefined;
          this.updateTransfer(result.transferId, { status: 'error', errorMsg: error?.message || 'Falha no upload' });
        }
      }
    });

    if (refresh && summary.succeeded > 0) {
      await this.loadTree();
      await this.loadQuota();
    }
    return summary;
  }

  private async _doUpload(
    originalFile: File,
    folderId: number | null = null,
    refresh = true,
    groupId?: string,
    transferId?: string
  ): Promise<void> {
    const isVideo = this.videoTranscoder.isVideo(originalFile);
    
    const filesToUpload: { file: File, isHiddenProxy: boolean }[] = [];
    const activeTransferId = transferId ?? this.newTransferId();
    if (this.transfers().some(item => item.id === activeTransferId)) {
      this.updateTransfer(activeTransferId, {
        fileName: originalFile.name,
        status: 'processing',
        statusMessage: 'Preparando...',
        progress: 0,
        groupId,
      });
    } else {
      this.addTransfer({
        id: activeTransferId,
        fileName: originalFile.name,
        type: 'upload',
        status: 'processing',
        statusMessage: 'Preparando...',
        progress: 0,
        groupId,
      });
    }

    let fileToEncrypt = originalFile;

    if (isVideo && environment.logs.ffmpeg !== undefined) {
       const isSupported = this.videoTranscoder.isFormatNativelySupported(originalFile);
       if (!isSupported) {
          const conversionMode = 'pure';
          try {
            this.updateTransfer(activeTransferId, { statusMessage: 'Convertendo vídeo incompatível...' });
            const proxyFile = await this.videoTranscoder.transcodeToProxy(originalFile, conversionMode, (p: number, statusMessage: string) => {
              this.updateTransfer(activeTransferId, { statusMessage: statusMessage });
              this.updateTransferProgress(activeTransferId, Math.round(p * 100), 0, 100);
            });
            fileToEncrypt = new File([proxyFile], originalFile.name, { type: proxyFile.type });
          } catch (e: any) {
            console.error('Erro na transcodificação, enviando original', e);
            fileToEncrypt = originalFile;
          }
       }
    }

    filesToUpload.push({ file: fileToEncrypt, isHiddenProxy: false });

    for (const item of filesToUpload) {
      await this._uploadSingleFile(item.file, folderId, item.isHiddenProxy, activeTransferId, refresh);
    }
  }

  private async _uploadSingleFile(file: File, folderId: number | null, isHiddenProxy: boolean, transferId: string, refresh = true): Promise<void> {
    const uploadId = transferId + (isHiddenProxy ? '_proxy' : '_original');
    
    this.updateTransfer(transferId, {
      status: 'processing',
      statusMessage: isHiddenProxy ? 'Enviando versão otimizada...' : 'Enviando original...',
      progress: 0
    });

    try {
      const prepared = await this.uploadEngine.prepareUpload(file);
      const activeProvider = this.storageProvider();

      const initRes = await firstValueFrom(this.driveService.initFileUpload(
        folderId,
        prepared.encryptedName,
        prepared.nameHash,
        prepared.encryptedFdk,
        prepared.encryptedSize,
        prepared.totalChunks,
        activeProvider,
        undefined,
        undefined,
        undefined,
        isHiddenProxy
      ));
      const fileId = initRes.file_id;

      this.activeUploads.set(uploadId, {
        transferId,
        file,
        fileId,
        prepared,
        folderId,
        provider: activeProvider,
        initRes,
        isHiddenProxy
      });

      await this.runUploadLoop(uploadId, transferId, fileId, prepared, activeProvider, initRes, isHiddenProxy, refresh);
    } catch (e: any) {
      if (e?.message !== 'PAUSED') {
        this.updateTransfer(transferId, { status: 'error', errorMsg: e?.message || 'Falha no upload' });
        this.activeUploads.delete(uploadId);
      }
      throw e;
    }
  }

  private async runUploadLoop(
    uploadId: string,
    transferId: string,
    fileId: number,
    prepared: PreparedUpload,
    activeProvider: UploadProvider,
    initRes: any,
    isHiddenProxy: boolean,
    refresh = true
  ): Promise<void> {
    const result = await this.uploadEngine.execute(
      prepared,
      fileId,
      activeProvider,
      initRes,
      {
        shouldPause: () => this.pausedTransfers.has(transferId),
        shouldCancel: () => false,
      },
      {
        onProgress: ({ progress, transferredBytes, totalBytes }) =>
          this.updateTransferProgress(transferId, progress, transferredBytes, totalBytes),
      }
    );

    if (result.paused) {
      this.updateTransfer(transferId, { status: 'paused' });
      return;
    }
    
    // Deleta do activeUploads e apenas marca concluído na UI se não for um proxy escondido ou se for o único arquivo
    this.activeUploads.delete(uploadId);
    
    // Se isHiddenProxy é true, apenas removemos e não atualizamos a UI (o arquivo principal vai atualizar a UI quando acabar)
    // Contudo, se só havia o proxy (ex: erro no principal), a UI ficaria travada. Mas o fluxo atual não permite isso.
    if (!isHiddenProxy) {
      this.updateTransfer(transferId, { status: 'success', progress: 100, statusMessage: 'Concluído!' });
    }
    
    if (refresh) {
      await this.loadTree();
      await this.loadQuota();
    }
  }

  async downloadFile(file: DriveFile): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Drive trancado');
    if (file.isFolder || !file.encryptedFdk) return;

    const transferId = 'dl_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    this.addTransfer({
      id: transferId,
      fileName: file.decryptedName || file.encryptedName,
      type: 'download',
      status: 'processing',
      progress: 0
    });

    const setProgress = (prog: number, bytes: number, total: number) => {
      this.updateTransferProgress(transferId, prog, bytes, total);
    };

    try {
      setProgress(5, 0, file.sizeBytes);
      let fdk: Uint8Array;
      if (file.shareFdk) {
        fdk = file.shareFdk;
      } else {
        if (!file.encryptedFdk) throw new Error('FDK ausente nos metadados');
        const fdkBase64 = await this.cryptoService.decryptName(file.encryptedFdk);
        const fdkString = atob(fdkBase64);
        fdk = new Uint8Array(fdkString.length);
        for (let i = 0; i < fdkString.length; i++) {
          fdk[i] = fdkString.charCodeAt(i);
        }
      }

      setProgress(10, 0, file.sizeBytes);

      if (file.storageProvider === 'google_drive') {
        const meta = await firstValueFrom(this.driveService.downloadExternalMetadata(file.id));
        setProgress(30, 0, file.sizeBytes);
        
        const state = { file, isGoogleDrive: true, meta, fdk };
        this.activeDownloads.set(transferId, state);
        await this.runGoogleDriveDownload(transferId, state);
      } else {
        // Local file chunked download
        setProgress(15, 0, file.sizeBytes);
        const initialHeaderSize = 1024 * 128;
        const headerBlob = await firstValueFrom(this.driveService.downloadFileRange(file.id, 0, initialHeaderSize - 1));
        const { dataOffset, expectedSize } = await this.kasumi.extractMetadata(headerBlob, fdk);
        const baseNonce = new Uint8Array(await headerBlob.slice(0, 24).arrayBuffer());

        const plaintextChunks: Blob[] = [];
        const state = {
          file,
          fdk,
          baseNonce,
          expectedSize,
          plaintextChunks,
          decryptedBytes: 0,
          currentOffset: dataOffset,
          chunkIndex: 0
        };
        this.activeDownloads.set(transferId, state);

        await this.runDownloadLoop(transferId, state);
      }
    } catch (e: any) {
      if (e?.message !== 'PAUSED') {
        console.error('Falha no download', e);
        this.updateTransfer(transferId, { status: 'error', errorMsg: e?.message || 'Falha no download' });
        this.activeDownloads.delete(transferId);
      }
      throw e;
    }
  }

  private async runGoogleDriveDownload(transferId: string, state: any): Promise<void> {
    const { file, meta, fdk } = state;

    const setProgress = (prog: number, bytes: number, total: number) => {
      this.updateTransferProgress(transferId, prog, bytes, total);
    };

    let encryptedBlob;
    try {
      encryptedBlob = await firstValueFrom(
        this.driveService.downloadExternalFile(
          `https://www.googleapis.com/drive/v3/files/${meta.external_file_id}?alt=media`,
          meta.access_token
        )
      );
    } catch (e: any) {
      if (e.message === 'PAUSED') {
        return;
      }
      throw e;
    }

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

    this.updateTransfer(transferId, { status: 'success', progress: 100, statusMessage: 'Concluído!' });
    this.activeDownloads.delete(transferId);
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

    this.updateTransfer(transferId, { status: 'success', progress: 100, statusMessage: 'Concluído!' });
    this.activeDownloads.delete(transferId);
  }

  pauseTransfer(id: string) {
    this.pausedTransfers.add(id);
    this.updateTransfer(id, { status: 'paused', speed: 'Pausado', eta: '--:--' });

    // Abort active local downloads by marking as paused. Google Drive / monolithic downloads will just run to completion and drop.
  }

  async resumeUpload(id: string) {
    const uploadsToResume = [];
    for (const [uploadId, data] of this.activeUploads.entries()) {
      if (data.transferId === id) {
        uploadsToResume.push({ uploadId, data });
      }
    }

    if (uploadsToResume.length === 0) return;

    this.pausedTransfers.delete(id);
    this.updateTransfer(id, { status: 'processing', speed: 'Calculando...', eta: '--:--' });

    try {
      for (const { uploadId, data } of uploadsToResume) {
        if (this.pausedTransfers.has(id)) return; // Se pausou novamente entre uploads
        
        this.updateTransfer(id, {
          statusMessage: data.isHiddenProxy ? 'Retomando versão otimizada...' : 'Retomando original...'
        });
        
        const activeProvider = data.provider;
        const initRes = data.initRes || { access_token: '', root_folder_id: '' };
        await this.runUploadLoop(uploadId, id, data.fileId, data.prepared, activeProvider, initRes, data.isHiddenProxy);
      }
    } catch (e: any) {
      if (e?.message !== 'PAUSED') {
        this.updateTransfer(id, { status: 'error', errorMsg: e?.message || 'Falha no upload' });
      }
    }
  }

  async cancelTransfer(id: string) {
    this.cancelledTransfers.add(id);
    this.pauseTransfer(id);
    
    // Se for uma recuperação pendente, excluir o arquivo temporário/incompleto do servidor
    const transfer = this.transfers().find(t => t.id === id);
    if (transfer) this.recordCancelledTransfer(transfer);
    if (transfer && transfer.isRecovery && transfer.pendingData) {
      try {
        await firstValueFrom(this.driveService.trashFile(transfer.pendingData.id));
        await firstValueFrom(this.driveService.hardDeleteFile(transfer.pendingData.id));
      } catch (e) {
        console.error('Falha ao limpar arquivo pendente', e);
      }
    }
    
    this.transfers.update(list => list.filter(t => t.id !== id));
    for (const [uploadId, upload] of this.activeUploads) {
      if (upload.transferId === id || uploadId === id) this.activeUploads.delete(uploadId);
    }
    this.activeDownloads.delete(id);
    this.pausedTransfers.delete(id);
    this.cancelledTransfers.delete(id);
  }

  async recoverUpload(id: string, pendingData: PendingUpload, file: File) {
    // 1. Decriptar a chave FDK do arquivo
    const fdkBase64 = await this.cryptoService.decryptName(pendingData.encrypted_fdk);
    if (!fdkBase64) throw new Error('Não foi possível decifrar a chave do arquivo pendente.');
    const fdkChars = atob(fdkBase64);
    const fdk = new Uint8Array(fdkChars.length);
    for (let i = 0; i < fdkChars.length; i++) fdk[i] = fdkChars.charCodeAt(i);

    // 2. Tentar recuperar o baseNonce do servidor se o upload já tiver chunks
    let baseNonce: Uint8Array | undefined = undefined;
    if (pendingData.uploaded_chunks_count > 0) {
      this.updateTransfer(id, { statusMessage: 'Recuperando contexto de criptografia...' });
      try {
        const res = await firstValueFrom(this.http.get(`${environment.apiUrl}/files/${pendingData.id}/download`, {
          responseType: 'arraybuffer',
          headers: { 'Range': 'bytes=0-23' }
        }));
        if (res && res.byteLength === 24) {
          baseNonce = new Uint8Array(res);
        }
      } catch (e) {
        console.warn('Falha ao obter baseNonce do servidor. Gerando um novo.', e);
      }
    }

    // 3. Recriptografar o arquivo localmente com a mesma FDK e mesmo baseNonce
    this.updateTransfer(id, { status: 'processing', statusMessage: 'Recriptografando arquivo local...', speed: 'Calculando...', eta: '--:--' });
    const encryptedBlob = await this.kasumi.encryptFile(file, fdk, baseNonce);

    // 3. Checar se o tamanho gerado bate com o servidor
    // A tolerância de tamanho aqui não é estrita porque o proxy pode ter mudado, mas proxies são ocultos.
    // Para original, o tamanho criptografado é sempre o mesmo se o arquivo for o mesmo.
    const fileId = pendingData.id;
    const activeProvider = pendingData.storage_provider;
    const totalChunks = pendingData.total_chunks;
    
    // Preparar initRes dummy (necessário apenas para google_drive, mas google_drive recomeça do zero)
    const initRes = { access_token: '', root_folder_id: '' };

    this.pausedTransfers.delete(id);
    
    // Adicionar no activeUploads
    const uploadId = id + '_recovery';
    this.activeUploads.set(uploadId, {
      transferId: id,
      file,
      fileId,
      prepared: {
        file,
        encryptedBlob,
        encryptedName: pendingData.encrypted_name,
        nameHash: '',
        encryptedFdk: pendingData.encrypted_fdk,
        fdk,
        totalChunks,
        encryptedSize: encryptedBlob.size,
      },
      folderId: pendingData.folder_id,
      provider: activeProvider,
      initRes,
      isHiddenProxy: false
    });

    this.updateTransfer(id, { statusMessage: 'Retomando upload...' });

    // Retomar upload do original via chunking
    try {
      await this.runUploadLoop(uploadId, id, fileId, this.activeUploads.get(uploadId)!.prepared, activeProvider, initRes, false);
      
      // Quando concluir
      this.transfers.update(list => list.map(t => t.id === id ? { ...t, isRecovery: false } : t));
    } catch (e: any) {
      if (e?.message !== 'PAUSED') {
        this.updateTransfer(id, { status: 'error', errorMsg: e?.message || 'Falha na recuperação' });
      }
    }
  }

  async resumeDownload(id: string) {
    const state = this.activeDownloads.get(id);
    if (!state) return;

    this.pausedTransfers.delete(id);
    this.updateTransfer(id, { status: 'processing', speed: 'Calculando...', eta: '--:--' });

    try {
      if (state.isGoogleDrive) {
        await this.runGoogleDriveDownload(id, state);
      } else {
        await this.runDownloadLoop(id, state);
      }
    } catch (e: any) {
      if (e?.message !== 'PAUSED') {
        this.updateTransfer(id, { status: 'error', errorMsg: e?.message || 'Falha no download' });
      }
    } finally {
      // isDownloading will be updated automatically by computed
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
      
      // Se tiver proxy (dual mode), renomeia também
      const proxyName = file.decryptedName + '.proxy.mp4';
      const legacyProxyName = '__PROXY__' + file.decryptedName;
      const proxyFile = untracked(() => this.files()).find(f => (f.decryptedName === proxyName || f.decryptedName === legacyProxyName) && f.folderId === file.folderId);
      if (proxyFile) {
        const newProxyName = newName + '.proxy.mp4';
        const proxyEncName = await this.cryptoService.encryptName(newProxyName);
        const proxyHash = await this.cryptoService.hashName(newProxyName);
        await firstValueFrom(this.driveService.updateFile(proxyFile.id, { encrypted_name: proxyEncName, name_hash: proxyHash }));
      }
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
      
      // Se tiver proxy, manda pra lixeira tambem
      const proxyName = file.decryptedName + '.proxy.mp4';
      const legacyProxyName = '__PROXY__' + file.decryptedName;
      const proxyFile = untracked(() => this.files()).find(f => (f.decryptedName === proxyName || f.decryptedName === legacyProxyName) && f.folderId === file.folderId);
      if (proxyFile) {
        await firstValueFrom(this.driveService.trashFile(proxyFile.id));
      }
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

  async loadThumbnail(file: DriveFile): Promise<void> {
    if (untracked(() => this.thumbnails())[file.id] || !file.encryptedFdk) return;
    try {
      const fdkBase64 = await this.cryptoService.decryptName(file.encryptedFdk);
      const fdkString = atob(fdkBase64);
      const fdk = new Uint8Array(fdkString.length);
      for (let i = 0; i < fdkString.length; i++) fdk[i] = fdkString.charCodeAt(i);

      let gdriveUrl: string | null = null;
      let gdriveToken: string | null = null;
      if (file.storageProvider === 'google_drive') {
        const meta = await firstValueFrom(this.driveService.downloadExternalMetadata(file.id));
        gdriveUrl = `https://www.googleapis.com/drive/v3/files/${meta.external_file_id}?alt=media`;
        gdriveToken = meta.access_token;
      }

      const initialFetchSize = 1024 * 128;
      let blob: Blob;

      if (gdriveUrl && gdriveToken) {
        blob = await firstValueFrom(this.http.get(gdriveUrl, {
          headers: { 'Range': `bytes=0-${initialFetchSize - 1}`, 'Authorization': `Bearer ${gdriveToken}` },
          responseType: 'blob'
        }));
      } else {
        blob = await firstValueFrom(this.driveService.downloadFileRange(file.id, 0, initialFetchSize - 1));
      }

      const { metadata } = await this.kasumi.extractMetadata(blob, fdk);
      if (metadata) {
        const parsed = JSON.parse(metadata);
        if (parsed.thumb) {
          this.thumbnails.update(t => ({ ...t, [file.id]: parsed.thumb }));
        }
      }
    } catch (e) {
      console.warn('Could not load thumbnail for file ' + file.id);
    }
  }

  async restoreItem(file: DriveFile): Promise<void> {
    if (file.isFolder) {
      await firstValueFrom(this.driveService.restoreFolder(file.id));
    } else {
      await firstValueFrom(this.driveService.restoreFile(file.id));
      
      const proxyName = '__PROXY__' + file.decryptedName;
      const proxyFile = untracked(() => this.trashFiles()).find(f => f.decryptedName === proxyName && f.folderId === file.folderId);
      if (proxyFile) {
        await firstValueFrom(this.driveService.restoreFile(proxyFile.id));
      }
    }
    await this.loadTrash();
    await this.loadTree();
    await this.loadQuota();
  }

  async batchRestoreItems(files: DriveFile[]): Promise<void> {
    const trashFiles = untracked(() => this.trashFiles());
    const restorePromises = files.map(async file => {
      if (file.isFolder) {
        await firstValueFrom(this.driveService.restoreFolder(file.id));
      } else {
        await firstValueFrom(this.driveService.restoreFile(file.id));
        
        const proxyName1 = '__PROXY__' + file.decryptedName;
        const proxyName2 = file.decryptedName + '.proxy.mp4';
        const proxyFiles = trashFiles.filter(p => (p.decryptedName === proxyName1 || p.decryptedName === proxyName2) && p.folderId === file.folderId);
        for (const proxy of proxyFiles) {
          await firstValueFrom(this.driveService.restoreFile(proxy.id));
        }
      }
    });

    try {
      await Promise.all(restorePromises);
    } finally {
      await this.loadTrash();
      await this.loadTree();
      await this.loadQuota();
    }
  }

  async permanentDeleteItem(file: DriveFile): Promise<void> {
    if (file.isFolder) {
      await firstValueFrom(this.driveService.hardDeleteFolder(file.id));
    } else {
      await firstValueFrom(this.driveService.hardDeleteFile(file.id));
      
      const proxyName = '__PROXY__' + file.decryptedName;
      const proxyFile = untracked(() => this.trashFiles()).find(f => f.decryptedName === proxyName && f.folderId === file.folderId);
      if (proxyFile) {
        await firstValueFrom(this.driveService.hardDeleteFile(proxyFile.id));
      }
    }
    await this.loadTrash();
    await this.loadQuota();
  }

  async emptyTrash(): Promise<void> {
    await firstValueFrom(this.driveService.emptyTrash());
    await this.loadTrash();
    await this.loadQuota();
  }

  async batchTrashItems(files: DriveFile[]): Promise<void> {
    const fileIds = files.filter(f => !f.isFolder).map(f => f.id);
    const folderIds = files.filter(f => f.isFolder).map(f => f.id);

    try {
      if (fileIds.length > 0) {
        await firstValueFrom(this.driveService.batchSoftDeleteFiles(fileIds));
      }
      if (folderIds.length > 0) {
        await firstValueFrom(this.driveService.batchSoftDeleteFolders(folderIds));
      }
    } finally {
      await this.loadTree();
      await this.loadQuota();
    }
  }

  async batchPermanentDeleteItems(files: DriveFile[]): Promise<void> {
    const fileIds = files.filter(f => !f.isFolder).map(f => f.id);
    const folderIds = files.filter(f => f.isFolder).map(f => f.id);
    
    // Also try to find proxies to delete
    const trashFiles = untracked(() => this.trashFiles());
    const proxyIds: number[] = [];
    for (const f of files.filter(f => !f.isFolder)) {
      const proxyName1 = '__PROXY__' + f.decryptedName;
      const proxyName2 = f.decryptedName + '.proxy.mp4';
      const proxyFiles = trashFiles.filter(p => (p.decryptedName === proxyName1 || p.decryptedName === proxyName2) && p.folderId === f.folderId);
      proxyFiles.forEach(p => proxyIds.push(p.id));
    }
    
    const allFileIds = [...fileIds, ...proxyIds];

    try {
      if (allFileIds.length > 0) {
        await firstValueFrom(this.driveService.batchHardDeleteFiles(allFileIds));
      }
      if (folderIds.length > 0) {
        await firstValueFrom(this.driveService.batchHardDeleteFolders(folderIds));
      }
    } finally {
      await this.loadTrash();
      await this.loadQuota();
    }
  }
}
