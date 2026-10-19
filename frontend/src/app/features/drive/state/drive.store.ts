import { Injectable, signal, computed, inject, untracked, effect } from '@angular/core';
import { DriveService } from '../services/drive.service';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { firstValueFrom, from } from 'rxjs';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { DialogService } from '../../../core/dialog/dialog.service';
import { VideoTranscoderService } from '../services/video-transcoder.service';
import { environment } from '../../../../environments/environment';
import { AppStateService, AppStatus } from '../../../core/state/app-state.service';
import { UploadEngineService, generateThumbnail } from '../upload/upload-engine.service';
import { UploadBatchCoordinatorService } from '../upload/upload-batch-coordinator.service';
import { GoogleUploadPlan, GoogleUploadSession, LocalUploadPlan, UploadBatchCandidate, UploadBatchSummary, UploadProvider } from '../upload/upload.models';
import { firstValueFromAbortable, isUploadAbortError } from '../upload/abortable-observable';
import { FolderUploadCoordinatorService } from '../upload/folder-upload-coordinator.service';
import { FolderUploadSourceFile } from '../upload/upload.models';
import { resolveFilePreviewKind } from '../services/file-preview-resolver';
import { LinkedGoogleAccount, StorageProvider } from './drive.types';
import { StorageMoveEngineService } from '../storage-move/storage-move-engine.service';
import { formatBytes } from '../../../shared/utils/format-bytes';
import { DownloadEngineService } from '../services/download-engine.service';
import type { DownloadState } from '../services/download-engine.service';
import { ThumbnailLoaderService } from '../services/thumbnail-loader.service';
import { DRIVE_TRANSFER_CHUNK_SIZE, DRIVE_CONTROL_REQUEST_DEADLINE_MS, DRIVE_CHUNK_REQUEST_DEADLINE_MS } from '../transfer-limits';
import { KASUMI_KAS2_METADATA_PREFIX_SIZE, KASUMI_MAX_METADATA_SIZE } from '../../../core/crypto/kasumi-format';

export function buildGoogleAuthorizationUrl(origin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: environment.googleClientId,
    redirect_uri: `${origin}/auth/callback`,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ].join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export interface TransferItem {
  id: string;
  fileName: string;
  type: 'upload' | 'download';
  status: 'pending' | 'processing' | 'paused' | 'cancelling' | 'cancelled' | 'success' | 'error';
  phase?: 'queued' | 'encrypting' | 'initializing' | 'uploading' | 'finalizing' | 'recovering';
  statusMessage?: string;
  progress: number;
  errorMsg?: string;
  timestamp: Date;
  speed?: string;
  eta?: string;
  speedBytesPerSecond?: number;
  groupId?: string;
  isRecovery?: boolean;
  pendingData?: PendingUpload;
  bytesTransferred?: number;
  totalBytes?: number;
  history?: { bytes: number, time: number }[];
}

export type TransferGroupSource = 'multiple-files' | 'folder-upload' | 'drop-files' | 'drop-folders' | 'mixed-drop';
type TransferGroupStatus = 'queued' | 'active' | 'paused' | 'cancelling' | 'success' | 'error' | 'partial' | 'cancelled';

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
  external_storage_id: number | null;
}

export interface DriveFile {
  id: number;
  isFolder: boolean;
  encryptedName: string;
  decryptedName: string | null; // Null if locked or failed to decrypt
  type: string;
  mimeType?: string;
  sizeBytes: number;
  sizeFormatted: string;
  modifiedAt: string;
  owner: string;
  encryptedFdk?: string;
  storageProvider: StorageProvider;
  externalStorageId: number | null;
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

interface UploadRuntimeCommon {
  transferId: string;
  file: File;
  fileId: number;
  folderId: number | null;
  provider: UploadProvider;
  initRes?: any;
  isHiddenProxy: boolean;
}

type ActiveUploadRuntime =
  | (Omit<UploadRuntimeCommon, 'provider'> & { provider: 'local'; plan: LocalUploadPlan })
  | (Omit<UploadRuntimeCommon, 'provider'> & { provider: 'google_drive'; plan: GoogleUploadPlan; session?: GoogleUploadSession });

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
  private readonly dialogService = inject(DialogService);
  private readonly videoTranscoder = inject(VideoTranscoderService);
  private readonly appState = inject(AppStateService);
  private readonly uploadEngine = inject(UploadEngineService);
  private readonly uploadBatchCoordinator = inject(UploadBatchCoordinatorService);
  private readonly folderUploadCoordinator = inject(FolderUploadCoordinatorService);
  private readonly storageMoveEngine = inject(StorageMoveEngineService);
  private readonly downloadEngine = inject(DownloadEngineService);
  private readonly thumbnailLoader = inject(ThumbnailLoaderService);

  constructor() {
    effect(() => {
      if (this.appState.status() === AppStatus.Locked) {
        untracked(() => {
          this.thumbnailLoader.clear();
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
  readonly linkedAccounts = signal<LinkedGoogleAccount[]>([]);
  readonly trashFiles = signal<DriveFile[]>([]);
  readonly transfers = signal<TransferItem[]>([]);
  readonly transferGroups = signal<TransferGroup[]>([]);
  readonly transferGroupViews = computed(() => this.transferGroups().map(group => this.toTransferGroupView(group)));
  readonly thumbnails = this.thumbnailLoader.thumbnails;

  readonly currentFolderId = signal<number | null>(null);
  private readonly backHistory = signal<Array<number | null>>([]);
  private readonly forwardHistory = signal<Array<number | null>>([]);
  readonly canGoBack = computed(() => this.backHistory().length > 0);
  readonly canGoForward = computed(() => this.forwardHistory().length > 0);
  readonly canGoUp = computed(() => this.currentFolderId() !== null);

  // States to persist active/paused uploads and downloads in RAM
  private activeUploads = new Map<string, ActiveUploadRuntime>();

  private readonly uploadControllers = new Map<string, AbortController>();
  private readonly uploadOperations = new Map<string, Promise<unknown>>();
  private readonly uploadInitializedFileIds = new Map<string, Set<number>>();
  private readonly recoveringUploadFileIds = new Map<string, number>();
  private readonly uploadCleanupPromises = new Map<string, Promise<void>>();
  private readonly googleCleanupPendingFileIds = new Map<string, number>();
  private readonly googleCleanupBlockedTransfers = new Set<string>();
  private readonly uploadGroupControllers = new Map<string, AbortController>();
  private uploadRuntimeGeneration = 0;
  private decryptedPresentationGeneration = 0;

  private pausedTransfers = new Set<string>();
  private cancelledTransfers = new Set<string>();
  private pendingUploadsSync = Promise.resolve();
  private treeReconciliationTimer: ReturnType<typeof setTimeout> | null = null;
  private treeReconciliationInFlight = false;
  private treeReconciliationPromise: Promise<void> | null = null;
  private treeReconciliationRequested = false;
  private treeReconciliationSuccesses = 0;
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
      const res = await firstValueFrom(this.driveService.getLinkedGoogleAccounts());
      this.linkedAccounts.set(res.accounts.map(account => ({
        id: account.id,
        accountEmail: account.account_email,
        accountPicture: account.account_picture?.trim() || undefined,
        rootFolderId: account.root_folder_id,
        status: account.status === 'unlinking' ? 'unlinking' : 'ready',
        usedBytes: 0,
        maxBytes: null,
        availableBytes: null,
        nanikaUsedBytes: 0,
      })));
    } catch (e) {
      console.error('Failed to load linked accounts', e);
      this.linkedAccounts.set([]);
    }
  }

  async linkGoogleDrive(): Promise<void> {
    try {
      const res = await firstValueFrom(this.driveService.generateGoogleState());
      window.location.assign(buildGoogleAuthorizationUrl(window.location.origin, res.state));
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
    this.files.update(current => current.map(f => ({ ...f, decryptedName: null })));
    this.trashFiles.update(current => current.map(f => ({ ...f, decryptedName: null })));
  }

  clearDecryptedPresentationData(): void {
    this.decryptedPresentationGeneration++;
    this.clearDecryptedNames();
    this.transfers.update(list => list.map(transfer => {
      const hasVaultDerivedRecoveryLabel = transfer.type === 'upload' && !!transfer.pendingData?.encrypted_name;
      return !hasVaultDerivedRecoveryLabel || transfer.fileName === 'Arquivo Desconhecido'
        ? transfer
        : { ...transfer, fileName: 'Arquivo Desconhecido' };
    }));
    this.thumbnailLoader.clear();
  }

  private isCurrentDecryptedPresentation(generation: number): boolean {
    return generation === this.decryptedPresentationGeneration;
  }

  async loadQuota(): Promise<void> {
    try {
      const res = await firstValueFromAbortable(this.driveService.getQuota(), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
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
    const generation = this.decryptedPresentationGeneration;
    this.isLoading.set(true);
    try {
      const pageSize = 100;
      let page = await firstValueFromAbortable(this.driveService.getTree(pageSize, 0), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      if (!this.isCurrentDecryptedPresentation(generation)) return;
      const folders = page.folders;
      const files = [...page.files];
      let offset = files.length;

      while (page.has_more) {
        page = await firstValueFromAbortable(this.driveService.getTree(pageSize, offset, false), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
        if (!this.isCurrentDecryptedPresentation(generation)) return;
        files.push(...page.files);
        offset += page.files.length;
        if (page.files.length === 0) break;
      }

      const parsedFiles: DriveFile[] = [];
      
      for (const folder of folders) {
        let decName = null;
        if (this.cryptoService.isVaultUnlocked()) {
          decName = await this.cryptoService.decryptName(folder.encrypted_name);
          if (!this.isCurrentDecryptedPresentation(generation)) return;
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
          storageProvider: 'local',
          externalStorageId: null,
          parentId: (folder.parent_id !== undefined && folder.parent_id !== null) ? folder.parent_id : null
        });
      }

      for (const file of files) {
        let decName = null;
        if (this.cryptoService.isVaultUnlocked()) {
          decName = await this.cryptoService.decryptName(file.encrypted_name);
          if (!this.isCurrentDecryptedPresentation(generation)) return;
        }
        
        const type = decName ? this.fileTypeFromName(decName, file.mime_type) : 'unknown';

        parsedFiles.push({
          id: file.id,
          isFolder: false,
          encryptedName: file.encrypted_name,
          decryptedName: decName,
          type: type,
          mimeType: file.mime_type,
          sizeBytes: file.size_bytes,
          sizeFormatted: formatBytes(file.size_bytes),
          modifiedAt: '—',
          owner: 'eu',
          encryptedFdk: file.encrypted_fdk,
          storageProvider: file.storage_provider,
          externalStorageId: file.external_storage_id,
          folderId: (file.folder_id !== undefined && file.folder_id !== null) ? file.folder_id : null,
          isHidden: file.is_hidden
        });
      }

      if (!this.isCurrentDecryptedPresentation(generation)) return;
      this.files.set(parsedFiles);
      const currentFileIds = new Set(parsedFiles.filter(file => !file.isFolder).map(file => file.id));
      this.thumbnailLoader.prune(currentFileIds);
      if (!this.isCurrentDecryptedPresentation(generation)) return;
      await this.loadPendingUploads();
    } catch (e) {
      console.error('Failed to load tree', e);
    } finally {
      this.isLoading.set(false);
    }
  }

  async loadPendingUploads(
    uploadGeneration = this.uploadRuntimeGeneration,
    presentationGeneration = this.decryptedPresentationGeneration,
  ): Promise<void> {
    if (!this.isCurrentUploadRuntime(uploadGeneration)) return;
    try {
      const res = await firstValueFromAbortable(this.driveService.getPendingUploads(), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      if (!this.isCurrentUploadRuntime(uploadGeneration)) return;
      const runtimeTransferIds = this.liveUploadRuntimeTransferIds();
      this.transfers.update(list => list.filter(t =>
        !t.isRecovery || (this.isLiveUploadTransfer(t) && runtimeTransferIds.has(t.id))
      ));
      let liveFileIds = this.liveUploadFileIds();
      let completedFileIds = this.completedFileIds();

      for (const pending of (res.pending_uploads ?? []) as PendingUpload[]) {
        if (!this.isCurrentUploadRuntime(uploadGeneration)) return;
        if (liveFileIds.has(pending.id) || completedFileIds.has(pending.id)) continue;
        const id = `pending_${pending.id}`;
        let decryptedName: string | null = null;
        if (this.isCurrentDecryptedPresentation(presentationGeneration) && this.cryptoService.isVaultUnlocked()) {
          decryptedName = await this.cryptoService.decryptName(pending.encrypted_name);
        }
        if (!this.isCurrentUploadRuntime(uploadGeneration)) return;
        liveFileIds = this.liveUploadFileIds();
        completedFileIds = this.completedFileIds();
        if (!this.isCurrentUploadRuntime(uploadGeneration)) return;
        if (liveFileIds.has(pending.id) || completedFileIds.has(pending.id)) continue;
        const percent = pending.total_chunks > 0 ? Math.round((pending.uploaded_chunks_count / pending.total_chunks) * 100) : 0;
        const canPublishDecryptedName = this.isCurrentDecryptedPresentation(presentationGeneration)
          && this.cryptoService.isVaultUnlocked();

        this.addTransfer({
          id,
          fileName: canPublishDecryptedName && decryptedName ? decryptedName : 'Arquivo Desconhecido',
          type: 'upload',
          status: 'paused',
          statusMessage: 'Aguardando arquivo original...',
          progress: percent,
          isRecovery: true,
          pendingData: pending
        });
      }
    } catch (e) {
      console.error('Failed to load pending uploads', e);
    }
  }

  private isLiveUploadTransfer(transfer: TransferItem): boolean {
    return transfer.type === 'upload'
      && (transfer.status === 'pending'
        || transfer.status === 'processing'
        || transfer.status === 'paused'
        || transfer.status === 'cancelling');
  }

  private liveUploadRuntimeTransferIds(): Set<string> {
    const transferIds = new Set<string>();
    for (const transferId of this.uploadInitializedFileIds.keys()) transferIds.add(transferId);
    for (const upload of this.activeUploads.values()) transferIds.add(upload.transferId);
    for (const transferId of this.recoveringUploadFileIds.keys()) transferIds.add(transferId);
    return transferIds;
  }

  private completedFileIds(): Set<number> {
    return new Set(this.files().filter(file => !file.isFolder).map(file => file.id));
  }

  private liveUploadFileIds(): Set<number> {
    const liveTransferIds = new Set(
      this.transfers().filter(transfer => this.isLiveUploadTransfer(transfer))
        .map(transfer => transfer.id)
    );
    const fileIds = new Set<number>();

    for (const [transferId, ids] of this.uploadInitializedFileIds) {
      if (liveTransferIds.has(transferId)) for (const fileId of ids) fileIds.add(fileId);
    }
    for (const upload of this.activeUploads.values()) {
      if (liveTransferIds.has(upload.transferId)) fileIds.add(upload.fileId);
    }
    for (const [transferId, fileId] of this.recoveringUploadFileIds) {
      if (liveTransferIds.has(transferId)) fileIds.add(fileId);
    }
    return fileIds;
  }

  private async ensureStorageProviderAvailable(): Promise<void> {
    if (this.storageProvider() !== 'google_drive') return;

    if (!this.linkedAccounts().some(account => account.status === 'ready')) {
      await this.loadLinkedAccounts();
    }

    if (!this.linkedAccounts().some(account => account.status === 'ready')) {
      throw new Error('Conta Google Drive não vinculada. Vincule uma conta nas configurações antes de enviar arquivos.');
    }
  }

  private syncPendingUploads(generation = this.uploadRuntimeGeneration): Promise<void> {
    const next = this.pendingUploadsSync.then(() => {
      if (!this.isCurrentUploadRuntime(generation)) return;
      return this.loadPendingUploads(generation);
    });
    this.pendingUploadsSync = next.then(() => undefined, () => undefined);
    return next;
  }

  private isCurrentUploadRuntime(generation: number): boolean {
    return generation === this.uploadRuntimeGeneration;
  }

  private throwIfUploadRuntimeStale(generation: number): void {
    if (!this.isCurrentUploadRuntime(generation)) {
      throw new DOMException('Upload session detached', 'AbortError');
    }
  }

  private fileTypeFromName(name: string, mimeType?: string): string {
    const lower = name.toLowerCase();
    if (lower.endsWith('.pdf')) return 'pdf';
    const previewKind = resolveFilePreviewKind({ type: 'unknown', decryptedName: name, encryptedName: name, mimeType });
    if (previewKind !== 'unsupported') return previewKind;
    if (/\.(doc|docx)$/i.test(lower)) return 'doc';
    if (/\.(xls|xlsx)$/i.test(lower)) return 'spreadsheet';
    return 'unknown';
  }

  private appendCompletedUploadToTree(uploadId: string): void {
    const upload = this.activeUploads.get(uploadId);
    if (!upload || upload.isHiddenProxy) return;
    const prepared = upload.plan;
    const { file } = upload;
    this.files.update(files => {
      if (files.some(existing => existing.id === upload.fileId)) return files;
      return [...files, {
        id: upload.fileId,
        isFolder: false,
        encryptedName: prepared.encryptedName,
        decryptedName: this.cryptoService.isVaultUnlocked() ? file.name : null,
        type: this.fileTypeFromName(file.name, file.type),
        mimeType: file.type || undefined,
        sizeBytes: prepared.encryptedSize,
        sizeFormatted: formatBytes(prepared.encryptedSize),
        modifiedAt: '—',
        owner: 'eu',
        encryptedFdk: prepared.encryptedFdk,
        storageProvider: upload.provider,
        externalStorageId: upload.provider === 'local' ? null : null,
        folderId: upload.folderId,
        isHidden: false
      }];
    });
    if (prepared.thumbnail && this.cryptoService.isVaultUnlocked()) {
      this.thumbnailLoader.setThumbnail(upload.fileId, prepared.thumbnail);
    }
    this.scheduleTreeReconciliation();
  }

  private scheduleTreeReconciliation(): void {
    this.treeReconciliationRequested = true;
    this.treeReconciliationSuccesses++;
    if (this.treeReconciliationSuccesses >= 25) {
      void this.flushTreeReconciliation();
      return;
    }
    if (this.treeReconciliationTimer === null) {
      this.treeReconciliationTimer = setTimeout(() => {
        this.treeReconciliationTimer = null;
        void this.flushTreeReconciliation();
      }, 2500);
    }
  }

  private async flushTreeReconciliation(): Promise<void> {
    if (this.treeReconciliationTimer !== null) {
      clearTimeout(this.treeReconciliationTimer);
      this.treeReconciliationTimer = null;
    }
    if (this.treeReconciliationInFlight) {
      await this.treeReconciliationPromise;
      return;
    }
    if (!this.treeReconciliationRequested) return;

    this.treeReconciliationRequested = false;
    this.treeReconciliationSuccesses = 0;
    this.treeReconciliationInFlight = true;
    this.treeReconciliationPromise = this.loadTree();
    try {
      await this.treeReconciliationPromise;
    } finally {
      this.treeReconciliationInFlight = false;
      this.treeReconciliationPromise = null;
      if (this.treeReconciliationRequested) this.scheduleTreeReconciliation();
    }
  }

  async reDecryptAll(): Promise<void> {
    if (!this.cryptoService.isVaultUnlocked()) return;
    const generation = this.decryptedPresentationGeneration;
    const currentFiles = untracked(() => this.files());
    const updated = [];
    
    for (const f of currentFiles) {
      const decName = await this.cryptoService.decryptName(f.encryptedName);
      if (!this.isCurrentDecryptedPresentation(generation)) return;
      
      const type = f.isFolder ? 'folder' : decName ? this.fileTypeFromName(decName, f.mimeType) : 'unknown';
      
      updated.push({
        ...f,
        decryptedName: decName,
        type: type
      });
    }
    if (!this.isCurrentDecryptedPresentation(generation)) return;
    this.files.set(updated);

    const currentTransfers = untracked(() => this.transfers());
    for (const t of currentTransfers) {
      if (t.isRecovery && t.pendingData?.encrypted_name) {
        const decName = await this.cryptoService.decryptName(t.pendingData.encrypted_name);
        if (!this.isCurrentDecryptedPresentation(generation)) return;
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
    this.uploadGroupControllers.set(id, new AbortController());
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

  private ensureUploadController(transferId: string): AbortController {
    const existing = this.uploadControllers.get(transferId);
    if (existing && !existing.signal.aborted) return existing;
    const controller = new AbortController();
    this.uploadControllers.set(transferId, controller);
    return controller;
  }

  private uploadSignal(transferId: string): AbortSignal {
    return this.ensureUploadController(transferId).signal;
  }

  private markInitialized(transferId: string, fileId: number): void {
    const ids = this.uploadInitializedFileIds.get(transferId) ?? new Set<number>();
    ids.add(fileId);
    this.uploadInitializedFileIds.set(transferId, ids);
  }

  private releaseTerminalUploadRuntime(transferId: string): void {
    this.uploadInitializedFileIds.delete(transferId);
    this.recoveringUploadFileIds.delete(transferId);
    for (const [uploadId, upload] of this.activeUploads) {
      if (upload.transferId !== transferId) continue;
      this.runtimeFdk(upload).fill(0);
      this.activeUploads.delete(uploadId);
    }
  }

  private runtimeFdk(upload: ActiveUploadRuntime): Uint8Array {
    return upload.plan.fdk;
  }

  private async parkPausedUpload(uploadId: string, transferId: string): Promise<void> {
    if (this.activeUploads.get(uploadId)?.provider !== 'google_drive') return;
    if (this.cancelledTransfers.has(transferId) || this.uploadControllers.get(transferId)?.signal.aborted) {
      await this.cleanupCancelledUpload(transferId);
    }
  }

  private throwIfUploadCancelled(transferId: string): void {
    if (this.cancelledTransfers.has(transferId) || this.uploadControllers.get(transferId)?.signal.aborted) {
      throw new DOMException('Upload cancelled', 'AbortError');
    }
  }

  private cleanupCancelledUpload(transferId: string, googleCleanupPendingFileId?: number): Promise<void> {
    const existing = this.uploadCleanupPromises.get(transferId);
    if (existing) return existing;
    const generation = this.uploadRuntimeGeneration;

    const retainedGoogleFileId = this.googleCleanupPendingFileIds.get(transferId);
    if (this.googleCleanupBlockedTransfers.has(transferId)
      && googleCleanupPendingFileId === undefined && retainedGoogleFileId === undefined) {
      return Promise.reject(new Error('Cleanup Google pendente sem arquivo associado'));
    }
    if (retainedGoogleFileId !== undefined && googleCleanupPendingFileId !== undefined
      && retainedGoogleFileId !== googleCleanupPendingFileId) {
      return Promise.reject(new Error('Cleanup Google pendente associado a outro arquivo'));
    }
    const pendingGoogleFileId = googleCleanupPendingFileId ?? retainedGoogleFileId;
    if (googleCleanupPendingFileId !== undefined) {
      this.googleCleanupPendingFileIds.set(transferId, googleCleanupPendingFileId);
    }

    const cleanup = (async () => {
      const fileIds = new Set(this.uploadInitializedFileIds.get(transferId) ?? []);
      const recoveringFileId = this.recoveringUploadFileIds.get(transferId);
      if (recoveringFileId !== undefined) fileIds.add(recoveringFileId);
      for (const [uploadId, upload] of this.activeUploads) {
        if (upload.transferId !== transferId && uploadId !== transferId) continue;
        fileIds.add(upload.fileId);
        this.runtimeFdk(upload).fill(0);
        this.activeUploads.delete(uploadId);
      }
      if (pendingGoogleFileId !== undefined && !fileIds.has(pendingGoogleFileId)) {
        throw new Error('Arquivo Google pendente nao pertence ao upload cancelado');
      }
      for (const fileId of fileIds) {
        try {
          if (fileId === pendingGoogleFileId) {
            await firstValueFromAbortable(this.driveService.cancelExternalUpload(fileId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
          } else {
            await firstValueFromAbortable(this.driveService.trashFile(fileId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
            await firstValueFromAbortable(this.driveService.hardDeleteFile(fileId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
          }
        } catch (error: any) {
          if (fileId === pendingGoogleFileId) {
            console.error('Falha ao transferir cleanup Google cancelado', error);
            throw error;
          }
          if (error?.status !== 404) console.error('Falha ao limpar arquivo cancelado', error);
        }
      }
      if (this.isCurrentUploadRuntime(generation)) {
        this.uploadInitializedFileIds.delete(transferId);
        this.recoveringUploadFileIds.delete(transferId);
        this.googleCleanupPendingFileIds.delete(transferId);
        this.googleCleanupBlockedTransfers.delete(transferId);
        await this.syncPendingUploads(generation);
      }
    })();
    this.uploadCleanupPromises.set(transferId, cleanup);
    const release = () => {
      if (this.uploadCleanupPromises.get(transferId) === cleanup) {
        this.uploadCleanupPromises.delete(transferId);
      }
    };
    void cleanup.then(release, release);
    return cleanup;
  }

  private googleRuntimeFileId(transferId: string): number | undefined {
    for (const upload of this.activeUploads.values()) {
      if (upload.transferId === transferId && upload.provider === 'google_drive') return upload.fileId;
    }
    return undefined;
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
    const activeFiles = members.filter(item => item.status === 'processing' || item.status === 'pending' || item.status === 'cancelling').length;
    const cancellingFiles = members.filter(item => item.status === 'cancelling').length;
    const cancelledFiles = Math.max(cancelled.size, members.filter(item => item.status === 'cancelled').length);
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
    if (cancellingFiles > 0) status = 'cancelling';
    else if (completedFiles === group.transferIds.length) status = 'success';
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
      canCancel: !allTerminal && cancellingFiles === 0,
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
    this.uploadGroupControllers.get(id)?.abort();
    const cancellations = group.transferIds
      .map(transferId => this.transfers().find(item => item.id === transferId))
      .filter((transfer): transfer is TransferItem => !!transfer && !['success', 'error', 'cancelled'].includes(transfer.status))
      .map(transfer => this.cancelTransfer(transfer.id));
    await Promise.allSettled(cancellations);
  }

  clearTransferGroup(id: string): void {
    const view = this.transferGroupViews().find(group => group.id === id);
    if (!view?.canClear) return;
    const group = this.transferGroups().find(item => item.id === id);
    if (!group) return;
    const ids = new Set(group.transferIds);
    this.transfers.update(list => list.filter(item => !ids.has(item.id)));
    this.transferGroups.update(groups => groups.filter(item => item.id !== id));
    this.uploadGroupControllers.delete(id);
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
    const generation = this.uploadRuntimeGeneration;
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Drive trancado');
    await this.ensureStorageProviderAvailable();
    if (!this.isCurrentUploadRuntime(generation)) return;
    const activeTransferId = transferId ?? this.newTransferId();
    const controller = this.ensureUploadController(activeTransferId);
    let operation = this._doUpload(file, folderId, refresh, groupId, activeTransferId, false, generation);
    this.uploadOperations.set(activeTransferId, operation);

    try {
      await operation;
    } catch (e: any) {
      if (!this.isCurrentUploadRuntime(generation)) return;
      if (isUploadAbortError(e) || this.cancelledTransfers.has(activeTransferId)) {
        await this.cleanupCancelledUpload(activeTransferId);
        return;
      }
      if (e?.status === 409) {
        if (this.cancelledTransfers.has(activeTransferId) || this.uploadControllers.get(activeTransferId)?.signal.aborted) return;
        const confirmed = await this.dialogService.confirm(
          'Substituir arquivo?',
          `Já existe um arquivo chamado "${file.name}" nesta pasta. Deseja substituir o arquivo existente?`,
          'Substituir',
          true
        );
        if (!confirmed) {
          return;
        }
        if (this.cancelledTransfers.has(activeTransferId) || this.uploadControllers.get(activeTransferId)?.signal.aborted) return;
        if (!this.isCurrentUploadRuntime(generation)) return;
        const existing = this.files().find(f =>
          !f.isFolder && (f.folderId === folderId) && (f.decryptedName === file.name)
        );
        const replacedFileId = existing?.id;
        if (existing) {
          await firstValueFromAbortable(this.driveService.trashFile(replacedFileId!), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
          if (!this.isCurrentUploadRuntime(generation)) return;
        }
        const replacementOperation = this._doUpload(file, folderId, refresh, groupId, activeTransferId, true, generation);
        operation = replacementOperation;
        this.uploadOperations.set(activeTransferId, replacementOperation);
        try {
          await replacementOperation;
          if (!this.isCurrentUploadRuntime(generation)) return;
          const replacementStatus = this.transfers().find(item => item.id === activeTransferId)?.status;
          if (replacedFileId === undefined || replacementStatus === 'paused') return;

          if (replacementStatus === 'success') {
            try {
              if (!this.isCurrentUploadRuntime(generation)) return;
              await firstValueFromAbortable(this.driveService.hardDeleteFile(replacedFileId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
            } catch (cleanupError: any) {
              if (cleanupError?.status !== 404) console.error('Falha ao limpar arquivo substituído', cleanupError?.status ?? 'unknown');
            }
          } else if (replacementStatus === 'cancelled') {
            try {
              if (!this.isCurrentUploadRuntime(generation)) return;
              await firstValueFromAbortable(this.driveService.restoreFile(replacedFileId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
            } catch (restoreError: any) {
              if (restoreError?.status !== 404) console.error('Falha ao restaurar arquivo substituído', restoreError?.status ?? 'unknown');
            }
          }
        } catch (replacementError) {
          if (!this.isCurrentUploadRuntime(generation)) return;
          if (replacedFileId !== undefined) {
            try {
              await firstValueFromAbortable(this.driveService.restoreFile(replacedFileId), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
            } catch (restoreError: any) {
              if (restoreError?.status !== 404) console.error('Falha ao restaurar arquivo substituído', restoreError?.status ?? 'unknown');
            }
          }
          throw replacementError;
        }
      } else {
        console.error('Falha no upload', e);
        throw e;
      }
    } finally {
      await new Promise(r => setTimeout(r, 1500));
      if (this.uploadOperations.get(activeTransferId) === operation) this.uploadOperations.delete(activeTransferId);
      if (!this.cancelledTransfers.has(activeTransferId)
        && this.uploadControllers.get(activeTransferId) === controller) {
        this.uploadControllers.delete(activeTransferId);
      }
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
    const generation = this.uploadRuntimeGeneration;
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Drive trancado');
    await this.ensureStorageProviderAvailable();
    if (!this.isCurrentUploadRuntime(generation)) return;

    const transferIds = files.map(() => this.newTransferId());
    const transferIdByFile = new Map(files.map((file, index) => [file, transferIds[index]]));
    const groupId = files.length >= 2 ? this.createTransferGroup(source, transferIds) : undefined;

    const individualVideoFiles = files.filter(file =>
      this.videoTranscoder.isVideo(file) && !this.videoTranscoder.isStreamingFormatSupported(file)
    );
    const batchFiles = files.filter(file => !individualVideoFiles.includes(file));
    if (individualVideoFiles.length > 0) {
      await Promise.all(individualVideoFiles.map(file => this.uploadFile(file, folderId, true, groupId, transferIdByFile.get(file))));
    }
    if (!this.isCurrentUploadRuntime(generation)) return;
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
    const generation = this.uploadRuntimeGeneration;
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Drive trancado');
    await this.ensureStorageProviderAvailable();
    if (!this.isCurrentUploadRuntime(generation)) return;
    const transferIds = files.map(() => this.newTransferId());
    const groupId = files.length >= 2 ? this.createTransferGroup(source, transferIds) : undefined;
    transferIds.forEach((id, index) => {
      this.ensureUploadController(id);
      this.addTransfer({ id, fileName: files[index].name, type: 'upload', status: 'pending', phase: 'queued', statusMessage: 'Preparando pasta...', progress: 0, groupId });
    });
    const signal = groupId ? this.uploadGroupControllers.get(groupId)!.signal : this.uploadSignal(transferIds[0]);
    try {
      const mapped = await this.folderUploadCoordinator.prepare(files, rootParentId, signal);
      if (!this.isCurrentUploadRuntime(generation)) return;
      await this.uploadFolderCandidates(mapped, source, transferIds, groupId, generation);
    } catch (error) {
      if (!isUploadAbortError(error)) throw error;
    }
  }

  async uploadFolderSources(
    sources: readonly FolderUploadSourceFile[],
    rootParentId: number | null = this.currentFolderId(),
    source: TransferGroupSource = 'drop-folders'
  ): Promise<void> {
    if (!sources.length) return;
    const generation = this.uploadRuntimeGeneration;
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Drive trancado');
    await this.ensureStorageProviderAvailable();
    if (!this.isCurrentUploadRuntime(generation)) return;
    const transferIds = sources.map(() => this.newTransferId());
    const groupId = sources.length >= 2 ? this.createTransferGroup(source, transferIds) : undefined;
    transferIds.forEach((id, index) => {
      this.ensureUploadController(id);
      this.addTransfer({ id, fileName: sources[index].file.name, type: 'upload', status: 'pending', phase: 'queued', statusMessage: 'Preparando pasta...', progress: 0, groupId });
    });
    const signal = groupId ? this.uploadGroupControllers.get(groupId)!.signal : this.uploadSignal(transferIds[0]);
    try {
      const mapped = await this.folderUploadCoordinator.prepareSources(sources, rootParentId, signal);
      if (!this.isCurrentUploadRuntime(generation)) return;
      await this.uploadFolderCandidates(mapped, source, transferIds, groupId, generation);
    } catch (error) {
      if (!isUploadAbortError(error)) throw error;
    }
  }

  private async uploadFolderCandidates(
    mapped: readonly { file: File; folderId: number | null }[],
    source: TransferGroupSource,
    transferIds?: readonly string[],
    groupId?: string,
    generation = this.uploadRuntimeGeneration,
  ): Promise<void> {
    if (!this.isCurrentUploadRuntime(generation)) return;
    const effectiveTransferIds = transferIds ?? mapped.map(() => this.newTransferId());
    const activeMapped = mapped.filter((_, index) => !this.cancelledTransfers.has(effectiveTransferIds[index]));
    const individualVideoFiles = activeMapped.filter(item =>
      this.videoTranscoder.isVideo(item.file) && !this.videoTranscoder.isStreamingFormatSupported(item.file)
    );
    const batchFiles = activeMapped.filter(item => !individualVideoFiles.includes(item));
    const effectiveGroupId = groupId ?? (mapped.length >= 2 ? this.createTransferGroup(source, effectiveTransferIds) : undefined);
    const transferIdByFile = new Map(mapped.map((item, index) => [item.file, effectiveTransferIds[index]]));
    try {
      await Promise.all(individualVideoFiles.map(item => this.uploadFile(item.file, item.folderId, false, effectiveGroupId, transferIdByFile.get(item.file))));
      if (!this.isCurrentUploadRuntime(generation)) return;
      if (batchFiles.length > 0) await this.uploadBatchFiles(batchFiles.map(item => ({ ...item, groupId: effectiveGroupId, transferId: transferIdByFile.get(item.file) })), false);
    } finally {
      if (this.isCurrentUploadRuntime(generation)) {
        await this.flushTreeReconciliation();
        if (this.isCurrentUploadRuntime(generation)) await this.loadQuota();
      }
    }
  }

  private async uploadBatchFiles(
    items: readonly { file: File; folderId: number | null; groupId?: string; transferId?: string }[],
    refresh = true
  ): Promise<UploadBatchSummary> {
    const generation = this.uploadRuntimeGeneration;
    if (!this.isCurrentUploadRuntime(generation)) {
      return { total: 0, succeeded: 0, paused: 0, cancelled: 0, failed: 0 };
    }
    const candidates: UploadBatchCandidate[] = items.map(item => {
      const { file, folderId } = item;
      const transferId = item.transferId ?? this.newTransferId();
      const controller = this.ensureUploadController(transferId);
      this.addTransfer({
        id: transferId,
        fileName: file.name,
        type: 'upload',
        status: 'pending',
        phase: 'queued',
        statusMessage: 'Aguardando na fila...',
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
          shouldDetach: () => !this.isCurrentUploadRuntime(generation),
          signal: controller.signal,
        }
      };
    });

    const operation = this.uploadBatchCoordinator.upload(candidates, {
      onInitialized: (candidate, initialized, response) => {
        if (!this.isCurrentUploadRuntime(generation)) {
          this.uploadEngine.discardUploadPlan(initialized.plan);
          return;
        }
        this.updateTransfer(candidate.transferId, {
          statusMessage: 'Preparado para envio...'
        });
        this.activeUploads.set(candidate.transferId + '_batch', initialized.provider === 'local'
          ? {
            provider: 'local',
            transferId: candidate.transferId,
            file: candidate.file,
            fileId: response.file_id,
            plan: initialized.plan,
            folderId: candidate.folderId,
            initRes: response,
            isHiddenProxy: false,
          }
          : {
            provider: 'google_drive',
            transferId: candidate.transferId,
            file: candidate.file,
            fileId: response.file_id,
            plan: initialized.plan,
            folderId: candidate.folderId,
            initRes: response,
            isHiddenProxy: false,
          });
        this.markInitialized(candidate.transferId, response.file_id);
      },
      onStarted: candidate => {
        if (!this.isCurrentUploadRuntime(generation)) return;
        this.updateTransfer(candidate.transferId, {
          status: 'processing',
          phase: 'uploading',
          statusMessage: 'Enviando...'
        });
      },
      onProgress: (candidate, progress, transferredBytes, totalBytes) =>
        this.isCurrentUploadRuntime(generation)
          ? this.updateTransferProgress(candidate.transferId, progress, transferredBytes, totalBytes)
          : undefined,
      onResult: async result => {
        if (!this.isCurrentUploadRuntime(generation)) return;
        if (result.status === 'success') {
          this.appendCompletedUploadToTree(result.transferId + '_batch');
          this.releaseTerminalUploadRuntime(result.transferId);
          this.updateTransfer(result.transferId, { status: 'success', phase: undefined, progress: 100, statusMessage: 'Concluído!' });
        } else if (result.status === 'paused') {
          const runtime = this.activeUploads.get(result.transferId + '_batch');
          if (runtime?.provider === 'google_drive' && result.googleSession
            && runtime.transferId === result.transferId) {
            runtime.session = result.googleSession;
          }
          await this.parkPausedUpload(result.transferId + '_batch', result.transferId);
          this.updateTransfer(result.transferId, { status: 'paused', phase: undefined });
        } else if (result.status === 'cancelled') {
          try {
            const pendingFileId = result.googleCleanupPending
              ? this.googleRuntimeFileId(result.transferId)
              : undefined;
            if (result.googleCleanupPending && pendingFileId === undefined) {
              this.googleCleanupBlockedTransfers.add(result.transferId);
              throw new Error('Arquivo Google pendente nao encontrado para cleanup');
            }
            await this.cleanupCancelledUpload(
              result.transferId,
              pendingFileId,
            );
            this.updateTransfer(result.transferId, { status: 'cancelled', phase: undefined, statusMessage: 'Cancelado' });
          } catch (error: any) {
            this.updateTransfer(result.transferId, {
              status: 'error', phase: undefined,
              errorMsg: error?.message || 'Falha ao assumir cleanup do upload Google',
            });
            await this.syncPendingUploads();
          }
        } else {
          const error = result.error as { message?: string } | undefined;
          this.updateTransfer(result.transferId, { status: 'error', phase: undefined, errorMsg: error?.message || 'Falha no upload' });
          this.releaseTerminalUploadRuntime(result.transferId);
          void this.syncPendingUploads();
        }
      }
    });

    for (const candidate of candidates) this.uploadOperations.set(candidate.transferId, operation);

    let summary: UploadBatchSummary;
    try {
      summary = await operation;
    } finally {
      for (const candidate of candidates) {
        if (this.uploadOperations.get(candidate.transferId) === operation) {
          this.uploadOperations.delete(candidate.transferId);
          if (this.cancelledTransfers.has(candidate.transferId)) await this.cleanupCancelledUpload(candidate.transferId);
          this.uploadControllers.delete(candidate.transferId);
        }
      }
    }

    if (summary.succeeded > 0 && this.isCurrentUploadRuntime(generation)) {
      await this.flushTreeReconciliation();
      if (refresh && this.isCurrentUploadRuntime(generation)) await this.loadQuota();
    }
    return summary;
  }

  private async _doUpload(
    originalFile: File,
    folderId: number | null = null,
    refresh = true,
    groupId?: string,
    transferId?: string,
    rollbackFailedReplacement = false,
    generation = this.uploadRuntimeGeneration,
  ): Promise<void> {
    this.throwIfUploadRuntimeStale(generation);
    const isVideo = this.videoTranscoder.isVideo(originalFile);
    
    const filesToUpload: { file: File, isHiddenProxy: boolean }[] = [];
    const activeTransferId = transferId ?? this.newTransferId();
    this.ensureUploadController(activeTransferId);
    this.throwIfUploadCancelled(activeTransferId);
    if (this.transfers().some(item => item.id === activeTransferId)) {
      this.updateTransfer(activeTransferId, {
        fileName: originalFile.name,
        status: 'processing',
        phase: 'initializing',
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
        phase: 'initializing',
        statusMessage: 'Preparando...',
        progress: 0,
        groupId,
      });
    }

    let fileToEncrypt = originalFile;

    if (isVideo) {
       const isSupported = this.videoTranscoder.isStreamingFormatSupported(originalFile);
       if (!isSupported) {
          const conversionMode = 'pure';
          try {
            this.updateTransfer(activeTransferId, { statusMessage: 'Convertendo vídeo incompatível...' });
            const signal = this.uploadSignal(activeTransferId);
            const proxyFile = await this.videoTranscoder.transcodeToProxy(originalFile, conversionMode, (p: number, statusMessage: string) => {
              this.throwIfUploadRuntimeStale(generation);
              this.updateTransfer(activeTransferId, { statusMessage: statusMessage });
              this.updateTransferProgress(activeTransferId, Math.round(p * 100), 0, 100);
              this.throwIfUploadCancelled(activeTransferId);
            }, signal);
            fileToEncrypt = new File([proxyFile], originalFile.name, { type: proxyFile.type });
            this.throwIfUploadRuntimeStale(generation);
            this.throwIfUploadCancelled(activeTransferId);
          } catch (e: any) {
            if (isUploadAbortError(e) || this.cancelledTransfers.has(activeTransferId)) throw e;
            console.error('Erro na transcodificação, enviando original', e);
            fileToEncrypt = originalFile;
          }
       }
    }

    filesToUpload.push({ file: fileToEncrypt, isHiddenProxy: false });

    for (const item of filesToUpload) {
      await this._uploadSingleFile(item.file, folderId, item.isHiddenProxy, activeTransferId, refresh, rollbackFailedReplacement, generation);
    }
  }

  private async _uploadSingleFile(
    file: File,
    folderId: number | null,
    isHiddenProxy: boolean,
    transferId: string,
    refresh = true,
    rollbackFailedReplacement = false,
    generation = this.uploadRuntimeGeneration,
  ): Promise<void> {
    if (!this.isCurrentUploadRuntime(generation)) return;
    const uploadId = transferId + (isHiddenProxy ? '_proxy' : '_original');
    
    this.updateTransfer(transferId, {
      status: 'processing',
      phase: 'encrypting',
      statusMessage: isHiddenProxy ? 'Enviando versão otimizada...' : 'Enviando original...',
      progress: 0
    });
    let upload: LocalUploadPlan | GoogleUploadPlan | undefined;
    let runtimeHandedOff = false;
    try {
      const plan = await this.uploadEngine.planUpload(file, this.uploadSignal(transferId));
      if (!this.isCurrentUploadRuntime(generation)) {
        this.uploadEngine.discardUploadPlan(plan);
        return;
      }
      this.throwIfUploadCancelled(transferId);
      const activeProvider = this.storageProvider();
      upload = activeProvider === 'local'
        ? this.uploadEngine.createLocalUploadPlan(plan)
        : this.uploadEngine.createGoogleUploadPlan(plan);
      if (!this.isCurrentUploadRuntime(generation)) {
        this.uploadEngine.discardUploadPlan(upload);
        return;
      }

      const initRes = await firstValueFromAbortable(this.driveService.initFileUpload(
        folderId,
        upload.encryptedName,
        upload.nameHash,
        upload.encryptedFdk,
        upload.encryptedSize,
        upload.totalChunks,
        activeProvider,
        undefined,
        undefined,
        undefined,
        isHiddenProxy
      ), this.uploadSignal(transferId), DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      if (!this.isCurrentUploadRuntime(generation)) {
        this.uploadEngine.discardUploadPlan(upload);
        return;
      }
      const fileId = initRes.file_id;
      this.markInitialized(transferId, fileId);
      this.throwIfUploadCancelled(transferId);

      if (activeProvider === 'local') {
        this.activeUploads.set(uploadId, {
          provider: 'local', transferId, file, fileId,
          plan: upload as LocalUploadPlan, folderId, initRes, isHiddenProxy,
        });
      } else {
        this.activeUploads.set(uploadId, {
          provider: 'google_drive', transferId, file, fileId,
          plan: upload as GoogleUploadPlan, folderId, initRes, isHiddenProxy,
        });
      }
      runtimeHandedOff = true;

      await this.runUploadLoop(uploadId, transferId, fileId, isHiddenProxy, refresh, generation);
    } catch (e: any) {
      if (!this.isCurrentUploadRuntime(generation)) {
        if (!runtimeHandedOff && upload) this.uploadEngine.discardUploadPlan(upload);
        return;
      }
      if (!runtimeHandedOff && upload) this.uploadEngine.discardUploadPlan(upload);
      if (isUploadAbortError(e) || this.cancelledTransfers.has(transferId)) {
        await this.cleanupCancelledUpload(transferId);
      } else if (rollbackFailedReplacement && e?.message !== 'PAUSED') {
        this.updateTransfer(transferId, { status: 'error', phase: undefined, errorMsg: e?.message || 'Falha no upload' });
        try {
          await this.cleanupCancelledUpload(transferId);
        } catch (cleanupError: any) {
          console.error('Falha ao limpar replacement incompleto', cleanupError?.status ?? 'unknown');
        }
      } else if (e?.message !== 'PAUSED') {
        this.updateTransfer(transferId, { status: 'error', phase: undefined, errorMsg: e?.message || 'Falha no upload' });
        this.releaseTerminalUploadRuntime(transferId);
        await this.syncPendingUploads();
      }
      throw e;
    }
  }

  private async runUploadLoop(
    uploadId: string,
    transferId: string,
    fileId: number,
    isHiddenProxy: boolean,
    refresh = true,
    generation = this.uploadRuntimeGeneration,
  ): Promise<void> {
    if (!this.isCurrentUploadRuntime(generation)) return;
    const runtime = this.activeUploads.get(uploadId);
    if (!runtime) throw new Error('Upload runtime ausente');
    const control = {
      shouldPause: () => this.pausedTransfers.has(transferId),
      shouldCancel: () => this.cancelledTransfers.has(transferId),
      shouldDetach: () => !this.isCurrentUploadRuntime(generation),
      signal: this.uploadSignal(transferId),
    };
    const callbacks = {
      onProgress: ({ progress, transferredBytes, totalBytes }: { progress: number; transferredBytes: number; totalBytes: number }) =>
        this.isCurrentUploadRuntime(generation)
          ? this.updateTransferProgress(transferId, progress, transferredBytes, totalBytes)
          : undefined,
    };
    let result;
    if (runtime.provider === 'local') {
      result = await this.uploadEngine.executeLocal(runtime.plan, fileId, control, callbacks);
    } else {
      result = await this.uploadEngine.executeGoogle(runtime.plan, fileId, runtime.session, control, callbacks);
      if (!this.isCurrentUploadRuntime(generation)) return;
      if (result.googleSession) {
        const current = this.activeUploads.get(uploadId);
        if (current === runtime && current.provider === 'google_drive') current.session = result.googleSession;
      }
    }

    if (!this.isCurrentUploadRuntime(generation)) return;
    if (result.cancelled || this.cancelledTransfers.has(transferId)) {
      this.updateTransfer(transferId, { status: 'cancelled', phase: undefined, statusMessage: 'Cancelado' });
      await this.cleanupCancelledUpload(transferId, result.googleCleanupPending ? fileId : undefined);
      return;
    }
    if (result.paused) {
      await this.parkPausedUpload(uploadId, transferId);
      if (this.cancelledTransfers.has(transferId)) return;
      this.updateTransfer(transferId, { status: 'paused', phase: undefined });
      return;
    }
    
    // Deleta do activeUploads e apenas marca concluído na UI se não for um proxy escondido ou se for o único arquivo
    this.appendCompletedUploadToTree(uploadId);
    this.releaseTerminalUploadRuntime(transferId);
    
    // Se isHiddenProxy é true, apenas removemos e não atualizamos a UI (o arquivo principal vai atualizar a UI quando acabar)
    // Contudo, se só havia o proxy (ex: erro no principal), a UI ficaria travada. Mas o fluxo atual não permite isso.
    if (!isHiddenProxy) {
      this.updateTransfer(transferId, { status: 'success', phase: undefined, progress: 100, statusMessage: 'Concluído!' });
    }
    
    if (refresh) {
      await this.flushTreeReconciliation();
      if (!this.isCurrentUploadRuntime(generation)) return;
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
    const signal = this.downloadEngine.begin(transferId);

    const setProgress = (prog: number, bytes: number, total: number) => {
      this.updateTransferProgress(transferId, prog, bytes, total);
    };

    let fdk: Uint8Array | undefined;
    try {
      setProgress(5, 0, file.sizeBytes);
      if (file.shareFdk) {
        fdk = new Uint8Array(file.shareFdk);
      } else {
        if (!file.encryptedFdk) throw new Error('FDK ausente nos metadados');
        const fdkBase64 = await this.cryptoService.decryptName(file.encryptedFdk);
        const fdkString = atob(fdkBase64);
        fdk = new Uint8Array(fdkString.length);
        for (let i = 0; i < fdkString.length; i++) {
          fdk[i] = fdkString.charCodeAt(i);
        }
      }

      if (signal.aborted) {
        return;
      }
      setProgress(10, 0, file.sizeBytes);

      if (file.storageProvider === 'google_drive') {
        const meta = await firstValueFromAbortable(this.driveService.downloadExternalMetadata(file.id), signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
        if (signal.aborted) {
          return;
        }
        setProgress(30, 0, file.sizeBytes);

        const state: DownloadState = { kind: 'google', file, meta, fdk };
        const accepted = this.downloadEngine.setState(transferId, state);
        fdk = undefined;
        if (!accepted) return;
        await this.downloadEngine.run(transferId, state, this.downloadCallbacks(transferId));
      } else {
        // Local file chunked download
        setProgress(15, 0, file.sizeBytes);
        const maxHeaderSize = KASUMI_MAX_METADATA_SIZE + KASUMI_KAS2_METADATA_PREFIX_SIZE;
        const maxRequestedSize = Math.min(Math.max(file.sizeBytes, 1), maxHeaderSize);
        let requestedSize = Math.min(128 * 1024, maxRequestedSize);
        let headerBlob: Blob;
        let dataOffset: number;
        let expectedSize: number;
        while (true) {
          headerBlob = await firstValueFromAbortable(
            this.driveService.downloadFileRange(file.id, 0, requestedSize - 1),
            signal, DRIVE_CHUNK_REQUEST_DEADLINE_MS);
          if (signal.aborted) return;
          try {
            ({ dataOffset, expectedSize } = await this.kasumi.extractMetadata(headerBlob, fdk, file.sizeBytes));
            if (signal.aborted) return;
            break;
          } catch (error) {
            const nextSize = this.nextMetadataFetchSize(error, requestedSize, maxRequestedSize);
            if (nextSize === undefined) throw error;
            requestedSize = nextSize;
          }
        }
        const baseNonce = new Uint8Array(await headerBlob.slice(0, 24).arrayBuffer());
        if (signal.aborted) return;

        const plaintextChunks: Blob[] = [];
        const state: DownloadState = {
          kind: 'local',
          file,
          fdk,
          baseNonce,
          expectedSize,
          plaintextChunks,
          decryptedBytes: 0,
          currentOffset: dataOffset,
          chunkIndex: 0
        };
        const accepted = this.downloadEngine.setState(transferId, state);
        fdk = undefined;
        if (!accepted) return;
        await this.downloadEngine.run(transferId, state, this.downloadCallbacks(transferId));
      }
    } catch (e: any) {
      if (signal.aborted || isUploadAbortError(e)) {
        return;
      }
      if (e?.message !== 'PAUSED') {
        console.error('Falha no download', e);
        this.updateTransfer(transferId, { status: 'error', errorMsg: e?.message || 'Falha no download' });
        this.downloadEngine.deleteState(transferId);
      }
      throw e;
    } finally {
      fdk?.fill(0);
    }
  }

  private downloadCallbacks(id: string) {
    return {
      setProgress: (progress: number, bytes: number, total: number) => this.updateTransferProgress(id, progress, bytes, total),
      updateTransfer: (transferId: string, changes: Partial<TransferItem>) => this.updateTransfer(transferId, changes),
      isPaused: (transferId: string) => this.pausedTransfers.has(transferId),
    };
  }

  pauseTransfer(id: string) {
    if (this.transfers().find(item => item.id === id)?.status === 'cancelling' || this.cancelledTransfers.has(id)) return;
    this.pausedTransfers.add(id);
    this.updateTransfer(id, { status: 'paused', speed: 'Pausado', eta: '--:--' });

    // Abort active local downloads by marking as paused. Google Drive / monolithic downloads will just run to completion and drop.
  }

  async resumeUpload(id: string) {
    const generation = this.uploadRuntimeGeneration;
    const operation = this.uploadOperations.get(id);
    if (operation) {
      try {
        await operation;
      } catch {
        if (this.cancelledTransfers.has(id)) return;
      }
    }
    if (!this.isCurrentUploadRuntime(generation)) return;

    const uploadsToResume = [];
    for (const [uploadId, data] of this.activeUploads.entries()) {
      if (data.transferId === id) {
        uploadsToResume.push({ uploadId, data });
      }
    }

    if (uploadsToResume.length === 0) return;

    const controller = new AbortController();
    this.uploadControllers.set(id, controller);
    const resumeOperation = this.resumeUploadRuntime(id, uploadsToResume, controller, generation);
    this.uploadOperations.set(id, resumeOperation);

    try {
      await resumeOperation;
    } finally {
      if (this.uploadOperations.get(id) === resumeOperation) this.uploadOperations.delete(id);
      if (this.uploadControllers.get(id) === controller) this.uploadControllers.delete(id);
    }
  }

  private async resumeUploadRuntime(
    id: string,
    uploadsToResume: Array<{ uploadId: string; data: ActiveUploadRuntime }>,
    controller: AbortController,
    generation = this.uploadRuntimeGeneration,
  ): Promise<void> {
    if (!this.isCurrentUploadRuntime(generation)) return;
    this.pausedTransfers.delete(id);
    this.updateTransfer(id, { status: 'processing', speed: 'Calculando...', eta: '--:--' });

    try {
      for (const { uploadId, data } of uploadsToResume) {
        if (!this.isCurrentUploadRuntime(generation)) return;
        if (this.pausedTransfers.has(id)) return;

        this.updateTransfer(id, {
          statusMessage: data.isHiddenProxy ? 'Retomando versão otimizada...' : 'Retomando original...'
        });

        if (data.provider === 'local') {
          await this.runUploadLoop(uploadId, id, data.fileId, data.isHiddenProxy, true, generation);
          continue;
        }
        await this.runUploadLoop(uploadId, id, data.fileId, data.isHiddenProxy, true, generation);
      }
    } catch (e: any) {
      if (!this.isCurrentUploadRuntime(generation)) return;
      if (isUploadAbortError(e) || this.cancelledTransfers.has(id) || controller.signal.aborted) {
        await this.cleanupCancelledUpload(id);
        return;
      }
      if (e?.message !== 'PAUSED') {
        this.releaseTerminalUploadRuntime(id);
        this.updateTransfer(id, { status: 'error', errorMsg: e?.message || 'Falha no upload' });
        await this.syncPendingUploads();
      }
    }
  }

  async cancelTransfer(id: string) {
    const generation = this.uploadRuntimeGeneration;
    const transfer = this.transfers().find(t => t.id === id);
    if (!transfer || transfer.status === 'success' || transfer.status === 'error' || transfer.status === 'cancelled') return;
    const wasRecovery = !!transfer.isRecovery;

    this.cancelledTransfers.add(id);
    this.updateTransfer(id, { status: 'cancelling', phase: transfer.phase, statusMessage: 'Cancelando...' });
    this.recordCancelledTransfer(transfer);
    this.pausedTransfers.delete(id);

    if (transfer.type === 'download') {
      this.downloadEngine.cancel(id);
      this.updateTransfer(id, { status: 'cancelled', phase: undefined, statusMessage: 'Cancelado' });
      this.cancelledTransfers.delete(id);
      return;
    }

    const recoveryRuntimeOwnedBeforeJoin = wasRecovery
      && [...this.activeUploads.values()].some(upload => upload.transferId === id);
    const recoveryCleanupBeforeJoin = wasRecovery ? this.uploadCleanupPromises.get(id) : undefined;
    this.uploadControllers.get(id)?.abort();

    const operation = this.uploadOperations.get(id);
    let operationRejected = false;
    let operationError: unknown;
    if (operation) {
      try {
        await operation;
      } catch (error) {
        operationRejected = true;
        operationError = error;
      }
    }
    if (!this.isCurrentUploadRuntime(generation)) return;
    const recoveryOwnedByCleanup = wasRecovery && (
      recoveryRuntimeOwnedBeforeJoin
      || !!recoveryCleanupBeforeJoin
      || this.recoveringUploadFileIds.has(id)
      || this.uploadInitializedFileIds.has(id)
      || [...this.activeUploads.values()].some(upload => upload.transferId === id)
      || this.uploadCleanupPromises.has(id)
    );
    if (recoveryCleanupBeforeJoin) {
      await recoveryCleanupBeforeJoin;
    } else if (!(operation && recoveryRuntimeOwnedBeforeJoin)) {
      await this.cleanupCancelledUpload(id);
    }
    if (!this.isCurrentUploadRuntime(generation)) return;
    if (operation && recoveryRuntimeOwnedBeforeJoin && operationRejected) {
      throw operationError;
    }

    if (transfer.isRecovery && transfer.pendingData && !recoveryOwnedByCleanup) {
      try {
        await firstValueFromAbortable(this.driveService.trashFile(transfer.pendingData.id), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
        await firstValueFromAbortable(this.driveService.hardDeleteFile(transfer.pendingData.id), undefined, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      } catch (e: any) {
        if (e?.status !== 404) console.error('Falha ao limpar arquivo pendente', e);
      }
    }

    if (!this.isCurrentUploadRuntime(generation)) return;
    const current = this.transfers().find(item => item.id === id);
    if (!current && wasRecovery) {
      this.addTransfer({
        ...transfer,
        status: 'cancelled',
        phase: undefined,
        statusMessage: 'Cancelado',
      });
    } else if (current && current.status !== 'success') {
      this.updateTransfer(id, { status: 'cancelled', phase: undefined, statusMessage: 'Cancelado' });
    }
    this.pausedTransfers.delete(id);
    this.cancelledTransfers.delete(id);
  }

  private throwIfRecoveryCancelled(transferId: string, signal: AbortSignal, generation = this.uploadRuntimeGeneration): void {
    if (!this.isCurrentUploadRuntime(generation) || signal.aborted || this.cancelledTransfers.has(transferId)) {
      throw new DOMException('Upload cancelled', 'AbortError');
    }
  }

  private validateRecoveryGeometry(pending: PendingUpload, encryptedSize: number): void {
    if (encryptedSize !== pending.size_bytes) {
      throw new Error('O arquivo selecionado não reproduz o upload pendente.');
    }
    const expectedChunks = Math.ceil(encryptedSize / DRIVE_TRANSFER_CHUNK_SIZE);
    if (expectedChunks !== pending.total_chunks) {
      throw new Error('Geometria de chunks incompatível com o upload pendente.');
    }
  }

  private async prepareFreshLocalRecovery(
    transferId: string,
    pending: PendingUpload,
    file: File,
    fdk: Uint8Array,
    signal: AbortSignal,
    nameHash = '',
    generation = this.uploadRuntimeGeneration,
  ): Promise<LocalUploadPlan> {
    const thumbnail = await generateThumbnail(file, signal);
    this.throwIfRecoveryCancelled(transferId, signal, generation);
    const metadata = thumbnail ? JSON.stringify({ thumb: thumbnail }) : undefined;
    const encryptedSize = this.kasumi.calculateEncryptedSize(file.size, metadata);
    this.validateRecoveryGeometry(pending, encryptedSize);
    return this.uploadEngine.createLocalUploadPlan({
      file,
      encryptedName: pending.encrypted_name,
      nameHash,
      encryptedFdk: pending.encrypted_fdk,
      fdk,
      totalChunks: pending.total_chunks,
      encryptedSize,
      thumbnail: thumbnail ?? undefined,
    });
  }

  private async prepareFreshGoogleRecovery(
    transferId: string,
    pending: PendingUpload,
    file: File,
    fdk: Uint8Array,
    signal: AbortSignal,
    nameHash = '',
    generation = this.uploadRuntimeGeneration,
  ): Promise<GoogleUploadPlan> {
    const thumbnail = await generateThumbnail(file, signal);
    this.throwIfRecoveryCancelled(transferId, signal, generation);
    const metadata = thumbnail ? JSON.stringify({ thumb: thumbnail }) : undefined;
    const encryptedSize = this.kasumi.calculateEncryptedSize(file.size, metadata);
    this.validateRecoveryGeometry(pending, encryptedSize);
    const baseNonce = this.kasumi.generateBaseNonce();
    try {
      return this.uploadEngine.createGoogleUploadPlan({
        file,
        encryptedName: pending.encrypted_name,
        nameHash,
        encryptedFdk: pending.encrypted_fdk,
        fdk,
        totalChunks: pending.total_chunks,
        encryptedSize,
        thumbnail: thumbnail ?? undefined,
      }, baseNonce, metadata);
    } catch (error) {
      baseNonce.fill(0);
      throw error;
    }
  }

  private async readPendingKasumiContext(
    transferId: string,
    pending: PendingUpload,
    fdk: Uint8Array,
    signal: AbortSignal,
    generation = this.uploadRuntimeGeneration,
  ): Promise<{ baseNonce: Uint8Array; metadata: string | null; expectedSize: number }> {
    const maxRequestedSize = Math.min(pending.size_bytes, DRIVE_TRANSFER_CHUNK_SIZE);
    if (maxRequestedSize < 24) throw new Error('Contexto criptográfico incompleto.');
    let requestedSize = Math.min(128 * 1024, maxRequestedSize);

    while (true) {
      const blob = await firstValueFromAbortable(
        this.driveService.downloadPendingUploadRecoveryPrefix(pending.id, requestedSize - 1),
        signal, DRIVE_CHUNK_REQUEST_DEADLINE_MS);
      this.throwIfRecoveryCancelled(transferId, signal, generation);
      if (blob.size < 24) throw new Error('Contexto criptográfico incompleto.');

      const bytes = new Uint8Array(await blob.arrayBuffer());
      this.throwIfRecoveryCancelled(transferId, signal, generation);
      const baseNonce = bytes.slice(0, 24);
      bytes.fill(0);
      try {
        const extracted = await this.kasumi.extractMetadata(blob, fdk, pending.size_bytes);
        this.throwIfRecoveryCancelled(transferId, signal, generation);
        return { baseNonce, metadata: extracted.metadata, expectedSize: extracted.expectedSize };
      } catch (error) {
        baseNonce.fill(0);
        const message = error instanceof Error ? error.message : String(error);
        const partial = /partial blob|full metadata|metadata block/i.test(message);
        if (!partial || requestedSize >= maxRequestedSize) throw error;
        requestedSize = Math.min(maxRequestedSize, Math.max(requestedSize * 4, 1024 * 1024));
      }
    }
  }

  private nextMetadataFetchSize(error: unknown, requestedSize: number, maxRequestedSize: number): number | undefined {
    const message = error instanceof Error ? error.message : String(error);
    if (!/partial blob|full metadata|metadata block/i.test(message) || requestedSize >= maxRequestedSize) return;
    return Math.min(maxRequestedSize, Math.max(requestedSize * 4, 1024 * 1024));
  }

  private async prepareLocalRecovery(
    transferId: string,
    pending: PendingUpload,
    file: File,
    fdk: Uint8Array,
    signal: AbortSignal,
    generation = this.uploadRuntimeGeneration,
  ): Promise<LocalUploadPlan> {
    const response = await firstValueFromAbortable(this.driveService.getUploadedChunks(pending.id), signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
    this.throwIfRecoveryCancelled(transferId, signal, generation);
    const uploadedChunks = new Set(response.uploaded_chunks ?? []);
    if ([...uploadedChunks].some(index => !Number.isInteger(index) || index < 0 || index >= pending.total_chunks)) {
      throw new Error('Índice de chunk incompatível com o upload pendente.');
    }

    if (uploadedChunks.size === 0) {
      return this.prepareFreshLocalRecovery(transferId, pending, file, fdk, signal, '', generation);
    }
    if (!uploadedChunks.has(0)) throw new Error('Contexto criptográfico incompleto.');

    this.updateTransfer(transferId, { statusMessage: 'Recuperando contexto de criptografia...' });
    const context = await this.readPendingKasumiContext(transferId, pending, fdk, signal, generation);
    let nonceTransferred = false;
    try {
      this.throwIfRecoveryCancelled(transferId, signal, generation);
      if (context.expectedSize !== file.size) {
        throw new Error('O arquivo selecionado não corresponde ao upload pendente.');
      }
      this.updateTransfer(transferId, {
        status: 'processing',
        statusMessage: 'Preparando retomada local...',
        speed: 'Calculando...',
        eta: '--:--',
      });
      const encryptedSize = this.kasumi.calculateEncryptedSize(file.size, context.metadata ?? undefined);
      this.validateRecoveryGeometry(pending, encryptedSize);
      const plan = this.uploadEngine.createLocalUploadPlan({
        file,
        encryptedName: pending.encrypted_name,
        nameHash: '',
        encryptedFdk: pending.encrypted_fdk,
        fdk,
        totalChunks: pending.total_chunks,
        encryptedSize,
      }, context.baseNonce, context.metadata ?? undefined);
      nonceTransferred = true;
      return plan;
    } finally {
      if (!nonceTransferred) context.baseNonce.fill(0);
    }
  }

  recoverUpload(id: string, pendingData: PendingUpload, file: File): Promise<void> {
    const generation = this.uploadRuntimeGeneration;
    const existing = this.uploadOperations.get(id);
    if (existing) return existing as Promise<void>;

    const controller = this.ensureUploadController(id);
    const operation = this.executeRecovery(id, pendingData, file, controller, generation);
    this.uploadOperations.set(id, operation);
    const release = () => {
      if (this.uploadOperations.get(id) !== operation) return;
      this.uploadOperations.delete(id);
      if (this.uploadControllers.get(id) === controller) {
        this.uploadControllers.delete(id);
      }
    };
    void operation.then(release, release);
    return operation;
  }

  private async executeRecovery(
    id: string,
    pendingData: PendingUpload,
    file: File,
    controller: AbortController,
    generation = this.uploadRuntimeGeneration,
  ): Promise<void> {
    if (!this.isCurrentUploadRuntime(generation)) return;
    this.recoveringUploadFileIds.set(id, pendingData.id);
    let fdk: Uint8Array | undefined;
    let runtimeOwnsFdk = false;

    try {
      const throwIfCancelled = () => this.throwIfRecoveryCancelled(id, controller.signal, generation);
      throwIfCancelled();
      const fdkBase64 = await firstValueFromAbortable(
        from(this.cryptoService.decryptName(pendingData.encrypted_fdk)),
        controller.signal,
      );
      throwIfCancelled();
      if (!fdkBase64) throw new Error('Não foi possível decifrar a chave do arquivo pendente.');
      const fdkChars = atob(fdkBase64);
      fdk = new Uint8Array(fdkChars.length);
      for (let i = 0; i < fdkChars.length; i++) fdk[i] = fdkChars.charCodeAt(i);
      throwIfCancelled();

      let upload: LocalUploadPlan | GoogleUploadPlan;
      let initRes: any;
      if (pendingData.storage_provider === 'google_drive') {
        const context = await firstValueFromAbortable(
          this.driveService.getExternalUploadRecoveryContext(pendingData.id),
          controller.signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
        throwIfCancelled();
        if (
          pendingData.external_storage_id === null
          || context.external_storage_id !== pendingData.external_storage_id
          || !context.name_hash
        ) {
          throw new Error('Contexto do Google Drive indisponível para o upload pendente.');
        }
        upload = await this.prepareFreshGoogleRecovery(id, pendingData, file, fdk, controller.signal, context.name_hash, generation);
        throwIfCancelled();
        initRes = {
          name_hash: context.name_hash,
        };
      } else {
        upload = await this.prepareLocalRecovery(id, pendingData, file, fdk, controller.signal, generation);
        throwIfCancelled();
        initRes = {};
      }

      throwIfCancelled();
      this.pausedTransfers.delete(id);
      const uploadId = id + '_recovery';
      this.activeUploads.set(uploadId, pendingData.storage_provider === 'local'
        ? {
          provider: 'local',
          transferId: id,
          file,
          fileId: pendingData.id,
          plan: upload as LocalUploadPlan,
          folderId: pendingData.folder_id,
          initRes,
          isHiddenProxy: false,
        }
        : {
          provider: 'google_drive',
          transferId: id,
          file,
          fileId: pendingData.id,
          plan: upload as GoogleUploadPlan,
          folderId: pendingData.folder_id,
          initRes,
          isHiddenProxy: false,
        });
      runtimeOwnsFdk = true;
      fdk = undefined;
      this.recoveringUploadFileIds.delete(id);
      throwIfCancelled();
      this.updateTransfer(id, { statusMessage: 'Retomando upload...' });

      try {
        const runtime = this.activeUploads.get(uploadId);
        if (!runtime) {
          throw new Error('Recovery runtime was paused before execution');
        }
        await this.runUploadLoop(uploadId, id, pendingData.id, false, true, generation);
        throwIfCancelled();
        this.transfers.update(list => list.map(t => t.id === id ? { ...t, isRecovery: false } : t));
      } catch (error: any) {
        const cancellationActive = controller.signal.aborted || this.cancelledTransfers.has(id);
        if (cancellationActive && runtimeOwnsFdk && !isUploadAbortError(error) && error?.message !== 'PAUSED') {
          throw error;
        }
        if (error?.message !== 'PAUSED' && !cancellationActive) {
          this.releaseTerminalUploadRuntime(id);
          this.updateTransfer(id, { status: 'error', errorMsg: error?.message || 'Falha na recuperação' });
        }
      }
    } catch (error) {
      if (!runtimeOwnsFdk) fdk?.fill(0);
      if (!this.isCurrentUploadRuntime(generation)) return;
      this.releaseTerminalUploadRuntime(id);
      const cancellationActive = controller.signal.aborted || this.cancelledTransfers.has(id);
      if (cancellationActive) {
        if (!runtimeOwnsFdk || isUploadAbortError(error)) return;
        throw error;
      }
      if (isUploadAbortError(error)) return;
      this.updateTransfer(id, {
        status: 'error',
        errorMsg: error instanceof Error ? error.message : 'Falha na recuperação',
      });
      throw error;
    }
  }

  async resumeDownload(id: string) {
    const state = this.downloadEngine.getState(id);
    if (!state) return;

    this.pausedTransfers.delete(id);
    this.updateTransfer(id, { status: 'processing', speed: 'Calculando...', eta: '--:--' });

    try {
      await this.downloadEngine.run(id, state, this.downloadCallbacks(id));
    } catch (e: any) {
      if (!isUploadAbortError(e) && e?.message !== 'PAUSED') {
        this.updateTransfer(id, { status: 'error', errorMsg: e?.message || 'Falha no download' });
      }
    } finally {
      // isDownloading will be updated automatically by computed
    }
  }

  async renameItem(file: DriveFile, newName: string): Promise<void> {
    this.assertStorageMoveInactive(file);
    if (!this.cryptoService.isVaultUnlocked()) throw new Error('Drive trancado');
    const encName = await this.cryptoService.encryptName(newName);
    const hash = await this.cryptoService.hashName(newName);

    if (file.isFolder) {
      await firstValueFrom(this.driveService.updateFolder(file.id, { encrypted_name: encName, name_hash: hash }));
    } else {
      await firstValueFrom(this.driveService.updateFile(file.id, { encrypted_name: encName, name_hash: hash }));
      
      // Se tiver proxy (dual mode), renomeia também
      const proxyName = file.decryptedName + '.proxy.mp4';
      const proxyFile = untracked(() => this.files()).find(f => f.decryptedName === proxyName && f.folderId === file.folderId);
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
    this.assertStorageMoveInactive(file);
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
    this.assertStorageMoveInactive(file);
    if (file.isFolder) {
      await firstValueFrom(this.driveService.trashFolder(file.id));
    } else {
      await firstValueFrom(this.driveService.trashFile(file.id));
      
      // Se tiver proxy, manda pra lixeira tambem
      const proxyName = file.decryptedName + '.proxy.mp4';
      const proxyFile = untracked(() => this.files()).find(f => f.decryptedName === proxyName && f.folderId === file.folderId);
      if (proxyFile) {
        await firstValueFrom(this.driveService.trashFile(proxyFile.id));
      }
    }
    await this.loadTree();
    await this.loadQuota();
  }

  async loadTrash(): Promise<void> {
    const generation = this.decryptedPresentationGeneration;
    this.isLoading.set(true);
    try {
      const res = await firstValueFrom(this.driveService.getTrash());
      if (!this.isCurrentDecryptedPresentation(generation)) return;
      const parsedFiles: DriveFile[] = [];
      
      for (const folder of res.folders) {
        let decName = null;
        if (this.cryptoService.isVaultUnlocked()) {
          decName = await this.cryptoService.decryptName(folder.encrypted_name);
          if (!this.isCurrentDecryptedPresentation(generation)) return;
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
          storageProvider: 'local',
          externalStorageId: null,
          parentId: (folder.parent_id !== undefined && folder.parent_id !== null) ? folder.parent_id : null
        });
      }

      for (const file of res.files) {
        let decName = null;
        if (this.cryptoService.isVaultUnlocked()) {
          decName = await this.cryptoService.decryptName(file.encrypted_name);
          if (!this.isCurrentDecryptedPresentation(generation)) return;
        }
        const type = decName ? this.fileTypeFromName(decName, file.mime_type) : 'unknown';
        parsedFiles.push({
          id: file.id,
          isFolder: false,
          encryptedName: file.encrypted_name,
          decryptedName: decName,
          type: type,
          mimeType: file.mime_type,
          sizeBytes: file.size_bytes,
          sizeFormatted: formatBytes(file.size_bytes),
          modifiedAt: '—',
          owner: 'eu',
          storageProvider: file.storage_provider,
          externalStorageId: file.external_storage_id,
          folderId: (file.folder_id !== undefined && file.folder_id !== null) ? file.folder_id : null
        });
      }

      if (!this.isCurrentDecryptedPresentation(generation)) return;
      this.trashFiles.set(parsedFiles);
    } catch (e) {
      console.error('Failed to load trash', e);
    } finally {
      this.isLoading.set(false);
    }
  }

  async loadThumbnail(file: DriveFile): Promise<void> {
    await this.thumbnailLoader.load(file);
  }

  resetUploadRuntimeState(): void {
    this.uploadRuntimeGeneration++;

    const uploadIds = new Set(
      this.transfers().filter(transfer => transfer.type === 'upload').map(transfer => transfer.id),
    );
    for (const transferId of this.uploadInitializedFileIds.keys()) uploadIds.add(transferId);
    for (const transferId of this.recoveringUploadFileIds.keys()) uploadIds.add(transferId);
    for (const transferId of this.uploadControllers.keys()) uploadIds.add(transferId);
    for (const transferId of this.uploadOperations.keys()) uploadIds.add(transferId);
    for (const transferId of this.uploadCleanupPromises.keys()) uploadIds.add(transferId);
    for (const transferId of this.googleCleanupPendingFileIds.keys()) uploadIds.add(transferId);
    for (const transferId of this.googleCleanupBlockedTransfers) uploadIds.add(transferId);
    for (const upload of this.activeUploads.values()) uploadIds.add(upload.transferId);

    for (const controller of this.uploadControllers.values()) controller.abort();
    for (const controller of this.uploadGroupControllers.values()) controller.abort();
    for (const upload of this.activeUploads.values()) this.runtimeFdk(upload).fill(0);

    this.activeUploads.clear();
    this.uploadControllers.clear();
    this.uploadGroupControllers.clear();
    this.uploadOperations.clear();
    this.uploadInitializedFileIds.clear();
    this.recoveringUploadFileIds.clear();
    this.uploadCleanupPromises.clear();
    this.googleCleanupPendingFileIds.clear();
    this.googleCleanupBlockedTransfers.clear();

    for (const id of uploadIds) {
      this.pausedTransfers.delete(id);
      this.cancelledTransfers.delete(id);
    }
    this.transfers.update(list => list.filter(transfer => transfer.type !== 'upload'));
    this.transferGroups.update(groups => groups
      .map(group => ({
        ...group,
        transferIds: group.transferIds.filter(id => !uploadIds.has(id)),
        cancelledTransferIds: group.cancelledTransferIds.filter(id => !uploadIds.has(id)),
        cancelledBytes: Object.fromEntries(Object.entries(group.cancelledBytes).filter(([id]) => !uploadIds.has(id))),
      }))
      .filter(group => group.transferIds.length > 0));
  }

  resetDownloadRuntimeState(): void {
    const downloadIds = new Set(this.transfers().filter(transfer => transfer.type === 'download').map(transfer => transfer.id));
    this.downloadEngine.resetRuntimeState();
    for (const id of downloadIds) {
      this.pausedTransfers.delete(id);
      this.cancelledTransfers.delete(id);
    }
    this.transfers.update(list => list.filter(transfer => transfer.type !== 'download'));
    this.transferGroups.update(groups => groups
      .map(group => ({
        ...group,
        transferIds: group.transferIds.filter(id => !downloadIds.has(id)),
        cancelledTransferIds: group.cancelledTransferIds.filter(id => !downloadIds.has(id)),
        cancelledBytes: Object.fromEntries(Object.entries(group.cancelledBytes).filter(([id]) => !downloadIds.has(id))),
      }))
      .filter(group => group.transferIds.length > 0));
  }

  async restoreItem(file: DriveFile): Promise<void> {
    if (file.isFolder) {
      await firstValueFrom(this.driveService.restoreFolder(file.id));
    } else {
      await firstValueFrom(this.driveService.restoreFile(file.id));
      
      const proxyName = file.decryptedName + '.proxy.mp4';
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
        
        const proxyName = file.decryptedName + '.proxy.mp4';
        const proxyFiles = trashFiles.filter(p => p.decryptedName === proxyName && p.folderId === file.folderId);
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
    this.assertStorageMoveInactive(file);
    if (file.isFolder) {
      await firstValueFrom(this.driveService.hardDeleteFolder(file.id));
    } else {
      await firstValueFrom(this.driveService.hardDeleteFile(file.id));
      
      const proxyName = file.decryptedName + '.proxy.mp4';
      const proxyFile = untracked(() => this.trashFiles()).find(f => f.decryptedName === proxyName && f.folderId === file.folderId);
      if (proxyFile) {
        await firstValueFrom(this.driveService.hardDeleteFile(proxyFile.id));
      }
    }
    await this.loadTrash();
    await this.loadQuota();
  }

  private assertStorageMoveInactive(file: DriveFile): void {
    if (!file.isFolder && this.storageMoveEngine.activeFileIds().has(file.id)) {
      throw new Error('Este arquivo está sendo transferido entre armazenamentos.');
    }
  }

  async emptyTrash(): Promise<void> {
    await firstValueFrom(this.driveService.emptyTrash());
    await this.loadTrash();
    await this.loadQuota();
  }

  async batchTrashItems(files: DriveFile[]): Promise<void> {
    files.forEach(file => this.assertStorageMoveInactive(file));
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
    files.forEach(file => this.assertStorageMoveInactive(file));
    const fileIds = files.filter(f => !f.isFolder).map(f => f.id);
    const folderIds = files.filter(f => f.isFolder).map(f => f.id);
    
    // Also try to find proxies to delete
    const trashFiles = untracked(() => this.trashFiles());
    const proxyIds: number[] = [];
    for (const f of files.filter(f => !f.isFolder)) {
      const proxyName = f.decryptedName + '.proxy.mp4';
      const proxyFiles = trashFiles.filter(p => p.decryptedName === proxyName && p.folderId === f.folderId);
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
