import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { DriveService, StorageTreeResponse } from '../services/drive.service';
import { resolveFilePreviewKind } from '../services/file-preview-resolver';
import { DriveFile } from './drive.store';
import { StorageTarget } from './drive.types';

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
  private readonly backHistory = signal<ComputerLocation[]>([]);
  private readonly forwardHistory = signal<ComputerLocation[]>([]);
  private readonly folderPath = signal<readonly ComputerPathSegment[]>([]);

  readonly targets = signal<StorageTarget[]>([]);
  readonly selectedTarget = signal<StorageTarget | null>(null);
  readonly currentFolderId = signal<number | null>(null);
  readonly files = signal<DriveFile[]>([]);
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

  async loadTargets(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.targets.set(await firstValueFrom(this.driveService.getStorageTargets()));
    } catch {
      this.error.set('Não foi possível carregar os dispositivos e unidades.');
    } finally {
      this.loading.set(false);
    }
  }

  async openTarget(target: StorageTarget, recordHistory = true): Promise<void> {
    if (target.status !== 'ready') return;
    if (recordHistory) this.pushHistory();
    this.selectedTarget.set(target);
    this.currentFolderId.set(null);
    this.folderPath.set([]);
    this.forwardHistory.set([]);
    await this.loadPage(0);
  }

  async openFolder(folder: DriveFile, recordHistory = true): Promise<void> {
    if (!folder.isFolder || !this.selectedTarget()) return;
    if (recordHistory) this.pushHistory();
    this.currentFolderId.set(folder.id);
    this.folderPath.update(path => [...path, { id: folder.id, name: folder.decryptedName ?? folder.encryptedName }]);
    this.forwardHistory.set([]);
    await this.loadPage(0);
  }

  async showRoot(recordHistory = true): Promise<void> {
    if (recordHistory && this.selectedTarget()) this.pushHistory();
    this.selectedTarget.set(null);
    this.currentFolderId.set(null);
    this.folderPath.set([]);
    this.files.set([]);
    this.forwardHistory.set([]);
    if (this.targets().length === 0) await this.loadTargets();
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
      await this.showRoot();
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
    if (!this.selectedTarget()) return this.loadTargets();
    await this.loadPage(0);
  }

  private async loadPage(offset: number, append = false): Promise<void> {
    const target = this.selectedTarget();
    if (!target) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await firstValueFrom(this.driveService.getStorageTree(
        target.provider, target.externalStorageId, this.currentFolderId(), 50, offset));
      const mapped = await this.mapPage(page, target);
      this.files.set(append ? [...this.files(), ...mapped.filter(item => !item.isFolder)] : mapped);
      this.fileOffset.set(offset + page.files.length);
      this.hasMore.set(page.has_more);
    } catch {
      this.error.set('Não foi possível abrir esta unidade.');
      if (!append) this.files.set([]);
    } finally {
      this.loading.set(false);
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
        sizeFormatted: this.formatSize(file.size_bytes),
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
    if (location.target) await this.loadPage(0);
    else this.files.set([]);
  }

  private formatSize(bytes: number): string {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${Number((bytes / 1024 ** index).toFixed(1))} ${units[index]}`;
  }
}
