import { Component, input, inject, signal, computed, Output, EventEmitter, OnInit, OnDestroy, NgZone, Renderer2, effect } from '@angular/core';
import { DriveFile, QuotaState, DriveStore } from '../../state/drive.store';
import { FileIconComponent } from '../../../../shared/ui/file-icon/file-icon.component';
import { AppStateService } from '../../../../core/state/app-state.service';
import { CommonModule } from '@angular/common';
import { DialogService } from '../../../../core/dialog/dialog.service';

@Component({
  selector: 'app-file-list',
  standalone: true,
  imports: [FileIconComponent, CommonModule],
  host: {
    style: 'display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%;'
  },
  template: `
    <div class="file-list-container" (contextmenu)="onContainerContextMenu($event)" (click)="selectedFileId.set(null)">
      <ng-template #ctxMenu let-file="file">
        <div class="action-menu"
             [style.position]="contextMenuPosition() ? 'fixed' : 'absolute'"
             [style.top]="contextMenuPosition() ? (contextMenuPosition()?.y + 'px') : '40px'"
             [style.left]="contextMenuPosition() ? (contextMenuPosition()?.x + 'px') : 'auto'"
             [style.right]="contextMenuPosition() ? 'auto' : '20px'"
             [style.margin]="'0'">
          @if (viewMode() === 'trash') {
            <button class="menu-item" (click)="onRestore(file, $event)">
              <span class="material-symbols-outlined">restore</span>
              Restaurar
            </button>
            <div style="height: 1px; background: #e8eaed; margin: 4px 0;"></div>
            <button class="menu-item" (click)="onPermanentDelete(file, $event)" style="color: #d93025;">
              <span class="material-symbols-outlined" style="color: #d93025;">delete_forever</span>
              Eliminar permanentemente
            </button>
          } @else {
            @if (file.type === 'video') {
              @if (hasProxy(file)) {
                <div class="menu-item-wrapper" (mouseenter)="checkSubmenuBounds($event)">
                  <button class="menu-item" style="justify-content: space-between;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                      <span class="material-symbols-outlined">visibility</span>
                      Preview
                    </div>
                    <span class="material-symbols-outlined" style="font-size: 16px;">chevron_right</span>
                  </button>
                  <div class="submenu">
                    <button class="menu-item" (click)="onPlayOriginal(file, $event)">Original</button>
                    <button class="menu-item" (click)="onPlayProxy(file, $event)">Compacta</button>
                  </div>
                </div>
              } @else {
                <button class="menu-item" (click)="onPlayOriginal(file, $event)">
                  <span class="material-symbols-outlined">visibility</span>
                  Preview
                </button>
              }
            }
            @if (!file.isFolder) {
              <button class="menu-item" (click)="onDownload(file, $event)">
                <span class="material-symbols-outlined">download</span>
                Baixar
              </button>
            }
            <button class="menu-item" (click)="onRename(file, $event)">
              <span class="material-symbols-outlined">edit</span>
              Renomear
            </button>
            <div style="height: 1px; background: #e8eaed; margin: 4px 0;"></div>
            <button class="menu-item" (click)="onDelete(file, $event)" style="color: #d93025;">
              <span class="material-symbols-outlined" style="color: #d93025;">delete</span>
              Mover para a lixeira
            </button>
          }
        </div>
      </ng-template>

      @if (driveStore.displayMode() === 'grid') {
        <div class="grid-layout">
          @if (sortedFolders().length > 0) {
            <div class="grid-section">
              <div class="grid-section-title">Pastas</div>
              <div class="grid-container folders-grid">
                @for (file of sortedFolders(); track file.id) {
                  <div class="grid-card folder-card"
                       [class.selected]="selectedFileId() === file.id"
                       [class.dragging]="draggedFile()?.id === file.id"
                       [class.drag-over]="dragOverFolderId() === file.id"
                       [attr.draggable]="(!isLocked() && file.id !== -9999) ? 'true' : null"
                       (dragstart)="onDragStart($event, file, dragPreview)"
                       (dragover)="onDragOver($event, file)"
                       (dragleave)="onDragLeave($event, file)"
                       (dragend)="onDragEnd()"
                       (drop)="onDrop($event, file)"
                       (click)="onFileClick(file, $event)"
                       (dblclick)="onFileDblClick(file, $event)"
                       (contextmenu)="onContextMenu(file, $event)">
                    <div class="folder-card-content">
                      <app-file-icon [fileType]="file.type" [locked]="isLocked()" />
                      <span class="file-name" [title]="getDisplayName(file)">{{ getDisplayName(file) }}</span>
                    </div>
                    @if (!isLocked()) {
                      <button class="grid-action-btn" (click)="toggleMenu(file, $event); $event.stopPropagation()">
                        <span class="material-symbols-outlined">more_vert</span>
                      </button>
                      @if (activeMenuFileId() === file.id) {
                        <ng-container *ngTemplateOutlet="ctxMenu; context: { file: file }"></ng-container>
                      }
                    }
                  </div>
                }
              </div>
            </div>
          }
          @if (sortedFilesOnly().length > 0) {
            <div class="grid-section">
              @if (sortedFolders().length > 0) {
                <div class="grid-section-title">Arquivos</div>
              }
              <div class="grid-container files-grid">
                @for (file of sortedFilesOnly(); track file.id) {
                  <div class="grid-card file-card"
                       [class.selected]="selectedFileId() === file.id"
                       [class.dragging]="draggedFile()?.id === file.id"
                       [attr.draggable]="(!isLocked() && file.id !== -9999) ? 'true' : null"
                       (dragstart)="onDragStart($event, file, dragPreview)"
                       (dragover)="onDragOver($event, file)"
                       (dragleave)="onDragLeave($event, file)"
                       (dragend)="onDragEnd()"
                       (drop)="onDrop($event, file)"
                       (click)="onFileClick(file, $event)"
                       (dblclick)="onFileDblClick(file, $event)"
                       (contextmenu)="onContextMenu(file, $event)">
                    <div class="file-card-header">
                      <div class="folder-card-content">
                        <app-file-icon [fileType]="file.type" [locked]="isLocked()" />
                        <span class="file-name" [title]="getDisplayName(file)">{{ getDisplayName(file) }}</span>
                      </div>
                      @if (!isLocked()) {
                        <button class="grid-action-btn" (click)="toggleMenu(file, $event); $event.stopPropagation()">
                          <span class="material-symbols-outlined">more_vert</span>
                        </button>
                        @if (activeMenuFileId() === file.id) {
                          <ng-container *ngTemplateOutlet="ctxMenu; context: { file: file }"></ng-container>
                        }
                      }
                    </div>
                    <div class="file-card-thumbnail"
                         [style.background-image]="driveStore.thumbnails()[file.id] ? 'url(' + driveStore.thumbnails()[file.id] + ')' : ''">
                      @if (!driveStore.thumbnails()[file.id]) {
                        <app-file-icon [fileType]="file.type" [locked]="isLocked()" class="thumbnail-icon" />
                      }
                    </div>
                  </div>
                }
              </div>
            </div>
          }
        </div>
      } @else {
        <div class="file-list-header" [class.storage-view]="viewMode() === 'storage'" [class.unlocked]="!isLocked()">
          <button class="col col-name sortable-header" (click)="setSort('name')">
            Nome
            <span class="material-symbols-outlined sort-icon" *ngIf="sortColumn() === 'name'">
              {{ sortDirection() === 'asc' ? 'arrow_upward' : 'arrow_downward' }}
            </span>
          </button>
          <button class="col col-owner sortable-header" *ngIf="viewMode() === 'drive'" (click)="setSort('owner')">
            Proprietário
            <span class="material-symbols-outlined sort-icon" *ngIf="sortColumn() === 'owner'">
              {{ sortDirection() === 'asc' ? 'arrow_upward' : 'arrow_downward' }}
            </span>
          </button>
          <button class="col col-modified sortable-header" *ngIf="viewMode() === 'drive'" (click)="setSort('modified')">
            Última modificação
            <span class="material-symbols-outlined sort-icon" *ngIf="sortColumn() === 'modified'">
              {{ sortDirection() === 'asc' ? 'arrow_upward' : 'arrow_downward' }}
            </span>
          </button>
          <button class="col col-size sortable-header" (click)="setSort('size')">
            Tamanho do arquivo
            <span class="material-symbols-outlined sort-icon" *ngIf="sortColumn() === 'size'">
              {{ sortDirection() === 'asc' ? 'arrow_upward' : 'arrow_downward' }}
            </span>
          </button>
          <div class="col col-quota" *ngIf="viewMode() === 'storage'">Uso da cota</div>
          <div class="col col-actions" *ngIf="!isLocked()" style="font-size: 12px; font-weight: 500; color: #5f6368; display: flex; justify-content: center;">Ações</div>
        </div>
        <div class="file-list-body">
          @for (file of sortedFiles(); track file.id) {
            <div class="file-row"
                 tabindex="0"
                 role="row"
                 [class.storage-view]="viewMode() === 'storage'"
                 [class.unlocked]="!isLocked()"
                 [class.selected]="selectedFileId() === file.id"
                 [class.dragging]="draggedFile()?.id === file.id"
                 [class.drag-over]="dragOverFolderId() === file.id"
                 [attr.draggable]="(!isLocked() && file.id !== -9999) ? 'true' : null"
                 (dragstart)="onDragStart($event, file, dragPreview)"
                 (dragover)="onDragOver($event, file)"
                 (dragleave)="onDragLeave($event, file)"
                 (dragend)="onDragEnd()"
                 (drop)="onDrop($event, file)"
                 (click)="onFileClick(file, $event)"
                 (dblclick)="onFileDblClick(file, $event)"
                 (contextmenu)="onContextMenu(file, $event)">
              <div class="col col-name">
                <app-file-icon [fileType]="file.type" [locked]="isLocked()" />
                <span class="file-name">{{ getDisplayName(file) }}</span>
              </div>
              <div class="col col-owner" *ngIf="viewMode() === 'drive'">
                {{ isLocked() ? getObfuscatedValue(file.owner) : file.owner }}
              </div>
              <div class="col col-modified" *ngIf="viewMode() === 'drive'">
                {{ isLocked() ? getObfuscatedValue(file.modifiedAt) : file.modifiedAt }}
              </div>
              <div class="col col-size">
                {{ isLocked() ? getObfuscatedValue(file.sizeFormatted) : file.sizeFormatted }}
                @if (viewMode() === 'storage' && getProxySize(file) > 0) {
                  <span style="color: #5f6368; font-size: 12px; margin-left: 4px;">(+{{ formatBytes(getProxySize(file)) }})</span>
                }
              </div>
              <div class="col col-quota" *ngIf="viewMode() === 'storage'">
                 <div class="quota-bar-container" *ngIf="!isLocked()">
                   <span class="quota-percent-text">{{ getPercentage(file) }} da conta</span>
                   <progress class="quota-progress" [value]="getTotalSize(file)" [max]="getTotalStorageMax() || 1"></progress>
                 </div>
                 <span *ngIf="isLocked()">{{ getObfuscatedValue(getPercentage(file) + ' da conta') }}</span>
              </div>
              <div class="col col-actions" *ngIf="!isLocked()" (click)="$event.stopPropagation()">
                <button class="action-btn" (click)="toggleMenu(file, $event)">
                  <span class="material-symbols-outlined">more_vert</span>
                </button>
                @if (activeMenuFileId() === file.id) {
                  <ng-container *ngTemplateOutlet="ctxMenu; context: { file: file }"></ng-container>
                }
              </div>
            </div>
          }
        </div>
      }

      @if (isContainerMenuOpen() && contextMenuPosition()) {
        <div class="action-menu"
             [style.position]="'fixed'"
             [style.top]="contextMenuPosition()?.y + 'px'"
             [style.left]="contextMenuPosition()?.x + 'px'"
             [style.right]="'auto'"
             [style.margin]="'0'"
             (click)="$event.stopPropagation()">
          <button class="menu-item" (click)="onCreateFolder($event)">
            <span class="material-symbols-outlined">create_new_folder</span>
            Nova pasta
          </button>
          <div style="height: 1px; background: #e8eaed; margin: 4px 0;"></div>
          <button class="menu-item" (click)="onUploadFile($event)">
            <span class="material-symbols-outlined">upload_file</span>
            Upload arquivo
          </button>
        </div>
      }

      <!-- Drag Image Custom Preview (hidden offscreen) -->
      <div #dragPreview class="drag-custom-preview" style="position: absolute; left: -9999px; top: -9999px;">
        <span class="material-symbols-outlined drag-icon">folder</span>
        <span class="drag-name"></span>
      </div>
    </div>
  `,
  styles: [
    `
      .file-list-container {
        width: 100%;
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 100%;
        overflow: visible;
      }

      .file-list-header {
        display: grid;
        grid-template-columns: 1fr 140px 160px 140px;
        padding: 0 24px;
        height: 40px;
        align-items: center;
        border-bottom: 1px solid #C7C7C7;
      }
      .file-list-header.unlocked {
        grid-template-columns: 1fr 140px 160px 100px 60px;
      }

      .file-list-header.storage-view {
        grid-template-columns: 1fr 140px 200px;
      }
      .file-list-header.storage-view.unlocked {
        grid-template-columns: 1fr 140px 200px 60px;
      }

      .sortable-header {
        display: flex;
        align-items: center;
        gap: 4px;
        background: transparent;
        border: none;
        font-size: 12px;
        font-weight: 500;
        color: #5f6368;
        text-transform: none;
        letter-spacing: 0;
        cursor: pointer;
        padding: 0;
        text-align: left;
        user-select: none;
      }
      .sortable-header:hover {
        color: #202124;
      }

      .sort-icon {
        font-size: 16px;
      }

      .file-list-body {
        flex: 1;
        overflow-y: auto;
        min-height: 200px;
      }

      .file-row {
        display: grid;
        grid-template-columns: 1fr 140px 160px 140px;
        padding: 0 24px;
        height: 52px;
        align-items: center;
        border-bottom: 1px solid #C7C7C7;
        cursor: pointer;
        transition: background 150ms cubic-bezier(0.4, 0, 0.2, 1);
        outline: none;
        position: relative;
      }
      .file-row.unlocked {
        grid-template-columns: 1fr 140px 160px 100px 60px;
      }

      .file-row.storage-view {
        grid-template-columns: 1fr 140px 200px;
      }
      .file-row.storage-view.unlocked {
        grid-template-columns: 1fr 140px 200px 60px;
      }

      .file-row:hover {
        background: #EDEDED;
      }

      .file-row.dragging {
        opacity: 0.4;
        background: #f1f3f4;
      }

      .file-row.drag-over {
        background-color: #c2e7ff !important;
        outline: 2px solid #1a73e8 !important;
        outline-offset: -2px;
      }

      .file-row:focus-visible {
        background: #e8f0fe;
      }

      .file-row.selected {
        background-color: #e8f0fe !important;
      }
      .file-row.selected .file-name,
      .file-row.selected .col-owner,
      .file-row.selected .col-modified,
      .file-row.selected .col-size {
        color: #1a73e8;
      }

      .file-row:active {
        background: #e8eaed;
      }

      .col-name {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }

      .file-name {
        font-size: 13px;
        color: #202124;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: color 250ms ease;
      }

      .col-owner,
      .col-modified,
      .col-size {
        font-size: 13px;
        color: #5f6368;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      
      .col-quota {
        font-size: 13px;
        color: #5f6368;
        font-weight: 500;
      }
      
      .quota-bar-container {
        display: flex;
        flex-direction: column;
        gap: 4px;
        width: 100%;
      }
      
      .quota-percent-text {
        font-size: 11px;
      }
      
      .quota-progress {
        width: 100%;
        height: 6px;
        border-radius: 4px;
        appearance: none;
        -webkit-appearance: none;
      }
      .quota-progress::-webkit-progress-bar {
        background-color: #e0e0e0;
        border-radius: 4px;
      }
      .quota-progress::-webkit-progress-value {
        background-color: #1a73e8;
        border-radius: 4px;
      }

      /* Responsive */
      @media (max-width: 768px) {
        .file-list-header,
        .file-row {
          grid-template-columns: 1fr 120px;
        }
        .file-list-header.storage-view,
        .file-row.storage-view {
          grid-template-columns: 1fr 120px;
        }
        .col-owner,
        .col-modified,
        .col-quota {
          display: none !important;
        }
      }

      .col-actions {
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
      }

      .action-btn {
        background: transparent;
        border: none;
        border-radius: 50%;
        width: 36px;
        height: 36px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #5f6368;
        cursor: pointer;
        transition: background 150ms;
      }

      .action-btn:hover {
        background: rgba(60, 64, 67, 0.08);
        color: #202124;
      }

      /* Dropdown Menu */
      .action-menu {
        position: absolute;
        top: 40px;
        right: 20px;
        background: white;
        border-radius: 8px;
        box-shadow: 0 1px 3px 0 rgba(60,64,67,0.3), 0 4px 8px 3px rgba(60,64,67,0.15);
        min-width: 180px;
        z-index: 1000;
        display: flex;
        flex-direction: column;
        padding: 6px 0;
        animation: fadeIn 150ms ease;
      }

      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .menu-item {
        background: transparent;
        border: none;
        padding: 10px 16px;
        text-align: left;
        font-size: 14px;
        color: #3c4043;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 12px;
        transition: background 150ms;
        width: 100%;
      }


      .menu-item:hover {
        background: #f1f3f4;
        color: #202124;
      }

      .menu-item .material-symbols-outlined {
        font-size: 20px;
        color: #5f6368;
      }

      .menu-item-wrapper {
        position: relative;
        width: 100%;
      }

      .submenu {
        display: none;
        position: absolute;
        top: 0;
        left: 100%;
        right: auto;
        background: white;
        border-radius: 8px;
        box-shadow: 0 1px 3px 0 rgba(60,64,67,0.3), 0 4px 8px 3px rgba(60,64,67,0.15);
        min-width: 150px;
        z-index: 1001;
        flex-direction: column;
        padding: 6px 0;
      }

      .menu-item-wrapper:hover .submenu {
        display: flex;
      }

      .drag-custom-preview {
        display: flex;
        align-items: center;
        gap: 12px;
        background: #ffffff;
        border-radius: 12px;
        padding: 8px 16px;
        box-shadow: 0 4px 12px 0 rgba(60,64,67,0.3);
        border: 1px solid #dadce0;
        pointer-events: none;
        white-space: nowrap;
        font-family: 'Roboto', sans-serif;
        font-size: 14px;
        color: #202124;
        z-index: 9999;
      }

      .drag-custom-preview .drag-icon {
        font-size: 24px;
        user-select: none;
      }
      
      .drag-custom-preview .drag-name {
        font-weight: 400;
        max-width: 150px;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* === GRID VIEW === */
      .grid-layout {
        padding: 16px 24px;
        display: flex;
        flex-direction: column;
        gap: 24px;
        overflow-y: auto;
      }
      .grid-section-title {
        font-size: 14px;
        font-weight: 500;
        color: #5f6368;
        margin-bottom: 12px;
      }
      .grid-container {
        display: grid;
        gap: 16px;
      }
      .folders-grid {
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      }
      .files-grid {
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      }
      .grid-card {
        background: #f8f9fa;
        border: 1px solid #dadce0;
        border-radius: 8px;
        position: relative;
        cursor: pointer;
        user-select: none;
        transition: background-color 0.15s, box-shadow 0.15s;
        overflow: hidden;
      }
      .grid-card:hover {
        background: #f1f3f4;
      }
      .grid-card.selected {
        background: #e8f0fe;
        border-color: #d2e3fc;
      }
      .folder-card {
        display: flex;
        flex-direction: row;
        align-items: center;
        padding: 0 8px 0 16px;
        height: 48px;
        justify-content: space-between;
      }
      .folder-card-content {
        display: flex;
        align-items: center;
        gap: 12px;
        flex: 1;
        min-width: 0;
      }
      .folder-card-content .file-name {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 13px;
        font-weight: 500;
        color: #3c4043;
      }
      .grid-action-btn {
        background: transparent;
        border: none;
        cursor: pointer;
        color: #5f6368;
        padding: 4px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .grid-action-btn:hover {
        background: rgba(60,64,67,0.08);
      }
      .file-card {
        display: flex;
        flex-direction: column;
        height: 200px;
      }
      .file-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 8px 0 16px;
        height: 48px;
        flex-shrink: 0;
      }
      .file-card-thumbnail {
        flex: 1;
        background: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        border-top: 1px solid #dadce0;
        background-size: cover;
        background-position: center;
      }
      .thumbnail-icon {
        transform: scale(2.5);
        opacity: 0.15;
      }
    `
  ],
})
export class FileListComponent implements OnInit, OnDestroy {
  private readonly appState = inject(AppStateService);
  readonly driveStore = inject(DriveStore);
  private readonly ngZone = inject(NgZone);
  private readonly renderer = inject(Renderer2);
  private readonly dialogService = inject(DialogService);

  private clickUnsub: (() => void) | null = null;
  private resizeUnsub: (() => void) | null = null;
  private scrollUnsub: (() => void) | null = null;

  constructor() {
    effect(() => {
      if (this.driveStore.displayMode() === 'grid' && !this.isLocked()) {
        const gridFiles = this.sortedFilesOnly();
        gridFiles.forEach(f => {
          if (f.type === 'image' || f.type === 'video') {
            // Load thumbnail lazily (cache prevents multiple loads)
            this.driveStore.loadThumbnail(f);
          }
        });
      }
    });
  }

  ngOnInit() {
    this.ngZone.runOutsideAngular(() => {
      this.clickUnsub = this.renderer.listen('document', 'click', () => {
        if (this.activeMenuFileId() !== null || this.isContainerMenuOpen()) {
          this.ngZone.run(() => this.closeMenu());
        }
      });

      this.resizeUnsub = this.renderer.listen('window', 'resize', () => {
        if (this.activeMenuFileId() !== null || this.isContainerMenuOpen()) {
          this.ngZone.run(() => this.closeMenu());
        }
      });

      this.scrollUnsub = this.renderer.listen('window', 'scroll', () => {
        if (this.activeMenuFileId() !== null || this.isContainerMenuOpen()) {
          this.ngZone.run(() => this.closeMenu());
        }
      });
    });
  }

  ngOnDestroy() {
    if (this.clickUnsub) this.clickUnsub();
    if (this.resizeUnsub) this.resizeUnsub();
    if (this.scrollUnsub) this.scrollUnsub();
  }

  readonly files = input.required<DriveFile[]>();
  readonly viewMode = input<'drive' | 'storage' | 'trash'>('drive');
  readonly quota = input<QuotaState | null>(null);

  @Output() createFolderRequested = new EventEmitter<void>();
  @Output() uploadFileRequested = new EventEmitter<void>();
  @Output() videoSelected = new EventEmitter<DriveFile>();

  readonly isLocked = this.appState.isLocked;
  readonly activeMenuFileId = signal<number | null>(null);
  readonly contextMenuPosition = signal<{ x: number, y: number } | null>(null);
  readonly isContainerMenuOpen = signal(false);
  readonly selectedFileId = signal<number | null>(null);

  readonly draggedFile = signal<DriveFile | null>(null);
  readonly dragOverFolderId = signal<number | null>(null);

  sortColumn = signal<string>('name');
  sortDirection = signal<'asc' | 'desc'>('asc');

  closeMenu() {
    this.activeMenuFileId.set(null);
    this.contextMenuPosition.set(null);
    this.isContainerMenuOpen.set(false);
  }

  toggleMenu(file: DriveFile, event: Event) {
    event.stopPropagation();
    this.contextMenuPosition.set(null);
    this.isContainerMenuOpen.set(false);
    if (this.activeMenuFileId() === file.id) {
      this.activeMenuFileId.set(null);
    } else {
      this.activeMenuFileId.set(file.id);
    }
  }

  onContextMenu(file: DriveFile, event: MouseEvent) {
    if (this.isLocked()) return;
    event.preventDefault();
    event.stopPropagation();

    const menuWidth = 200;
    const menuHeight = 220;

    let x = event.clientX;
    let y = event.clientY;

    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 10;
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 10;
    }

    this.contextMenuPosition.set({ x, y });
    this.activeMenuFileId.set(file.id);
    this.isContainerMenuOpen.set(false);
  }

  onContainerContextMenu(event: MouseEvent) {
    if (this.isLocked() || this.viewMode() !== 'drive') return;
    
    // Do not show menu when right clicking header
    const target = event.target as HTMLElement;
    if (target.closest('.file-list-header')) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const menuWidth = 200;
    const menuHeight = 100;

    let x = event.clientX;
    let y = event.clientY;

    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 10;
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 10;
    }

    this.contextMenuPosition.set({ x, y });
    this.isContainerMenuOpen.set(true);
    this.activeMenuFileId.set(null);
  }

  onCreateFolder(event: Event) {
    event.stopPropagation();
    this.closeMenu();
    this.createFolderRequested.emit();
  }

  onUploadFile(event: Event) {
    event.stopPropagation();
    this.closeMenu();
    this.uploadFileRequested.emit();
  }

  onDragStart(event: DragEvent, file: DriveFile, previewEl: HTMLElement) {
    if (this.isLocked() || file.id === -9999) {
      event.preventDefault();
      return;
    }
    this.draggedFile.set(file);
    
    // Synchronously update drag preview card element in DOM
    const iconEl = previewEl.querySelector('.drag-icon') as HTMLElement;
    const nameEl = previewEl.querySelector('.drag-name') as HTMLElement;
    
    if (iconEl) {
      iconEl.textContent = this.getFileIcon(file);
      iconEl.style.color = this.getFileIconColor(file);
      
      // If it's a folder, fill it
      if (file.type === 'folder') {
        iconEl.style.fontVariationSettings = "'FILL' 1";
      } else {
        iconEl.style.fontVariationSettings = "'FILL' 0";
      }
    }
    if (nameEl) {
      nameEl.textContent = this.getDisplayName(file);
    }
    
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', file.id.toString());
      // Adjust offset so mouse cursor centers on preview card
      event.dataTransfer.setDragImage(previewEl, 20, 20);
    }
  }

  onDragOver(event: DragEvent, targetFile: DriveFile) {
    if (this.isLocked()) return;
    const dragged = this.draggedFile();
    if (!dragged) return;

    // Only folders can receive items
    if (!targetFile.isFolder) return;

    if (targetFile.id === -9999) {
      // Cannot drop back to parent if already in root or already in that parent
      if (dragged.parentId === targetFile.parentId || dragged.folderId === targetFile.parentId) return;
    } else {
      // Cannot drop an item into itself
      if (dragged.id === targetFile.id) return;
      
      // Cannot drop into its own parent folder
      if (dragged.parentId === targetFile.id || dragged.folderId === targetFile.id) return;
    }

    // Prevent default to allow drop
    event.preventDefault();
    this.dragOverFolderId.set(targetFile.id);
  }

  onDragLeave(event: DragEvent, file: DriveFile) {
    if (this.dragOverFolderId() === file.id) {
      this.dragOverFolderId.set(null);
    }
  }

  onDragEnd() {
    this.draggedFile.set(null);
    this.dragOverFolderId.set(null);
  }

  async onDrop(event: DragEvent, targetFile: DriveFile) {
    if (this.isLocked()) return;
    event.preventDefault();
    this.dragOverFolderId.set(null);
    
    const dragged = this.draggedFile();
    if (!dragged) return;
    
    const targetFolderId = (targetFile.id === -9999 ? targetFile.parentId : targetFile.id) ?? null;
    
    try {
      await this.driveStore.moveItem(dragged, targetFolderId);
    } catch (e: any) {
      alert(e?.message || 'Erro ao mover item');
    }
    
    this.draggedFile.set(null);
  }

  getFileIcon(file: DriveFile): string {
    if (this.isLocked()) return 'lock';
    const typeMap: Record<string, string> = {
      folder: 'folder',
      pdf: 'picture_as_pdf',
      image: 'image',
      doc: 'description',
      spreadsheet: 'table_chart',
      video: 'videocam',
      audio: 'audio_file',
    };
    return typeMap[file.type] ?? 'insert_drive_file';
  }

  getFileIconColor(file: DriveFile): string {
    if (this.isLocked()) return '#9aa0a6';
    const colorMap: Record<string, string> = {
      folder: '#5f6368',
      pdf: '#ea4335',
      image: '#ea4335',
      doc: '#4285f4',
      spreadsheet: '#34a853',
      video: '#ea4335',
      audio: '#ff6d00',
    };
    return colorMap[file.type] ?? '#5f6368';
  }

  async onRestore(file: DriveFile, event: Event) {
    event.stopPropagation();
    this.activeMenuFileId.set(null);
    try {
      await this.driveStore.restoreItem(file);
    } catch (e) {
      alert('Erro ao restaurar');
    }
  }

  async onPermanentDelete(file: DriveFile, event: Event) {
    event.stopPropagation();
    this.activeMenuFileId.set(null);
    const confirmed = await this.dialogService.confirm(
      'Excluir definitivamente?',
      `O item "${file.decryptedName || file.encryptedName}" será excluído definitivamente. Não é possível desfazer essa ação.`,
      'Excluir definitivamente',
      true
    );
    if (!confirmed) return;
    try {
      await this.driveStore.permanentDeleteItem(file);
    } catch (e) {
      alert('Erro ao apagar permanentemente');
    }
  }

  async onDownload(file: DriveFile, event: Event) {
    event.stopPropagation();
    this.closeMenu();
    try {
      await this.driveStore.downloadFile(file);
    } catch (e) {
      console.error('Erro no download', e);
      alert('Falha ao transferir ficheiro.');
    }
  }

  onPlayOriginal(file: DriveFile, event: Event) {
    event.stopPropagation();
    this.closeMenu();
    this.videoSelected.emit({ ...file, forceOriginal: true });
  }

  onPlayProxy(file: DriveFile, event: Event) {
    event.stopPropagation();
    this.closeMenu();
    this.videoSelected.emit(file);
  }

  hasProxy(file: DriveFile): boolean {
    const proxyName = file.decryptedName + '.proxy.mp4';
    const legacyProxyName = '__PROXY__' + file.decryptedName;
    return this.driveStore.files().some(f => (f.decryptedName === proxyName || f.decryptedName === legacyProxyName) && f.folderId === file.folderId);
  }

  checkSubmenuBounds(event: MouseEvent) {
    const wrapper = event.currentTarget as HTMLElement;
    const submenu = wrapper.querySelector('.submenu') as HTMLElement;
    if (!submenu) return;
    
    // Se o mouse estiver na metade direita da tela, abre o submenu para a esquerda
    if (event.clientX > window.innerWidth / 2) {
      submenu.style.left = 'auto';
      submenu.style.right = '100%';
    } else {
      submenu.style.left = '100%';
      submenu.style.right = 'auto';
    }
  }

  async onRename(file: DriveFile, event: Event) {
    event.stopPropagation();
    this.activeMenuFileId.set(null);
    const newName = await this.dialogService.prompt('Renomear', file.decryptedName || file.encryptedName, 'Nome do item', 'OK');
    if (!newName || newName === (file.decryptedName || file.encryptedName)) return;

    try {
      await this.driveStore.renameItem(file, newName);
    } catch (e: any) {
      if (e?.status === 409) {
        alert(file.isFolder ? 'Uma pasta com este nome já existe nesta localização.' : 'Um arquivo com este nome já existe nesta pasta.');
      } else {
        alert('Erro ao renomear');
      }
    }
  }

  getAvailableFolders(currentFile: DriveFile): DriveFile[] {
    return this.driveStore.files().filter(f => f.isFolder && f.id !== currentFile.id);
  }

  async onMove(file: DriveFile, event: Event) {
    event.stopPropagation();
    this.activeMenuFileId.set(null);

    const folders = this.getAvailableFolders(file);
    let msg = 'Selecione o número da pasta de destino:\n\n0: Raiz (Meu Drive)\n';
    folders.forEach((f, idx) => {
      msg += `${idx + 1}: ${f.decryptedName || f.encryptedName}\n`;
    });

    const choice = prompt(msg);
    if (choice === null) return;

    const choiceNum = parseInt(choice, 10);
    if (choiceNum === 0) {
      try {
        await this.driveStore.moveItem(file, null);
      } catch (e) {
        alert('Erro ao mover');
      }
    } else if (choiceNum > 0 && choiceNum <= folders.length) {
      try {
        const target = folders[choiceNum - 1];
        await this.driveStore.moveItem(file, target.id);
      } catch (e: any) {
        alert(e?.message || 'Erro ao mover');
      }
    } else {
      alert('Opção inválida');
    }
  }

  async onDelete(file: DriveFile, event: Event) {
    event.stopPropagation();
    this.activeMenuFileId.set(null);

    const confirmed = await this.dialogService.confirm(
      'Mover para a lixeira?',
      `Tem certeza de que deseja mover "${file.decryptedName || file.encryptedName}" para a lixeira?`,
      'Mover para a lixeira'
    );
    if (!confirmed) return;

    try {
      await this.driveStore.trashItem(file);
    } catch (e) {
      alert('Erro ao mover para a lixeira');
    }
  }

  sortedFiles = computed(() => {
    let fileArray = [...this.files()];

    // Auto sort by size descending in storage view if not manually overridden
    const mode = this.viewMode();
    const col = this.sortColumn();
    const dir = this.sortDirection();

    fileArray.sort((a, b) => {
      let valA: any = a.decryptedName || a.encryptedName;
      let valB: any = b.decryptedName || b.encryptedName;

      if (col === 'size') {
        valA = a.sizeBytes;
        valB = b.sizeBytes;
      } else if (col === 'owner') {
        valA = a.owner;
        valB = b.owner;
      } else if (col === 'modified') {
        valA = a.modifiedAt;
        valB = b.modifiedAt;
      } else if (col === 'name') {
        valA = (a.decryptedName || a.encryptedName).toLowerCase();
        valB = (b.decryptedName || b.encryptedName).toLowerCase();
      }

      if (valA < valB) return dir === 'asc' ? -1 : 1;
      if (valA > valB) return dir === 'asc' ? 1 : -1;
      return 0;
    });

    if (mode === 'storage' && col === 'name' && dir === 'asc') {
      // Se o user ainda não clicou em nada (estado default de name asc), força sort por tamanho desc
      fileArray = [...this.files()].sort((a, b) => b.sizeBytes - a.sizeBytes);
    }

    const currentId = this.driveStore.currentFolderId();
    if (currentId !== null) {
      let parentId: number | null = null;
      if (mode === 'trash') {
        const currentFolder = this.driveStore.trashFiles().find(f => f.isFolder && f.id === currentId);
        parentId = currentFolder?.parentId ?? null;
      } else {
        const currentFolder = this.driveStore.files().find(f => f.isFolder && f.id === currentId);
        parentId = currentFolder?.parentId ?? null;
      }

      const parentVirtualFolder: DriveFile = {
        id: -9999,
        isFolder: true,
        encryptedName: '..',
        decryptedName: '..',
        type: 'folder',
        sizeBytes: 0,
        sizeFormatted: '—',
        modifiedAt: '—',
        owner: '—',
        parentId: parentId
      };

      return [parentVirtualFolder, ...fileArray];
    }

    return fileArray;
  });

  sortedFolders = computed(() => this.sortedFiles().filter(f => f.isFolder));
  sortedFilesOnly = computed(() => this.sortedFiles().filter(f => !f.isFolder));

  setSort(column: string) {
    if (this.sortColumn() === column) {
      this.sortDirection.set(this.sortDirection() === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortColumn.set(column);
      this.sortDirection.set('asc');
    }
  }

  getDisplayName(file: DriveFile): string {
    if (this.isLocked()) {
      const fallback = file.encryptedName;
      const truncated = fallback.length > 15 ? fallback.substring(0, 15) + '...' : fallback;
      return truncated;
    }
    return file.decryptedName || file.encryptedName;
  }

  getObfuscatedValue(val: string | number | undefined): string {
    if (val === undefined || val === null || val === '—') return '—';
    const str = val.toString();
    try {
      const b64 = btoa(unescape(encodeURIComponent(str)));
      return b64.length > 15 ? b64.substring(0, 15) + '...' : b64;
    } catch {
      return 'dHJhbmNhZG8=';
    }
  }

  getTotalStorageMax(): number {
    const q = this.quota();
    if (!q) return 0;
    return (q.maxBytes || 0) + (q.gdriveMaxBytes || 0);
  }

  getProxySize(file: DriveFile): number {
    const proxyName = file.decryptedName + '.proxy.mp4';
    const legacyProxyName = '__PROXY__' + file.decryptedName;
    const proxy = this.driveStore.files().find(f => (f.decryptedName === proxyName || f.decryptedName === legacyProxyName) && f.folderId === file.folderId);
    return proxy ? proxy.sizeBytes : 0;
  }

  getTotalSize(file: DriveFile): number {
    return file.sizeBytes + this.getProxySize(file);
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  getPercentage(file: DriveFile): string {
    const max = this.getTotalStorageMax();
    if (max === 0) return '0%';
    const pct = (this.getTotalSize(file) / max) * 100;
    if (pct < 0.01 && this.getTotalSize(file) > 0) return '<0.01%';
    return pct.toFixed(2) + '%';
  }

  onFileClick(file: DriveFile, event: Event) {
    event.stopPropagation();
    if (this.isLocked()) return;
    this.selectedFileId.set(file.id);
  }

  onFileDblClick(file: DriveFile, event: Event) {
    event.stopPropagation();
    if (this.isLocked()) return;
    if (file.id === -9999) {
      this.driveStore.navigateTo(file.parentId ?? null);
      return;
    }
    if (file.isFolder) {
      this.driveStore.navigateTo(file.id);
    } else if (file.type === 'video') {
      this.videoSelected.emit(file);
    } else {
      this.selectedFileId.set(null);
    }
  }
}
