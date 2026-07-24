import { Component, input, output } from '@angular/core';
import { DriveWorkspaceComponent } from '../../components/drive-workspace/drive-workspace.component';
import { DriveFile, QuotaState } from '../../state/drive.store';
import { DriveView } from '../../state/drive.types';

@Component({
  selector: 'app-default-shell',
  standalone: true,
  imports: [DriveWorkspaceComponent],
  template: `
    <div class="default-shell">
      <header class="explorer-titlebar">
        <div class="window-title"><span class="material-symbols-outlined">folder</span> Nanika</div>
        <div class="window-actions" aria-hidden="true"><span>—</span><span>□</span><span>×</span></div>
      </header>

      <div class="explorer-toolbar">
        <button class="toolbar-icon" disabled aria-label="Voltar"><span class="material-symbols-outlined">arrow_back</span></button>
        <button class="toolbar-icon" disabled aria-label="Avançar"><span class="material-symbols-outlined">arrow_forward</span></button>
        <button class="toolbar-icon" disabled aria-label="Subir"><span class="material-symbols-outlined">arrow_upward</span></button>
        <div class="address-bar"><span class="material-symbols-outlined">folder</span><span>Este Computador &gt; Nanika</span></div>
        <button class="toolbar-action" (click)="uploadFileRequested.emit()" aria-label="Novo upload"><span class="material-symbols-outlined">upload</span> Upload</button>
        <button class="toolbar-action" (click)="createFolderRequested.emit()" aria-label="Nova pasta"><span class="material-symbols-outlined">create_new_folder</span> Nova pasta</button>
        @if (locked()) { <button class="toolbar-action" (click)="unlockRequested.emit()" aria-label="Desbloquear"><span class="material-symbols-outlined">lock_open</span> Desbloquear</button> }
      </div>

      <div class="explorer-body">
        <aside class="explorer-sidebar" aria-label="Navegação do Explorer">
          <div class="sidebar-heading">Acesso rápido</div>
          <button class="explorer-nav" [class.active]="currentView() === 'drive'" (click)="changeView('drive')"><span class="material-symbols-outlined">home</span> Meu Drive</button>
          <button class="explorer-nav" [class.active]="currentView() === 'storage'" (click)="changeView('storage')"><span class="material-symbols-outlined">computer</span> Este Computador</button>
          <div class="sidebar-heading">Nanika</div>
          <button class="explorer-nav" [class.active]="currentView() === 'trash'" (click)="changeView('trash')"><span class="material-symbols-outlined">delete</span> Lixeira</button>
          <button class="explorer-nav" [class.active]="currentView() === 'transfers'" (click)="changeView('transfers')"><span class="material-symbols-outlined">sync</span> Transferências</button>
          <div class="storage-summary">
            <div>Armazenamento</div>
            <div class="storage-track"><span [style.width.%]="quotaPercent()"></span></div>
            <small>{{ quota().usedBytes }} de {{ quota().maxBytes }} bytes</small>
          </div>
        </aside>

        <main class="explorer-content">
          <app-drive-workspace
            [currentView]="currentView()"
            (createFolderRequested)="createFolderRequested.emit()"
            (uploadFileRequested)="uploadFileRequested.emit()"
            (videoSelected)="videoSelected.emit($event)"
            (imageSelected)="imageSelected.emit($event)"
            (shareRequested)="shareRequested.emit($event)"
            (emptyTrashRequested)="emptyTrashRequested.emit()" />
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
    .explorer-content { min-width: 0; min-height: 0; flex: 1; display: flex; flex-direction: column; position: relative; overflow: hidden; background: var(--default-content-bg); }
    .explorer-content ::ng-deep .content-inner { border-radius: 0; }
    @media (max-width: 680px) { .explorer-sidebar { display: none; } .toolbar-action { padding: 0 4px; font-size: 0; } }
  `],
})
export class DefaultShellComponent {
  readonly currentView = input.required<DriveView>();
  readonly locked = input(false);
  readonly quota = input.required<QuotaState>();
  readonly unlockRequested = output<void>();
  readonly viewChange = output<DriveView>();
  readonly createFolderRequested = output<void>();
  readonly uploadFileRequested = output<void>();
  readonly videoSelected = output<DriveFile>();
  readonly imageSelected = output<{ file: DriveFile; playlist: DriveFile[] }>();
  readonly shareRequested = output<DriveFile>();
  readonly emptyTrashRequested = output<void>();

  changeView(view: DriveView): void {
    this.viewChange.emit(view);
  }

  quotaPercent(): number {
    const quota = this.quota();
    return quota.maxBytes ? Math.min((quota.usedBytes / quota.maxBytes) * 100, 100) : 0;
  }
}
