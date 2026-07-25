import { Component, HostListener, inject, input, output, signal } from '@angular/core';
import { DialogService } from '../../../../core/dialog/dialog.service';
import { DriveStore } from '../../state/drive.store';
import { PinnedFoldersStore } from '../../state/pinned-folders.store';

@Component({
  selector: 'app-pinned-folders-section',
  standalone: true,
  template: `
    @if (store.isLoading() || store.pinnedFolders().length > 0 || store.error()) {
      <section class="pinned-section" [class.default-variant]="variant() === 'default'" aria-labelledby="pinned-title">
        @if (showTitle()) {
          <h2 id="pinned-title" class="pinned-title">{{ variant() === 'default' ? 'Acesso rápido' : 'Pastas fixadas' }}</h2>
        }
        @if (store.isLoading()) {
          <div class="pinned-loading" role="status">Carregando...</div>
        }
        @for (folder of store.pinnedFolders(); track folder.id) {
          <button class="pinned-item"
                  [class.active]="folder.id === currentFolderId()"
                  [disabled]="locked() || folder.locked || !folder.available || store.isPending(folder.id)"
                  [attr.aria-current]="folder.id === currentFolderId() ? 'page' : null"
                  [attr.aria-label]="folder.available ? folder.name : folder.name + ', indisponível'"
                  (click)="navigate.emit(folder.id)"
                  (contextmenu)="openContextMenu(folder.id, folder, $event)">
            <span class="material-symbols-outlined" aria-hidden="true">folder</span>
            <span class="pinned-name">{{ folder.name }}</span>
          </button>
        }
        @if (store.error()) {
          <p class="pinned-error" role="status">{{ store.error() }}</p>
        }
        @if (contextMenuFolderId() !== null && contextMenuPosition()) {
          <div class="action-menu"
               [style.top.px]="contextMenuPosition()?.y"
               [style.left.px]="contextMenuPosition()?.x"
               (click)="$event.stopPropagation()">
            <button class="menu-item" (click)="onRename(contextMenuFolderId()!, $event)">
              <span class="material-symbols-outlined">edit</span>
              Renomear
            </button>
            <button class="menu-item" [disabled]="store.isPending(contextMenuFolderId()!)" (click)="onUnpin(contextMenuFolderId()!, $event)">
              <span class="material-symbols-outlined">push_pin</span>
              Desafixar do acesso rápido
            </button>
            <div class="menu-divider"></div>
            <button class="menu-item delete-item" (click)="onDelete(contextMenuFolderId()!, $event)">
              <span class="material-symbols-outlined">delete</span>
              Mover para a lixeira
            </button>
          </div>
        }
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .pinned-section { margin: 4px 0 10px; }
    .pinned-title { margin: 0; padding: 7px 16px 4px; color: #5f6368; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
    .pinned-item { width: 100%; display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 7px 16px; border: 0; border-radius: 18px; background: transparent; color: #202124; text-align: left; cursor: pointer; font: inherit; }
    .pinned-item:hover:not(:disabled) { background: #f1f3f4; }
    .pinned-item.active { background: #c2e7ff; color: #001d35; }
    .pinned-item:disabled { cursor: default; opacity: .7; }
    .pinned-item .material-symbols-outlined { font-size: 18px; }
    .pinned-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pinned-loading, .pinned-error { padding: 4px 16px; color: #5f6368; font-size: 11px; }
    .pinned-error { color: #b3261e; }
    .default-variant .pinned-item { border-radius: 4px; color: var(--default-text); }
    .default-variant .pinned-item:hover:not(:disabled), .default-variant .pinned-item.active { background: var(--default-hover); }
    .default-variant .pinned-item.active { color: var(--default-accent); }
    .default-variant .pinned-title { color: var(--default-muted); }
    .default-variant .pinned-item { padding-left: 12px; }
    .action-menu { position: fixed; min-width: 200px; z-index: 1000; display: flex; flex-direction: column; padding: 6px 0; background: var(--surface, #fff); border-radius: 8px; box-shadow: 0 1px 3px rgba(60,64,67,.3), 0 4px 8px 3px rgba(60,64,67,.15); }
    .menu-item { width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px 16px; border: 0; background: transparent; color: var(--text-primary, #3c4043); text-align: left; font: inherit; cursor: pointer; }
    .menu-item:hover:not(:disabled) { background: var(--surface-hover, #f1f3f4); }
    .menu-item:disabled { cursor: default; opacity: .6; }
    .menu-item .material-symbols-outlined { font-size: 20px; color: var(--text-secondary, #5f6368); }
    .delete-item { color: #d93025; }
    .delete-item .material-symbols-outlined { color: #d93025; }
    .menu-divider { height: 1px; margin: 4px 0; background: #e8eaed; }
  `],
})
export class PinnedFoldersSectionComponent {
  readonly store = inject(PinnedFoldersStore);
  private readonly driveStore = inject(DriveStore);
  private readonly dialogService = inject(DialogService);
  readonly currentFolderId = input<number | null>(null);
  readonly locked = input(false);
  readonly showTitle = input(true);
  readonly variant = input<'gdrive' | 'default'>('gdrive');
  readonly navigate = output<number>();
  readonly contextMenuFolderId = signal<number | null>(null);
  readonly contextMenuPosition = signal<{ x: number; y: number } | null>(null);

  openContextMenu(folderId: number, folder: { available: boolean; locked: boolean }, event: MouseEvent): void {
    if (this.locked() || folder.locked || !folder.available) return;
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 220;
    const menuHeight = 150;
    this.contextMenuPosition.set({
      x: Math.min(event.clientX, window.innerWidth - menuWidth - 10),
      y: Math.min(event.clientY, window.innerHeight - menuHeight - 10),
    });
    this.contextMenuFolderId.set(folderId);
  }

  @HostListener('document:click')
  closeContextMenu(): void {
    this.contextMenuFolderId.set(null);
    this.contextMenuPosition.set(null);
  }

  async onRename(folderId: number, event: Event): Promise<void> {
    event.stopPropagation();
    this.closeContextMenu();
    const file = this.driveStore.files().find(item => item.id === folderId && item.isFolder);
    if (!file) return;
    const currentName = file.decryptedName || file.encryptedName;
    const newName = await this.dialogService.prompt('Renomear', currentName, 'Nome da pasta', 'OK');
    if (!newName || newName === currentName) return;
    try {
      await this.driveStore.renameItem(file, newName);
    } catch (error: any) {
      alert(error?.status === 409 ? 'Uma pasta com este nome já existe nesta localização.' : 'Erro ao renomear');
    }
  }

  async onUnpin(folderId: number, event: Event): Promise<void> {
    event.stopPropagation();
    this.closeContextMenu();
    try {
      await this.store.unpin(folderId);
    } catch (error) {
      console.error('Erro ao desafixar pasta', error);
    }
  }

  async onDelete(folderId: number, event: Event): Promise<void> {
    event.stopPropagation();
    this.closeContextMenu();
    const file = this.driveStore.files().find(item => item.id === folderId && item.isFolder);
    if (!file) return;
    const confirmed = await this.dialogService.confirm(
      'Mover para a lixeira?',
      `Tem certeza de que deseja mover "${file.decryptedName || file.encryptedName}" para a lixeira?`,
      'Mover para a lixeira',
    );
    if (!confirmed) return;
    try {
      await this.driveStore.trashItem(file);
    } catch (error) {
      alert('Erro ao mover para a lixeira');
    }
  }
}
