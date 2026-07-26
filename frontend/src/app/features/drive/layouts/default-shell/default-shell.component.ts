import { Component, input, output, signal } from '@angular/core';
import { TopbarComponent } from '../../components/topbar/topbar.component';
import { DriveWorkspaceComponent } from '../../components/drive-workspace/drive-workspace.component';
import { DriveFile, QuotaState } from '../../state/drive.store';
import { DriveView } from '../../state/drive.types';
import { PinnedFoldersSectionComponent } from '../../components/pinned-folders-section/pinned-folders-section.component';
import { DroppedItems } from '../../services/data-transfer-reader.service';

interface BreadcrumbSegment {
  id: number | null;
  name: string;
}

@Component({
  selector: 'app-default-shell',
  standalone: true,
  imports: [DriveWorkspaceComponent, PinnedFoldersSectionComponent, TopbarComponent],
  template: `
    <div class="default-shell">
      <header class="explorer-titlebar">
        <div class="window-title"><span class="material-symbols-outlined">folder</span> Nanika</div>
        <div class="window-actions" aria-hidden="true"><span>—</span><span>□</span><span>×</span></div>
      </header>

      <div class="explorer-toolbar">
        <button class="toolbar-icon" [disabled]="!canGoBack()" (click)="backRequested.emit()" aria-label="Voltar"><span class="material-symbols-outlined">arrow_back</span></button>
        <button class="toolbar-icon" [disabled]="!canGoForward()" (click)="forwardRequested.emit()" aria-label="Avançar"><span class="material-symbols-outlined">arrow_forward</span></button>
        <button class="toolbar-icon" [disabled]="!canGoUp()" (click)="upRequested.emit()" aria-label="Subir"><span class="material-symbols-outlined">arrow_upward</span></button>
        <div class="address-bar" (click)="startAddressEdit()">
          <span class="material-symbols-outlined">folder</span>
          @if (addressEditing()) {
            <button class="address-root" (click)="$event.stopPropagation()">Nanika/</button>
            <input #addressInput [value]="addressValue()" (click)="$event.stopPropagation()" (input)="addressValue.set(addressInput.value)" (keydown.enter)="submitAddress()" (keydown.escape)="resetAddress()" aria-label="Barra de endereço" autofocus />
          } @else {
            <button class="address-segment address-root" (click)="navigateAddressSegment(null); $event.stopPropagation()">Nanika</button>
            @for (segment of currentPath().slice(1); track segment.id) {
              <span class="address-separator" aria-hidden="true">&gt;</span>
              <button class="address-segment" [class.current]="$last" [disabled]="$last" (click)="navigateAddressSegment(segment.id); $event.stopPropagation()">{{ segment.name }}</button>
            }
          }
        </div>
        <button class="toolbar-action" (click)="uploadFileRequested.emit()" aria-label="Novo upload"><span class="material-symbols-outlined">upload</span> Upload</button>
        <button class="toolbar-action" [disabled]="locked()" (click)="uploadFolderRequested.emit()" aria-label="Upload de pasta"><span class="material-symbols-outlined">drive_folder_upload</span> Pasta</button>
        <button class="toolbar-action" (click)="createFolderRequested.emit()" aria-label="Nova pasta"><span class="material-symbols-outlined">create_new_folder</span> Nova pasta</button>
        @if (locked()) {
          <button class="toolbar-action" (click)="unlockRequested.emit()" aria-label="Desbloquear"><span class="material-symbols-outlined">lock_open</span> Desbloquear</button>
        } @else {
          <button class="toolbar-icon" (click)="lockRequested.emit()" aria-label="Trancar Drive" title="Trancar Drive"><span class="material-symbols-outlined">lock</span></button>
        }
        <app-topbar [compact]="true" />
      </div>

      <div class="explorer-body">
        <aside class="explorer-sidebar" aria-label="Navegação do Explorer">
          <button class="explorer-nav" [class.active]="currentView() === 'drive'" (click)="changeView('drive')"><span class="material-symbols-outlined">home</span> Meu Drive</button>
          <button class="explorer-nav" [class.active]="currentView() === 'storage'" (click)="changeView('storage')"><span class="material-symbols-outlined">computer</span> Este Computador</button>
          <app-pinned-folders-section
            [currentFolderId]="currentFolderId()"
            [locked]="locked()"
            [showTitle]="false"
            variant="default"
            (navigate)="pinnedFolderNavigate.emit($event)" />
          <div class="sidebar-heading">Nanika</div>
          <button class="explorer-nav" [class.active]="currentView() === 'trash'" (click)="changeView('trash')"><span class="material-symbols-outlined">delete</span> Lixeira</button>
          <button class="explorer-nav" [class.active]="currentView() === 'transfers'" (click)="changeView('transfers')"><span class="material-symbols-outlined">sync</span> Transferências</button>
          <div class="storage-summary">
            <div>Armazenamento</div>
            <div class="storage-track"><span [style.width.%]="quotaPercent()"></span></div>
            <small>{{ formatSize(quota().usedBytes) }} de {{ formatSize(quota().maxBytes) }}</small>
            @if (quota().gdriveMaxBytes && quota().gdriveMaxBytes! > 0) {
              <div class="storage-provider-label">Google Drive</div>
              <div class="storage-track gdrive"><span [style.width.%]="gdriveQuotaPercent()"></span></div>
              <small>{{ formatSize(quota().gdriveUsedBytes || 0) }} de {{ formatSize(quota().gdriveMaxBytes!) }}</small>
            }
          </div>
        </aside>

        <main class="explorer-content">
          <app-drive-workspace
            [currentView]="currentView()"
            [locked]="locked()"
            (createFolderRequested)="createFolderRequested.emit()"
            (uploadFileRequested)="uploadFileRequested.emit()"
            (videoSelected)="videoSelected.emit($event)"
            (imageSelected)="imageSelected.emit($event)"
            (shareRequested)="shareRequested.emit($event)"
            (emptyTrashRequested)="emptyTrashRequested.emit()"
            (dropStarted)="dropStarted.emit()"
            (externalDrop)="externalDrop.emit($event)"
            (dropError)="dropError.emit($event)" />
          <ng-content />
        </main>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100vh; color: var(--text-primary); }
    .default-shell { height: 100%; display: flex; flex-direction: column; background: var(--default-window-bg); font-family: 'Segoe UI', sans-serif; }
    .explorer-titlebar { height: 40px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px 0 16px; background: var(--default-titlebar-bg); border-bottom: 1px solid var(--default-border); }
    .window-title { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .window-title .material-symbols-outlined { color: var(--default-accent); font-size: 18px; }
    .window-actions { display: flex; gap: 20px; color: var(--default-muted); font-size: 16px; }
    .explorer-toolbar { min-height: 52px; display: flex; align-items: center; gap: 6px; padding: 8px 12px; background: var(--default-toolbar-bg); border-bottom: 1px solid var(--default-border); }
    .toolbar-icon, .toolbar-action { border: 1px solid transparent; background: transparent; border-radius: 4px; color: var(--default-muted); min-height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; }
    .toolbar-icon:not(:disabled):hover, .toolbar-action:hover { background: var(--default-hover); border-color: var(--default-border); color: var(--default-text); }
    .toolbar-icon:disabled { opacity: .45; cursor: default; }
    .toolbar-action { color: var(--default-text); font-size: 12px; }
    .toolbar-icon .material-symbols-outlined, .toolbar-action .material-symbols-outlined { font-size: 18px; }
    .address-bar { flex: 1; min-width: 120px; height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 10px; background: var(--default-surface); border: 1px solid var(--default-border-strong); border-radius: 4px; color: var(--default-muted); font-size: 12px; }
    .address-bar .material-symbols-outlined { font-size: 16px; color: var(--default-accent); }
    .address-segment, .address-root { border: 0; padding: 0; background: transparent; color: var(--default-muted); font: inherit; white-space: nowrap; }
    .address-segment:not(:disabled):hover { color: var(--default-accent); text-decoration: underline; cursor: pointer; }
    .address-segment.current { color: var(--default-text); cursor: default; }
    .address-separator { color: var(--default-muted); }
    .address-bar input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; }
    .explorer-body { flex: 1; min-height: 0; display: flex; }
    .explorer-sidebar { width: 220px; flex-shrink: 0; padding: 12px 8px; background: var(--default-sidebar-bg); border-right: 1px solid var(--default-border); overflow-y: auto; }
    .sidebar-heading { padding: 8px 12px 5px; color: var(--default-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .explorer-nav { width: 100%; display: flex; align-items: center; gap: 10px; border: 0; border-radius: 4px; padding: 8px 12px; background: transparent; color: var(--default-text); text-align: left; font-size: 13px; }
    .explorer-nav:hover, .explorer-nav.active { background: var(--default-hover); }
    .explorer-nav.active { color: var(--default-accent); font-weight: 600; }
    .explorer-nav .material-symbols-outlined { font-size: 18px; }
    .storage-summary { margin: 24px 12px 0; color: var(--default-muted); font-size: 11px; }
    .storage-track { height: 4px; margin: 7px 0 4px; background: var(--default-border); border-radius: 2px; overflow: hidden; }
    .storage-track span { display: block; height: 100%; background: var(--default-accent); }
    .storage-track.gdrive { background: #dbe7df; }
    .storage-track.gdrive span { background: #34a853; }
    .storage-provider-label { margin-top: 12px; }
    .explorer-content { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; position: relative; overflow: hidden; background: var(--default-content-bg); }
    .explorer-content ::ng-deep .content-inner { border-radius: 0; }
    @media (max-width: 680px) { .explorer-sidebar { display: none; } .toolbar-action { padding: 0 4px; font-size: 0; } }
  `],
})
export class DefaultShellComponent {
  readonly currentView = input.required<DriveView>();
  readonly currentFolderId = input<number | null>(null);
  readonly currentPath = input<readonly BreadcrumbSegment[]>([{ id: null, name: 'Meu Drive' }]);
  readonly canGoBack = input(false);
  readonly canGoForward = input(false);
  readonly canGoUp = input(false);
  readonly locked = input(false);
  readonly quota = input.required<QuotaState>();
  readonly unlockRequested = output<void>();
  readonly lockRequested = output<void>();
  readonly viewChange = output<DriveView>();
  readonly createFolderRequested = output<void>();
  readonly uploadFileRequested = output<void>();
  readonly uploadFolderRequested = output<void>();
  readonly pinnedFolderNavigate = output<number>();
  readonly videoSelected = output<DriveFile>();
  readonly imageSelected = output<{ file: DriveFile; playlist: DriveFile[] }>();
  readonly shareRequested = output<DriveFile>();
  readonly emptyTrashRequested = output<void>();
  readonly externalDrop = output<DroppedItems>();
  readonly dropStarted = output<void>();
  readonly dropError = output<unknown>();
  readonly backRequested = output<void>();
  readonly forwardRequested = output<void>();
  readonly upRequested = output<void>();
  readonly addressNavigate = output<string>();
  readonly addressValue = signal('');
  readonly addressEditing = signal(false);

  changeView(view: DriveView): void {
    this.viewChange.emit(view);
  }

  quotaPercent(): number {
    const quota = this.quota();
    return quota.maxBytes ? Math.min((quota.usedBytes / quota.maxBytes) * 100, 100) : 0;
  }

  gdriveQuotaPercent(): number {
    const quota = this.quota();
    return quota.gdriveMaxBytes ? Math.min(((quota.gdriveUsedBytes || 0) / quota.gdriveMaxBytes) * 100, 100) : 0;
  }

  submitAddress(): void {
    const path = this.addressValue().trim();
    this.addressEditing.set(false);
    this.addressNavigate.emit(path ? `Nanika/${path}` : 'Nanika');
  }

  resetAddress(): void {
    this.addressEditing.set(false);
  }

  startAddressEdit(): void {
    if (this.addressEditing()) return;
    this.addressValue.set(this.currentPath().slice(1).map(segment => segment.name).join('/'));
    this.addressEditing.set(true);
  }

  navigateAddressSegment(folderId: number | null): void {
    this.addressEditing.set(false);
    if (folderId === null) {
      this.addressNavigate.emit('Nanika');
      return;
    }
    const segmentIndex = this.currentPath().findIndex(segment => segment.id === folderId);
    const path = this.currentPath().slice(1, segmentIndex + 1).map(segment => segment.name).join('/');
    this.addressNavigate.emit(path ? `Nanika/${path}` : 'Nanika');
  }

  formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
    return `${parseFloat((bytes / Math.pow(1024, index)).toFixed(1))} ${sizes[index]}`;
  }
}
