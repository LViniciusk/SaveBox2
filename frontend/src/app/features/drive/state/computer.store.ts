import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { DriveService, StorageTreeResponse } from '../services/drive.service';
import { resolveFilePreviewKind } from '../services/file-preview-resolver';
import { DriveFile, DriveStore } from './drive.store';
import { StorageTarget } from './drive.types';
import { formatBytes } from '../../../shared/utils/format-bytes';

export interface ComputerPathSegment {
  id: number | string | null;
  name: string;
}

interface ComputerLocation {
  target: StorageTarget | null;
  folderId: number | null;
  folders: readonly ComputerPathSegment[];
}

@Injectable({ providedIn: 'root' })
export class ComputerStore {
  private readonly driveService = inject(DriveService);
  private readonly cryptoService = inject(CryptoService);
  private readonly driveStore = inject(DriveStore, { optional: true });
  private readonly backHistory = signal<ComputerLocation[]>([]);
  private readonly forwardHistory = signal<ComputerLocation[]>([]);
  private readonly folderPath = signal<readonly ComputerPathSegment[]>([]);
  private targetsRequest: Promise<void> | null = null;
  private targetsRequestId = 0;
  private pageRequestId = 0;
  private targetsLoaded = false;

  readonly targets = signal<StorageTarget[]>([]);
  readonly selectedTarget = signal<StorageTarget | null>(null);
  readonly currentFolderId = signal<number | null>(null);
  readonly files = signal<DriveFile[]>([]);
  readonly folderPreviewFiles = signal<DriveFile[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly fileOffset = signal(0);
  readonly hasMore = signal(false);
  readonly canGoBack = computed(() => this.backHistory().length > 0);
  readonly canGoForward = computed(() => this.forwardHistory().length > 0);
  readonly canGoUp = computed(() => this.selectedTarget() !== null);
  readonly currentPath = computed<readonly ComputerPathSegment[]>(() => {
    const base: ComputerPathSegment[] = [
      { id: null, name: 'Nanika' },
      { id: 'computer', name: 'Este Computador' },
    ];
    const target = this.selectedTarget();
    if (!target) return base;
    return [...base, { id: target.key, name: target.label }, ...this.folderPath()];
  });

  async loadTargets(options: { force?: boolean } = {}): Promise<void> {
    const force = options.force === true;
    if (!force && this.targetsLoaded) return;
    if (!force && this.targetsRequest) return this.targetsRequest;

    const requestId = ++this.targetsRequestId;
    this.loading.set(true);
    this.error.set(null);
    const request = (async () => {
      try {
        const response = await firstValueFrom(this.driveService.getStorageTargets());
        if (requestId !== this.targetsRequestId) return;

        const uniqueTargets = [...new Map(response.map(target => [target.key, target])).values()];
        this.targets.set(uniqueTargets);
        this.targetsLoaded = true;
        const selectedKey = this.selectedTarget()?.key;
        if (selectedKey) this.selectedTarget.set(uniqueTargets.find(target => target.key === selectedKey) ?? null);
      } catch {
        if (requestId === this.targetsRequestId) this.error.set('Não foi possível carregar os dispositivos e unidades.');
      } finally {
        if (requestId === this.targetsRequestId) {
          this.loading.set(false);
          this.targetsRequest = null;
        }
      }
    })();
    this.targetsRequest = request;
    return request;
  }

  async openTarget(target: StorageTarget, recordHistory = true): Promise<void> {
    if (target.status !== 'ready') return;
    if (recordHistory) this.pushHistory();
    this.selectedTarget.set(target);
    this.currentFolderId.set(null);
    this.folderPath.set([]);
    this.folderPreviewFiles.set([]);
    this.forwardHistory.set([]);
    await this.loadPage(0);
  }

  async openFolder(folder: DriveFile, recordHistory = true): Promise<void> {
    if (!folder.isFolder || !this.selectedTarget()) return;
    if (recordHistory) this.pushHistory();
    this.currentFolderId.set(folder.id);
    this.folderPath.update(path => [...path, { id: folder.id, name: folder.decryptedName ?? folder.encryptedName }]);
    this.folderPreviewFiles.set([]);
    this.forwardHistory.set([]);
    await this.loadPage(0);
  }

  async showRoot(recordHistory = true): Promise<void> {
    if (recordHistory && this.selectedTarget()) this.pushHistory();
    this.pageRequestId++;
    this.selectedTarget.set(null);
    this.currentFolderId.set(null);
    this.folderPath.set([]);
    this.files.set([]);
    this.folderPreviewFiles.set([]);
    this.forwardHistory.set([]);
    if (!this.targetsLoaded) await this.loadTargets();
  }

  async openHome(options: { refreshTargets?: boolean } = {}): Promise<void> {
    this.pageRequestId++;
    this.backHistory.set([]);
    this.forwardHistory.set([]);
    this.selectedTarget.set(null);
    this.currentFolderId.set(null);
    this.folderPath.set([]);
    this.files.set([]);
    this.folderPreviewFiles.set([]);
    this.driveStore?.selectedFileIds.set(new Set());
    if (options.refreshTargets !== false) await this.loadTargets({ force: true });
  }

  async goBack(): Promise<void> {
    const history = this.backHistory();
    if (history.length === 0) return;
    this.forwardHistory.update(items => [...items, this.location()]);
    this.backHistory.set(history.slice(0, -1));
    await this.restore(history[history.length - 1]);
  }

  async goForward(): Promise<void> {
    const history = this.forwardHistory();
    if (history.length === 0) return;
    this.backHistory.update(items => [...items, this.location()]);
    this.forwardHistory.set(history.slice(0, -1));
    await this.restore(history[history.length - 1]);
  }

  async goUp(): Promise<void> {
    const target = this.selectedTarget();
    if (!target) return;
    const path = this.folderPath();
    if (path.length === 0) {
      await this.showRoot();
      return;
    }
    this.pushHistory();
    const parentPath = path.slice(0, -1);
    this.folderPath.set(parentPath);
    this.currentFolderId.set(parentPath.length ? Number(parentPath[parentPath.length - 1].id) : null);
    this.forwardHistory.set([]);
    await this.loadPage(0);
  }

  async loadMore(): Promise<void> {
    if (!this.hasMore() || this.loading()) return;
    await this.loadPage(this.fileOffset(), true);
  }

  async navigateAddress(value: string): Promise<void> {
    const names = value.split(/[>/\\]/).map(part => part.trim()).filter(Boolean);
    if (names[0]?.toLowerCase() === 'nanika') names.shift();
    if (names[0]?.toLowerCase() === 'este computador') names.shift();
    if (names.length === 0) {
      await this.openHome();
      return;
    }
    const target = this.targets().find(item => item.label.toLowerCase() === names[0].toLowerCase());
    if (!target || target.status !== 'ready') return;
    await this.openTarget(target);
    for (const name of names.slice(1)) {
      const folder = this.files().find(item => item.isFolder && item.decryptedName?.toLowerCase() === name.toLowerCase());
      if (!folder) return;
      await this.openFolder(folder, false);
    }
  }

  async refresh(): Promise<void> {
    if (!this.selectedTarget()) return this.loadTargets({ force: true });
    await this.loadPage(0);
  }

  clearDecryptedPresentationData(): void {
    this.pageRequestId++;
    this.backHistory.set([]);
    this.forwardHistory.set([]);
    this.currentFolderId.set(null);
    this.folderPath.set([]);
    this.files.set([]);
    this.folderPreviewFiles.set([]);
    this.fileOffset.set(0);
    this.hasMore.set(false);
    this.loading.set(false);
    this.error.set(null);
  }

  private async loadPage(offset: number, append = false): Promise<void> {
    const target = this.selectedTarget();
    if (!target) return;
    const requestId = ++this.pageRequestId;
    const requestedFolderId = this.currentFolderId();
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await firstValueFrom(this.driveService.getStorageTree(
        target.provider, target.externalStorageId, requestedFolderId, 50, offset));
      const mapped = await this.mapPage(page, target);
      const folderPreviews = await Promise.all(mapped.filter(item => item.isFolder).map(folder => this.loadFolderPreview(folder, target)));
      if (requestId !== this.pageRequestId || this.selectedTarget()?.key !== target.key || this.currentFolderId() !== requestedFolderId) return;
      this.files.set(append ? [...this.files(), ...mapped.filter(item => !item.isFolder)] : mapped);
      this.folderPreviewFiles.set(append ? [...this.folderPreviewFiles(), ...folderPreviews.flat()] : folderPreviews.flat());
      this.fileOffset.set(offset + page.files.length);
      this.hasMore.set(page.has_more);
    } catch {
      if (requestId !== this.pageRequestId) return;
      this.error.set('Não foi possível abrir esta unidade.');
    } finally {
      if (requestId === this.pageRequestId) this.loading.set(false);
    }
  }

  private async loadFolderPreview(folder: DriveFile, target: StorageTarget): Promise<DriveFile[]> {
    try {
      const page = await firstValueFrom(this.driveService.getStorageTree(target.provider, target.externalStorageId, folder.id, 20, 0));
      const files = await this.mapPage(page, target);
      return files.filter(file => !file.isFolder && !file.isHidden && (file.type === 'image' || file.type === 'video'));
    } catch {
      return [];
    }
  }

  private async mapPage(page: StorageTreeResponse, target: StorageTarget): Promise<DriveFile[]> {
    const folders = await Promise.all(page.folders.map(async folder => ({
      id: folder.id,
      isFolder: true,
      encryptedName: folder.encrypted_name,
      decryptedName: this.cryptoService.isVaultUnlocked() ? await this.cryptoService.decryptName(folder.encrypted_name) : null,
      type: 'folder',
      sizeBytes: 0,
      sizeFormatted: '—',
      modifiedAt: '—',
      owner: 'eu',
      storageProvider: target.provider,
      externalStorageId: target.externalStorageId,
      parentId: folder.parent_id,
    } satisfies DriveFile)));
    const files = await Promise.all(page.files.map(async file => {
      const name = this.cryptoService.isVaultUnlocked() ? await this.cryptoService.decryptName(file.encrypted_name) : null;
      return {
        id: file.id,
        isFolder: false,
        encryptedName: file.encrypted_name,
        decryptedName: name,
        type: name ? resolveFilePreviewKind({ type: 'unknown', decryptedName: name, encryptedName: name, mimeType: file.mime_type }) : 'unknown',
        mimeType: file.mime_type,
        sizeBytes: file.size_bytes,
        sizeFormatted: formatBytes(file.size_bytes),
        modifiedAt: '—',
        owner: 'eu',
        encryptedFdk: file.encrypted_fdk,
        storageProvider: file.storage_provider,
        externalStorageId: file.external_storage_id,
        folderId: file.folder_id,
        isHidden: file.is_hidden,
      } satisfies DriveFile;
    }));
    return [...folders, ...files];
  }

  private location(): ComputerLocation {
    return { target: this.selectedTarget(), folderId: this.currentFolderId(), folders: this.folderPath() };
  }

  private pushHistory(): void {
    this.backHistory.update(items => [...items, this.location()]);
  }

  private async restore(location: ComputerLocation): Promise<void> {
    this.selectedTarget.set(location.target);
    this.currentFolderId.set(location.folderId);
    this.folderPath.set(location.folders);
    this.folderPreviewFiles.set([]);
    if (location.target) await this.loadPage(0);
    else this.files.set([]);
  }

}
