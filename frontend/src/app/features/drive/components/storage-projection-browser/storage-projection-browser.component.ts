import { Component, inject, output, signal } from '@angular/core';
import { DriveFile, DriveStore } from '../../state/drive.store';
import { ComputerStore } from '../../state/computer.store';
import { FilePreviewRequest } from '../../services/file-preview-resolver';

@Component({
  selector: 'app-storage-projection-browser',
  standalone: true,
  template: `
    <section class="projection" aria-label="Conteúdo da unidade">
      @if (computer.error()) {
        <div class="state" role="alert">{{ computer.error() }} <button (click)="computer.refresh()">Tentar novamente</button></div>
      } @else if (computer.loading() && computer.files().length === 0) {
        <div class="state" aria-live="polite">Carregando...</div>
      } @else if (computer.files().length === 0) {
        <div class="state">Esta unidade não possui arquivos Nanika nesta pasta.</div>
      } @else {
        <div class="items" [class.grid]="driveStore.displayMode() === 'grid'" role="listbox" aria-label="Arquivos e pastas">
          @for (file of computer.files(); track file.id) {
            <button class="item" [class.selected]="selectedId() === file.id" role="option" [attr.aria-selected]="selectedId() === file.id"
                    (click)="selectedId.set(file.id)" (dblclick)="open(file)" (keydown.enter)="open(file)"
                    (keydown.shift.f10)="openKeyboardMenu(file, $event)" (contextmenu)="openMenu(file, $event)">
              <span class="material-symbols-outlined icon">{{ icon(file) }}</span>
              <span class="name">{{ file.decryptedName || file.encryptedName }}</span>
              @if (!file.isFolder) { <span class="size">{{ file.sizeFormatted }}</span> }
            </button>
          }
        </div>
        @if (computer.hasMore()) { <button class="load-more" (click)="computer.loadMore()" [disabled]="computer.loading()">Carregar mais</button> }
      }
      @if (menuFile(); as file) {
        <div class="context-menu" [style.left.px]="menuX()" [style.top.px]="menuY()" role="menu">
          <button role="menuitem" (click)="preview(file)"><span class="material-symbols-outlined">preview</span> Visualizar</button>
          <button role="menuitem" (click)="download(file)"><span class="material-symbols-outlined">download</span> Baixar</button>
          <button role="menuitem" (click)="requestMove(file)"><span class="material-symbols-outlined">drive_file_move</span> Mover para...</button>
          @if (file.storageProvider === 'local') {
            <button role="menuitem" (click)="share(file)"><span class="material-symbols-outlined">share</span> Compartilhar</button>
          }
        </div>
      }
    </section>
  `,
  styles: [`
    :host { display: flex; flex: 1; min-width: 0; min-height: 0; }
    .projection { position: relative; flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 12px 16px 48px; }
    .items { display: grid; grid-template-columns: 1fr; }
    .items.grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
    .item { min-width: 0; display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 7px 10px; border: 1px solid transparent; border-radius: 3px; background: transparent; color: var(--default-text); text-align: left; }
    .grid .item { min-height: 110px; grid-template: 58px auto auto / 1fr; justify-items: center; text-align: center; }
    .item:hover { background: var(--default-hover); }
    .item.selected { background: var(--default-selected); border-color: var(--default-selected-border); }
    .icon { color: var(--default-folder); font-size: 26px; }
    .grid .icon { font-size: 54px; }
    .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
    .size { color: var(--default-muted); font-size: 12px; }
    .state { margin: 32px auto; color: var(--default-muted); text-align: center; }
    .state button, .load-more { margin: 8px; border: 1px solid var(--default-border-strong); border-radius: 4px; background: var(--default-surface); color: var(--default-text); padding: 6px 12px; }
    .context-menu { position: fixed; z-index: 1200; min-width: 180px; padding: 5px; border: 1px solid var(--default-context-border); border-radius: 5px; background: var(--default-context-bg); box-shadow: 0 8px 24px #0008; }
    .context-menu button { width: 100%; display: flex; align-items: center; gap: 8px; border: 0; border-radius: 3px; padding: 7px 9px; background: transparent; color: var(--default-context-text); text-align: left; }
    .context-menu button:hover { background: var(--default-context-hover); }
    .context-menu .material-symbols-outlined { font-size: 18px; }
  `],
  host: { '(document:click)': 'closeMenu()' },
})
export class StorageProjectionBrowserComponent {
  protected readonly computer = inject(ComputerStore);
  protected readonly driveStore = inject(DriveStore);
  readonly previewRequested = output<FilePreviewRequest>();
  readonly moveRequested = output<DriveFile>();
  readonly shareRequested = output<DriveFile>();
  readonly selectedId = signal<number | null>(null);
  readonly menuFile = signal<DriveFile | null>(null);
  readonly menuX = signal(0);
  readonly menuY = signal(0);

  open(file: DriveFile): void {
    if (file.isFolder) void this.computer.openFolder(file);
    else this.preview(file);
  }

  preview(file: DriveFile): void {
    if (file.isFolder) return;
    this.closeMenu();
    this.previewRequested.emit({ file, playlist: this.computer.files().filter(item => !item.isFolder) });
  }

  async download(file: DriveFile): Promise<void> {
    if (file.isFolder) return;
    this.closeMenu();
    await this.driveStore.downloadFile(file);
  }

  requestMove(file: DriveFile): void {
    this.closeMenu();
    if (!file.isFolder) this.moveRequested.emit(file);
  }

  share(file: DriveFile): void { this.closeMenu(); if (!file.isFolder && file.storageProvider === 'local') this.shareRequested.emit(file); }

  openMenu(file: DriveFile, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (file.isFolder) return;
    this.menuFile.set(file);
    this.menuX.set(Math.min(event.clientX, window.innerWidth - 200));
    this.menuY.set(Math.min(event.clientY, window.innerHeight - 170));
  }

  openKeyboardMenu(file: DriveFile, event: Event): void {
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (file.isFolder) return;
    this.menuFile.set(file);
    this.menuX.set(Math.min(rect.left + 20, window.innerWidth - 200));
    this.menuY.set(Math.min(rect.top + 20, window.innerHeight - 170));
  }

  closeMenu(): void { this.menuFile.set(null); }

  icon(file: DriveFile): string {
    if (file.isFolder) return 'folder';
    return ({ image: 'image', video: 'movie', audio: 'audio_file', pdf: 'picture_as_pdf' } as Record<string, string>)[file.type] ?? 'insert_drive_file';
  }
}
