import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AppStateService } from '../../../core/state/app-state.service';
import { DriveService } from '../services/drive.service';
import { DriveStore } from './drive.store';
import { PinnedFolderViewModel } from './pinned-folders.types';

@Injectable()
export class PinnedFoldersStore implements OnDestroy {
  private readonly driveService = inject(DriveService);
  private readonly driveStore = inject(DriveStore);
  private readonly appState = inject(AppStateService);

  private readonly ids = signal<number[]>([]);
  private readonly pending = signal<Set<number>>(new Set());
  private loadPromise?: Promise<void>;

  readonly pinnedFolderIds = this.ids.asReadonly();
  readonly pendingFolderIds = this.pending.asReadonly();
  readonly isLoading = signal(false);
  readonly error = signal<string | null>(null);

  readonly pinnedFolders = computed<readonly PinnedFolderViewModel[]>(() => {
    const files = new Map(this.driveStore.files().filter(file => file.isFolder).map(file => [file.id, file]));
    const locked = this.appState.isLocked();
    return this.ids().map((id, position) => {
      const folder = files.get(id);
      return {
        id,
        position,
        name: locked ? 'Pasta protegida' : folder?.decryptedName || (folder ? 'Pasta indisponível' : 'Pasta indisponível'),
        available: !!folder,
        locked,
      };
    });
  });

  async load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.isLoading.set(true);
    this.error.set(null);
    this.loadPromise = firstValueFrom(this.driveService.getPinnedFolders())
      .then(response => {
        this.ids.set([...response.folders]
          .sort((a, b) => a.position - b.position)
          .map(folder => folder.folder_id));
      })
      .catch(error => {
        this.error.set('Não foi possível carregar as pastas fixadas.');
        console.error('Failed to load pinned folders', error);
      })
      .finally(() => {
        this.isLoading.set(false);
        this.loadPromise = undefined;
      });
    return this.loadPromise;
  }

  async pin(folderId: number): Promise<void> {
    if (this.appState.isLocked() || this.isPinned(folderId) || this.isPending(folderId)) return;
    this.setPending(folderId, true);
    try {
      await firstValueFrom(this.driveService.pinFolder(folderId));
      this.ids.update(ids => ids.includes(folderId) ? ids : [...ids, folderId]);
      this.error.set(null);
    } catch (error) {
      this.error.set('Não foi possível fixar a pasta.');
      throw error;
    } finally {
      this.setPending(folderId, false);
    }
  }

  async unpin(folderId: number): Promise<void> {
    if (!this.isPinned(folderId) || this.isPending(folderId)) return;
    this.setPending(folderId, true);
    try {
      await firstValueFrom(this.driveService.unpinFolder(folderId));
      this.ids.update(ids => ids.filter(id => id !== folderId));
      this.error.set(null);
    } catch (error) {
      this.error.set('Não foi possível desafixar a pasta.');
      throw error;
    } finally {
      this.setPending(folderId, false);
    }
  }

  async reorder(folderIds: readonly number[]): Promise<void> {
    const current = this.ids();
    if (folderIds.length !== current.length || new Set(folderIds).size !== folderIds.length ||
        folderIds.some(id => !current.includes(id)) || current.some(id => !folderIds.includes(id))) return;
    if (folderIds.some(id => this.isPending(id))) return;

    for (const id of folderIds) this.setPending(id, true);
    try {
      await firstValueFrom(this.driveService.reorderPinnedFolders(folderIds));
      this.ids.set([...folderIds]);
      this.error.set(null);
    } catch (error) {
      this.error.set('Não foi possível reordenar as pastas fixadas.');
      throw error;
    } finally {
      for (const id of folderIds) this.setPending(id, false);
    }
  }

  isPinned(folderId: number): boolean {
    return this.ids().includes(folderId);
  }

  isPending(folderId: number): boolean {
    return this.pending().has(folderId);
  }

  clear(): void {
    this.ids.set([]);
    this.pending.set(new Set());
    this.error.set(null);
    this.loadPromise = undefined;
  }

  ngOnDestroy(): void {
    this.clear();
  }

  private setPending(folderId: number, value: boolean): void {
    this.pending.update(ids => {
      const next = new Set(ids);
      value ? next.add(folderId) : next.delete(folderId);
      return next;
    });
  }
}
