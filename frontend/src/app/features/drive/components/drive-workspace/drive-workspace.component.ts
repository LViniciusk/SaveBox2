import { Component, computed, inject, input, output } from '@angular/core';
import { FileListComponent } from '../file-list/file-list.component';
import { TransferPanelComponent } from '../transfer-panel/transfer-panel.component';
import { DriveFile, DriveStore } from '../../state/drive.store';
import { DriveView } from '../../state/drive.types';

@Component({
  selector: 'app-drive-workspace',
  standalone: true,
  imports: [FileListComponent, TransferPanelComponent],
  template: `
    <div class="breadcrumb">
      <span class="material-symbols-outlined breadcrumb-icon">
        {{ currentView() === 'drive' ? (driveStore.currentFolderId() ? 'folder_open' : 'folder') : (currentView() === 'trash' ? 'delete' : (currentView() === 'storage' ? 'cloud' : 'pending_actions')) }}
      </span>
      @if (currentView() === 'drive') {
        <div class="breadcrumb-path">
          @for (segment of driveStore.currentPath(); track segment.id; let last = $last) {
            <button class="breadcrumb-link" (click)="driveStore.navigateTo(segment.id)" [disabled]="last">
              {{ segment.name }}
            </button>
            @if (!last) { <span class="breadcrumb-separator">/</span> }
          }
        </div>
      } @else if (currentView() === 'storage') {
        <span class="breadcrumb-text">Armazenamento</span>
      } @else if (currentView() === 'trash') {
        <span class="breadcrumb-text">Lixeira</span>
      } @else {
        <span class="breadcrumb-text">Pendentes</span>
      }

      <div style="flex-grow: 1"></div>
      @if (currentView() === 'drive' || currentView() === 'trash') {
        <div class="view-mode-toggle">
          <button [class.active]="driveStore.displayMode() === 'list'" (click)="driveStore.setDisplayMode('list')" title="Modo Lista">
            <span class="material-symbols-outlined">view_list</span>
          </button>
          <button [class.active]="driveStore.displayMode() === 'grid'" (click)="driveStore.setDisplayMode('grid')" title="Modo Grade">
            <span class="material-symbols-outlined">grid_view</span>
          </button>
        </div>
      }
    </div>

    @if (currentView() === 'trash' && driveStore.trashFiles().length > 0) {
      <div class="trash-banner">
        <span class="trash-banner-text">Os itens da lixeira serão excluídos permanentemente após 30 dias</span>
        <button class="empty-trash-btn" (click)="emptyTrashRequested.emit()">Esvaziar lixeira</button>
      </div>
    }

    @if (currentView() === 'trash') {
      <app-file-list [files]="driveStore.currentTrashFolderFiles()" [viewMode]="'trash'" [quota]="driveStore.quota()" (videoSelected)="videoSelected.emit($event)" (imageSelected)="imageSelected.emit($event)" />
    } @else if (currentView() === 'transfers') {
      <app-transfer-panel [currentView]="currentView()" />
    } @else {
      <app-file-list
        [files]="currentView() === 'storage' ? currentStorageFiles() : driveStore.currentFolderFiles()"
        [viewMode]="currentView() === 'storage' ? 'storage' : 'drive'"
        [quota]="driveStore.quota()"
        (createFolderRequested)="createFolderRequested.emit()"
        (uploadFileRequested)="uploadFileRequested.emit()"
        (videoSelected)="videoSelected.emit($event)"
        (imageSelected)="imageSelected.emit($event)"
        (shareRequested)="shareRequested.emit($event)" />
    }

    @if (currentView() !== 'transfers') {
      <app-transfer-panel [currentView]="currentView()" />
    }
  `,
  styles: [`
    :host { display: flex; flex: 1; flex-direction: column; min-height: 0; width: 100%; }
    .breadcrumb { display: flex; align-items: center; gap: 10px; padding: 20px 24px 12px; font-size: 18px; font-weight: 400; color: #202124; }
    .breadcrumb-icon { font-size: 22px; color: #5f6368; font-variation-settings: 'FILL' 1; }
    .breadcrumb-text { font-size: 18px; }
    .breadcrumb-path { display: flex; align-items: center; gap: 6px; font-size: 18px; font-family: 'Roboto', sans-serif; }
    .breadcrumb-link { background: transparent; border: none; padding: 0; font-size: 18px; font-weight: 400; color: #1a73e8; cursor: pointer; transition: color 0.15s ease; }
    .breadcrumb-link:hover:not(:disabled) { color: #1557b0; text-decoration: underline; }
    .breadcrumb-link:disabled { color: #202124; cursor: default; text-decoration: none; }
    .breadcrumb-separator { color: #5f6368; user-select: none; }
    .view-mode-toggle { display: flex; border: 1px solid #747775; border-radius: 100px; overflow: hidden; margin-left: auto; }
    .view-mode-toggle button { display: flex; align-items: center; justify-content: center; background: transparent; border: none; padding: 4px 12px; cursor: pointer; color: #444746; transition: background-color 0.2s; }
    .view-mode-toggle button:hover { background-color: rgba(68, 71, 70, 0.08); }
    .view-mode-toggle button.active { background-color: #c2e7ff; color: #001d35; }
    .view-mode-toggle button.active:hover { background-color: #b3dcf4; }
    .view-mode-toggle button:first-child { border-right: 1px solid #747775; }
    .trash-banner { display: flex; align-items: center; justify-content: space-between; background: #edf2fa; border: none; border-radius: 12px; padding: 14px 24px; margin: 0 24px 16px; box-sizing: border-box; }
    .trash-banner-text { font-size: 14px; color: #3c4043; font-family: 'Roboto', sans-serif; }
    .empty-trash-btn { background: #EDF2FA; border: none; border-radius: 20px; padding: 8px 20px; font-size: 14px; font-weight: 500; color: #0b57d0; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 150ms; font-family: 'Roboto', sans-serif; }
    .empty-trash-btn:hover { background: #d3e3fd; }
  `],
})
export class DriveWorkspaceComponent {
  readonly currentView = input.required<DriveView>();
  readonly driveStore = inject(DriveStore);
  readonly createFolderRequested = output<void>();
  readonly uploadFileRequested = output<void>();
  readonly videoSelected = output<DriveFile>();
  readonly imageSelected = output<{ file: DriveFile; playlist: DriveFile[] }>();
  readonly shareRequested = output<DriveFile>();
  readonly emptyTrashRequested = output<void>();

  readonly currentStorageFiles = computed(() => [...this.driveStore.files()]
    .filter(file => !file.isHidden && !file.isFolder)
    .sort((a, b) => b.sizeBytes - a.sizeBytes));
}
