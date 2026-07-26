import { Component, HostListener, input, output, signal } from '@angular/core';
import { QuotaState } from '../../state/drive.store';
import { DriveView } from '../../state/drive.types';
import { PinnedFoldersSectionComponent } from '../pinned-folders-section/pinned-folders-section.component';

@Component({
  selector: 'app-gdrive-sidebar',
  standalone: true,
  imports: [PinnedFoldersSectionComponent],
  template: `
    <nav class="sidebar">
      <div class="new-dropdown-container">
        <button class="new-btn" id="new-btn" (click)="toggleNewMenu()" [disabled]="locked()">
          <span class="material-symbols-outlined">add</span>
          Novo
        </button>

        @if (isNewMenuOpen()) {
          <div class="new-dropdown">
            <button class="dropdown-item" (click)="createFolder()">
              <span class="material-symbols-outlined">create_new_folder</span>
              Nova pasta
            </button>
            <div class="dropdown-divider"></div>
            <button class="dropdown-item" (click)="uploadFile()">
              <span class="material-symbols-outlined">upload_file</span>
              Upload de ficheiro
            </button>
            <button class="dropdown-item" (click)="uploadFolder()">
              <span class="material-symbols-outlined">drive_folder_upload</span>
              Upload de pasta
            </button>
          </div>
        }
      </div>

      <div class="nav-group">
        <button class="nav-item" [class.active]="currentView() === 'drive'" (click)="changeView('drive')" id="nav-my-vault">
          <span class="material-symbols-outlined">folder</span>
          Meu Drive
        </button>
        <button class="nav-item" id="nav-shared">
          <span class="material-symbols-outlined">group</span>
          Compartilhados
        </button>
        <button class="nav-item" id="nav-recent">
          <span class="material-symbols-outlined">schedule</span>
          Recentes
        </button>
        <button class="nav-item" [class.active]="currentView() === 'trash'" (click)="changeView('trash')" id="nav-trash">
          <span class="material-symbols-outlined">delete</span>
          Lixeira
        </button>
        <button class="nav-item" [class.active]="currentView() === 'transfers'" (click)="changeView('transfers')">
          <span class="material-symbols-outlined">pending_actions</span>
          Pendentes
        </button>
        <button class="nav-item" [class.active]="currentView() === 'storage'" (click)="changeView('storage')">
          <span class="material-symbols-outlined">cloud</span>
          Armazenamento
        </button>
      </div>

      <app-pinned-folders-section
        [currentFolderId]="currentFolderId()"
        [locked]="locked()"
        variant="gdrive"
        (navigate)="pinnedFolderNavigate.emit($event)" />

      <div class="sidebar-divider"></div>

      <div class="storage-quota-container">
        <div class="storage-section-title">Nanika</div>
        <div class="storage-bar-track">
          <div class="storage-bar-fill" [style.width.%]="getQuotaPercent()"></div>
        </div>
        <span class="storage-used">{{ getQuotaFormatted() }}</span>

        @if (quota().gdriveMaxBytes && quota().gdriveMaxBytes! > 0) {
          <div class="storage-divider" style="margin: 8px 0 4px; height: 1px; background: #dadce0;"></div>
          <div class="storage-section-title">Google Drive</div>
          <div class="storage-bar-track gdrive">
            <div class="storage-bar-fill gdrive-fill" [style.width.%]="getGDriveQuotaPercent()"></div>
          </div>
          <span class="storage-used">{{ getGDriveQuotaFormatted() }}</span>
        }
      </div>
    </nav>
  `,
  styles: [`
    .sidebar { grid-area: sidebar; padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
    .new-btn { display: flex; align-items: center; gap: 12px; padding: 14px 24px; background: white; border: none; border-radius: 16px; box-shadow: 0 1px 2px 0 rgba(60, 64, 67, 0.3), 0 1px 3px 1px rgba(60, 64, 67, 0.15); cursor: pointer; font-size: 14px; font-weight: 500; font-family: 'Roboto', sans-serif; color: #202124; margin-bottom: 16px; transition: box-shadow 250ms cubic-bezier(0.4, 0, 0.2, 1), background 150ms ease; width: fit-content; }
    .new-btn:hover { box-shadow: 0 1px 3px 0 rgba(60, 64, 67, 0.3), 0 4px 8px 3px rgba(60, 64, 67, 0.15); background: #fdfdfd; }
    .new-btn .material-symbols-outlined { font-size: 26px; color: #1a73e8; }
    .new-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .new-dropdown-container { position: relative; margin-bottom: 16px; }
    .new-dropdown { position: absolute; top: 100%; left: 0; margin-top: 4px; background: #ffffff; border: 1px solid #dadce0; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1), 0 1px 3px rgba(0,0,0,0.08); min-width: 200px; display: flex; flex-direction: column; padding: 8px 0; z-index: 100; animation: fadeIn 0.2s ease; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
    .dropdown-item { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border: none; background: transparent; text-align: left; font-size: 14px; color: #3c4043; cursor: pointer; transition: background 0.2s; font-family: 'Roboto', sans-serif; }
    .dropdown-item:hover { background: #f1f3f4; }
    .dropdown-item .material-symbols-outlined { font-size: 20px; color: #5f6368; }
    .dropdown-divider { height: 1px; background: #e0e0e0; margin: 4px 0; }
    .nav-group { display: flex; flex-direction: column; gap: 2px; }
    .nav-item { display: flex; align-items: center; gap: 14px; padding: 8px 16px; border-radius: 24px; border: none; background: transparent; cursor: pointer; font-size: 14px; font-family: 'Roboto', sans-serif; color: #202124; width: 100%; text-align: left; transition: background 150ms ease; height: 40px; }
    .nav-item:hover { background: #e8eaed; }
    .nav-item.active { background: #c2e7ff; color: #001d35; font-weight: 500; }
    .nav-item .material-symbols-outlined { font-size: 20px; color: inherit; }
    .sidebar-divider { height: 1px; background: #e0e0e0; margin: 12px 16px; }
    .storage-quota-container { padding: 8px 24px; display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; }
    .storage-section-title { font-size: 10px; font-weight: 700; color: #5f6368; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 2px; }
    .storage-bar-track { width: 100%; height: 4px; background: #e0e0e0; border-radius: 2px; overflow: hidden; }
    .storage-bar-track.gdrive { background: #e2e8f0; }
    .storage-bar-fill { height: 100%; background: #1a73e8; border-radius: 2px; transition: width 500ms cubic-bezier(0.4, 0, 0.2, 1); }
    .storage-bar-fill.gdrive-fill { background: #34a853; }
    .storage-used { font-size: 13px; color: #5f6368; font-weight: 500; font-family: 'Roboto', sans-serif; margin-bottom: 4px; }
  `],
})
export class GDriveSidebarComponent {
  readonly currentView = input.required<DriveView>();
  readonly currentFolderId = input<number | null>(null);
  readonly locked = input(false);
  readonly quota = input.required<QuotaState>();
  readonly viewChange = output<DriveView>();
  readonly createFolderRequested = output<void>();
  readonly uploadFileRequested = output<void>();
  readonly uploadFolderRequested = output<void>();
  readonly pinnedFolderNavigate = output<number>();
  readonly isNewMenuOpen = signal(false);

  toggleNewMenu(): void {
    this.isNewMenuOpen.update(value => !value);
  }

  changeView(view: DriveView): void {
    this.isNewMenuOpen.set(false);
    this.viewChange.emit(view);
  }

  createFolder(): void {
    this.isNewMenuOpen.set(false);
    this.createFolderRequested.emit();
  }

  uploadFile(): void {
    this.isNewMenuOpen.set(false);
    this.uploadFileRequested.emit();
  }

  uploadFolder(): void {
    this.isNewMenuOpen.set(false);
    this.uploadFolderRequested.emit();
  }

  getQuotaPercent(): number {
    const quota = this.quota();
    return !quota.maxBytes ? 0 : (quota.usedBytes / quota.maxBytes) * 100;
  }

  getQuotaFormatted(): string {
    const quota = this.quota();
    return `${this.formatSize(quota.usedBytes)} de ${this.formatSize(quota.maxBytes)} usados`;
  }

  getGDriveQuotaPercent(): number {
    const quota = this.quota();
    return !quota.gdriveMaxBytes ? 0 : ((quota.gdriveUsedBytes || 0) / quota.gdriveMaxBytes) * 100;
  }

  getGDriveQuotaFormatted(): string {
    const quota = this.quota();
    return !quota.gdriveMaxBytes ? '0 B de 0 B usados' : `${this.formatSize(quota.gdriveUsedBytes || 0)} de ${this.formatSize(quota.gdriveMaxBytes)} usados`;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (!target.closest('.new-dropdown-container')) this.isNewMenuOpen.set(false);
  }

  private formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${parseFloat((bytes / Math.pow(1024, index)).toFixed(1))} ${sizes[index]}`;
  }
}
