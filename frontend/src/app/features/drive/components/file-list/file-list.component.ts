import { Component, input, inject, signal, computed, Output, EventEmitter, OnInit, OnDestroy, AfterViewInit, NgZone, Renderer2, effect, ElementRef, QueryList, ViewChildren } from '@angular/core';
import { Subscription } from 'rxjs';
import { DriveFile, QuotaState, DriveStore } from '../../state/drive.store';
import { FileIconComponent } from '../../../../shared/ui/file-icon/file-icon.component';
import { AppStateService } from '../../../../core/state/app-state.service';
import { CommonModule } from '@angular/common';
import { DialogService } from '../../../../core/dialog/dialog.service';
import { PinnedFoldersStore } from '../../state/pinned-folders.store';
import { DefaultLockedPreviewComponent } from '../../../../shared/ui/default-locked-preview/default-locked-preview.component';
import { FilePreviewRequest } from '../../services/file-preview-resolver';
import { getPublicShareAvailability } from '../../policies/public-share-policy';
import { formatBytes as formatBytesValue } from '../../../../shared/utils/format-bytes';
import { sortFiles } from './file-list-sort';
import type { FileSortColumn } from './file-list-sort';
import { FileContextMenuComponent, type FileContextMenuAction } from './file-context-menu.component';
import { FileSortMenuComponent } from './file-sort-menu.component';
import { ThumbnailViewportTargetDirective } from './thumbnail-viewport-target.directive';

@Component({
  selector: 'app-file-list',
  standalone: true,
  imports: [FileIconComponent, DefaultLockedPreviewComponent, FileContextMenuComponent, FileSortMenuComponent, ThumbnailViewportTargetDirective, CommonModule],
  host: {
    style: 'display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0; min-width: 0; width: 100%; overflow: hidden;'
  },
  template: `
    <div class="file-list-container" (contextmenu)="onContainerContextMenu($event)" (click)="onContainerClick($event)" (mousedown)="onContainerMouseDown($event)">
      @if (isDraggingSelection()) {
        <div class="selection-box" 
             [style.left.px]="selectionBox().x" 
             [style.top.px]="selectionBox().y"
             [style.width.px]="selectionBox().w" 
             [style.height.px]="selectionBox().h">
        </div>
      }
      <ng-template #folderCardTpl let-file="file">
        <div class="grid-card folder-card selectable-item" [class.file-card]="isLocked() && !isDefaultTheme()" [class.locked-folder]="isLocked()" [attr.data-item-key]="itemKey(file)"
             [class.selected]="isFileSelected(file)"
             [class.dragging]="isDragged(file)"
             [class.drag-over]="dragOverItemKey() === itemKey(file)"
             [attr.draggable]="canDrag(file) ? 'true' : null"
             (dragstart)="onDragStart($event, file, dragPreview)"
             (dragover)="onDragOver($event, file)"
             (dragleave)="onDragLeave($event, file)"
             (dragend)="onDragEnd()"
             (drop)="onDrop($event, file)"
             (click)="onFileClick(file, $event)"
             (dblclick)="onFileDblClick(file, $event)"
             (contextmenu)="onContextMenu(file, $event)">
            @if (isDefaultTheme()) {
              <div class="default-preview-viewport folder-preview-viewport" aria-hidden="true"
                   appThumbnailViewport [appThumbnailViewportTarget]="isLocked() ? null : getFolderPreviewCandidate(file)">
                @if (isLocked()) {
                  <app-default-locked-preview />
                } @else {
                  <img class="folder-art-layer folder-back" src="icons-test/folder-back.ico" alt="" />
                  @if (getFolderThumbnail(file); as thumbnail) {
                    <span class="folder-thumbnail default-folder-preview">
                      <img class="folder-thumbnail-image default-folder-preview-image" [src]="thumbnail" alt="" />
                    </span>
                    <img class="folder-art-layer folder-front" src="icons-test/folder-front.ico" alt="" />
                  } @else {
                    <img class="folder-art-layer folder-default" src="icons-test/folder-default.ico" alt="" />
                  }
                }
              </div>
            }
            <div class="folder-card-content">
              @if (!isLocked() || !isDefaultTheme()) { <app-file-icon [fileType]="file.type" [locked]="isLocked()" /> }
              <span class="file-name" [title]="getDisplayName(file)">{{ getDisplayName(file) }}</span>
            </div>
          @if (!isLocked()) {
            <button class="grid-action-btn" (click)="toggleMenu(file, $event); $event.stopPropagation()">
              <span class="material-symbols-outlined">more_vert</span>
            </button>
          }
        </div>
      </ng-template>

      <ng-template #fileCardTpl let-file="file">
        <div class="grid-card file-card selectable-item" [attr.data-item-key]="itemKey(file)"
             [class.video-card]="file.type === 'video'"
             [class.image-card]="file.type === 'image'"
             [class.mixed-folder-card]="file.isFolder"
             [class.locked-folder]="file.isFolder && isLocked()"
             [class.selected]="isFileSelected(file)"
             [class.dragging]="isDragged(file)"
             [attr.draggable]="canDrag(file) ? 'true' : null"
             (dragstart)="onDragStart($event, file, dragPreview)"
             (dragover)="onDragOver($event, file)"
             (dragleave)="onDragLeave($event, file)"
             (dragend)="onDragEnd()"
             (drop)="onDrop($event, file)"
             (click)="onFileClick(file, $event)"
             (dblclick)="onFileDblClick(file, $event)"
             (contextmenu)="onContextMenu(file, $event)">
          @if (file.isFolder && isDefaultTheme()) {
            <div class="default-preview-viewport folder-preview-viewport" aria-hidden="true"
                 appThumbnailViewport [appThumbnailViewportTarget]="isLocked() ? null : getFolderPreviewCandidate(file)">
              @if (isLocked()) {
                <app-default-locked-preview />
              } @else {
                <img class="folder-art-layer folder-back" src="icons-test/folder-back.ico" alt="" />
                @if (getFolderThumbnail(file); as thumbnail) {
                  <span class="folder-thumbnail default-folder-preview">
                    <img class="folder-thumbnail-image default-folder-preview-image" [src]="thumbnail" alt="" />
                  </span>
                  <img class="folder-art-layer folder-front" src="icons-test/folder-front.ico" alt="" />
                } @else {
                  <img class="folder-art-layer folder-default" src="icons-test/folder-default.ico" alt="" />
                }
              }
            </div>
          }
          <div class="file-card-header">
            <div class="folder-card-content">
              @if (!file.isFolder && (!isLocked() || !isDefaultTheme())) { <app-file-icon [fileType]="file.type" [locked]="isLocked()" /> }
              <span class="file-name" [title]="getDisplayName(file)">{{ getDisplayName(file) }}</span>
            </div>
            @if (!isLocked()) {
              <button class="grid-action-btn" (click)="toggleMenu(file, $event); $event.stopPropagation()">
                <span class="material-symbols-outlined">more_vert</span>
              </button>
            }
          </div>
          @if (!file.isFolder) {
            <div class="default-preview-viewport file-card-thumbnail"
                 appThumbnailViewport [appThumbnailViewportTarget]="isLocked() ? null : thumbnailCandidate(file)"
                 [class.locked-preview-viewport]="isLocked() && isDefaultTheme()"
                 [style.background-image]="!isLocked() && driveStore.thumbnails()[file.id] ? 'url(' + driveStore.thumbnails()[file.id] + ')' : ''">
              @if (isLocked() && isDefaultTheme()) {
                <app-default-locked-preview />
              } @else if (!driveStore.thumbnails()[file.id]) {
                <app-file-icon [fileType]="file.type" [locked]="isLocked()" class="thumbnail-icon" />
              }
            </div>
          }
        </div>
      </ng-template>

      @if (selectedCount() > 0 && viewMode() !== 'computer') {
        <div class="bulk-action-bar" (click)="$event.stopPropagation()">
          <div class="bulk-selection-count">
            <button class="bulk-close-btn" (click)="clearSelection()" title="Limpar seleção">
              <span class="material-symbols-outlined">close</span>
            </button>
            {{ selectedCount() }} {{ selectedCount() === 1 ? 'item selecionado' : 'itens selecionados' }}
          </div>
          <div class="bulk-actions-group">
            @if (viewMode() === 'trash') {
              <button class="bulk-btn" (click)="onBulkRestore()" title="Restaurar selecionados">
                <span class="material-symbols-outlined">restore</span>
              </button>
              <button class="bulk-btn" (click)="onBulkPermanentDelete()" title="Excluir selecionados permanentemente" style="color: #d93025;">
                <span class="material-symbols-outlined">delete_forever</span>
              </button>
            } @else {
              <button class="bulk-btn" (click)="onBulkDownload()" title="Baixar selecionados">
                <span class="material-symbols-outlined">download</span>
              </button>
              <button class="bulk-btn" (click)="onBulkDelete()" title="Mover selecionados para a lixeira">
                <span class="material-symbols-outlined">delete</span>
              </button>
            }
          </div>
        </div>
      }

      @if (driveStore.displayMode() === 'grid' && viewMode() !== 'storage' && files().length > 0) {
        <ng-template #gridRendererTpl>
        <div class="grid-layout" [attr.data-renderer]="isDefaultTheme() ? 'default' : 'gdrive'">
          <!-- Sort Header for Grid Mode -->
          <div class="grid-sort-header">
            <button class="sort-dropdown-btn" (click)="toggleSortMenu($event)">
              {{ getSortLabel() }} 
              <span class="material-symbols-outlined sort-icon-small">
                {{ sortDirection() === 'asc' ? 'arrow_upward' : 'arrow_downward' }}
              </span>
            </button>
          </div>

          @if (sortFoldersMode() === 'top') {
            @if (sortedFolders().length > 0) {
              <div class="grid-section">
                <div class="grid-container folders-grid">
                  @for (file of sortedFolders(); track itemKey(file)) {
                    <ng-container *ngTemplateOutlet="folderCardTpl; context: { file: file }"></ng-container>
                  }
                </div>
              </div>
            }
            @if (sortedFilesOnly().length > 0) {
              <div class="grid-section">
                <div class="grid-container files-grid">
                  @for (file of sortedFilesOnly(); track itemKey(file)) {
                    <ng-container *ngTemplateOutlet="fileCardTpl; context: { file: file }"></ng-container>
                  }
                </div>
              </div>
            }
          } @else {
            <div class="grid-section">
              <div class="grid-container mixed-grid">
                @for (file of sortedFiles(); track itemKey(file)) {
                  <ng-container *ngTemplateOutlet="fileCardTpl; context: { file: file }"></ng-container>
                }
              </div>
            </div>
          }
        </div>
        </ng-template>
        @if (isDefaultTheme()) {
          <div class="grid-renderer default-grid-renderer"><ng-container *ngTemplateOutlet="gridRendererTpl"></ng-container></div>
        } @else {
          <div class="grid-renderer gdrive-grid-renderer"><ng-container *ngTemplateOutlet="gridRendererTpl"></ng-container></div>
        }
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
          <div class="col col-actions" *ngIf="!isLocked()">
            <button class="sort-btn-list" (click)="toggleSortMenu($event)">
              <span class="material-symbols-outlined">sort</span>
              Sort
            </button>
          </div>
        </div>
        <div class="file-list-body">
          @for (file of sortedFiles(); track itemKey(file)) {
            <div class="file-row selectable-item" [attr.data-item-key]="itemKey(file)"
                 tabindex="0"
                 role="row"
                 [class.storage-view]="viewMode() === 'storage'"
                 [class.unlocked]="!isLocked()"
                 [class.selected]="isFileSelected(file)"
                 [class.dragging]="isDragged(file)"
                 [class.drag-over]="dragOverItemKey() === itemKey(file)"
                 [attr.draggable]="canDrag(file) ? 'true' : null"
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
              </div>
            </div>
          }
        </div>
      }

      @if (viewMode() === 'computer' && files().length === 0 && !loading()) {
        <div class="computer-empty-state" role="status">{{ emptyMessage() }}</div>
      }
      @if (viewMode() === 'computer' && hasMore()) {
        <button class="computer-load-more" (click)="loadMoreRequested.emit()" [disabled]="loading()">Carregar mais</button>
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
          <div class="menu-divider"></div>
          <button class="menu-item" (click)="onUploadFile($event)">
            <span class="material-symbols-outlined">upload_file</span>
            Upload arquivo
          </button>
        </div>
      }

      @if (activeMenuFile()) {
        <app-file-context-menu
          [file]="activeMenuFile()!"
          [viewMode]="viewMode()"
          [position]="contextMenuPosition()"
          [hasProxy]="hasProxy(activeMenuFile()!)"
          [canMove]="canRequestStorageMove(activeMenuFile()!)"
          [shareDisabled]="!getShareAvailability(activeMenuFile()!).allowed"
          [shareDisabledReason]="getShareReason(activeMenuFile()!)"
          [shareDisabledMessage]="getShareMessage(activeMenuFile()!)"
          [showPin]="viewMode() === 'drive' && activeMenuFile()!.isFolder && activeMenuFile()!.id !== -9999"
          [pinPending]="pinnedFoldersStore.isPending(activeMenuFile()!.id)"
          [pinLabel]="pinnedFoldersStore.isPinned(activeMenuFile()!.id) ? 'Desafixar do acesso rápido' : 'Fixar no acesso rápido'"
          (action)="onContextMenuAction(activeMenuFile()!, $event)" />
      }

      @if (isSortMenuOpen()) {
        <app-file-sort-menu
          [position]="sortMenuPosition()"
          [column]="sortColumn()"
          [direction]="sortDirection()"
          [foldersMode]="sortFoldersMode()"
          (columnChange)="setSort($event); isSortMenuOpen.set(false)"
          (directionChange)="setSortDirection($event); isSortMenuOpen.set(false)"
          (foldersModeChange)="setSortFoldersMode($event); isSortMenuOpen.set(false)" />
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
        height: 100%;
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
        box-sizing: border-box;
        position: relative;
      }
      .selection-box {
        position: fixed;
        background-color: rgba(66, 133, 244, 0.2);
        border: 1px solid rgba(66, 133, 244, 0.5);
        pointer-events: none;
        z-index: 100;
      }
      .grid-sort-header {
        display: flex;
        align-items: center;
        position: relative;
        margin-bottom: -17px;
      }
      .sort-dropdown-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        background: transparent;
        border: none;
        color: #202124;
        font-family: inherit;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        padding: 8px 16px;
        border-radius: 24px;
        transition: background 150ms ease;
        height: 40px;
      }
      .sort-dropdown-btn:hover {
        background: #e8eaed;
      }
      .sort-icon-small {
        font-size: 16px;
      }
      .col-actions {
        position: relative;
      }
      .sort-btn-list {
        display: flex;
        align-items: center;
        gap: 4px;
        background: rgba(66, 133, 244, 0.1);
        color: #1a73e8;
        border: none;
        border-radius: 16px;
        padding: 4px 12px;
        font-family: inherit;
        font-weight: 500;
        cursor: pointer;
        font-size: 13px;
      }
      .sort-btn-list:hover {
        background: rgba(66, 133, 244, 0.2);
      }
      .sort-btn-list .material-symbols-outlined {
        font-size: 18px;
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
        grid-template-columns: 1fr 140px 160px 120px 140px;
      }

      .file-list-header.storage-view {
        grid-template-columns: 1fr 140px 200px;
      }
      .file-list-header.storage-view.unlocked {
        grid-template-columns: 1fr 140px 200px 140px;
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
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
        box-sizing: border-box;
      }

      .computer-empty-state {
        display: grid;
        flex: 1 1 auto;
        min-height: 160px;
        place-items: center;
        padding: 24px;
        color: var(--default-workspace-muted, #6b7280);
        text-align: center;
      }

      .computer-load-more {
        align-self: center;
        margin: 10px;
        padding: 7px 14px;
        border: 1px solid var(--default-border-strong, #9ca3af);
        border-radius: 4px;
        background: var(--default-surface, transparent);
        color: inherit;
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
        grid-template-columns: 1fr 140px 160px 120px 140px;
      }

      .file-row.storage-view {
        grid-template-columns: 1fr 140px 200px;
      }
      .file-row.storage-view.unlocked {
        grid-template-columns: 1fr 140px 200px 140px;
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

      /* Bulk Action Bar */
      .bulk-action-bar {
        position: fixed;
        top: 80px;
        left: 50%;
        transform: translateX(-50%);
        background: #f1f3f4;
        border-radius: 24px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1), 0 1px 3px rgba(0,0,0,0.08);
        display: flex;
        align-items: center;
        padding: 4px 12px;
        gap: 16px;
        z-index: 1000;
        animation: slideDown 200ms cubic-bezier(0.4, 0, 0.2, 1);
      }
      @keyframes slideDown {
        from { opacity: 0; transform: translate(-50%, -20px); }
        to { opacity: 1; transform: translate(-50%, 0); }
      }
      .bulk-selection-count {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 14px;
        font-family: 'Roboto', sans-serif;
        color: #1f1f1f;
      }
      .bulk-close-btn {
        background: transparent;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        width: 32px;
        height: 32px;
        color: #1f1f1f;
      }
      .bulk-close-btn:hover {
        background: rgba(60,64,67,0.08);
      }
      .bulk-actions-group {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .bulk-btn {
        background: transparent;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        width: 40px;
        height: 40px;
        color: #444746;
      }
      .bulk-btn:hover {
        background: rgba(60,64,67,0.08);
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

      .menu-divider {
        height: 1px;
        background: #e8eaed;
        margin: 4px 0;
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
        flex: 1 1 auto;
        min-height: 0;
        height: auto;
        padding: 16px 24px;
        display: flex;
        flex-direction: column;
        gap: 24px;
        overflow-y: auto;
        overflow-x: hidden;
        align-content: start;
        align-items: stretch;
        box-sizing: border-box;
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
        width: 100%;
        align-content: start;
        align-items: start;
      }
      .folders-grid, .files-grid, .mixed-grid {
        grid-template-columns: repeat(auto-fill, minmax(220px, 300px));
      }
      .grid-card {
        width: 100%;
        box-sizing: border-box;
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
      .folder-card.locked-folder {
        width: 100%;
        min-width: 0;
        align-items: stretch;
        box-sizing: border-box;
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
        height: 240px;
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

      /* Windows Explorer variant: scoped so the GDrive theme keeps its exact styling. */
      :host-context(:root[data-theme='default']) .file-list-container {
        background: var(--default-workspace-bg);
        color: var(--default-workspace-text);
        font-family: 'Segoe UI', sans-serif;
        isolation: isolate;
      }
      :host-context(:root[data-theme='default']) .selection-box {
        background: color-mix(in srgb, var(--default-workspace-selected) 72%, transparent);
        border-color: var(--default-workspace-selected-border);
      }
      :host-context(:root[data-theme='default']) .file-list-header {
        height: 30px;
        padding: 0 12px;
        border-color: var(--default-workspace-border);
        background: var(--default-workspace-surface);
      }
      :host-context(:root[data-theme='default']) .file-list-body {
        background: var(--default-workspace-bg);
      }
      :host-context(:root[data-theme='default']) .file-row {
        height: 34px;
        padding: 0 12px;
        border-color: var(--default-workspace-border);
        color: var(--default-workspace-text);
        transition: none;
      }
      :host-context(:root[data-theme='default']) .file-row:hover,
      :host-context(:root[data-theme='default']) .file-row:active {
        background: var(--default-workspace-hover);
      }
      :host-context(:root[data-theme='default']) .file-row:focus-visible {
        outline: 1px solid var(--default-workspace-selected-border);
        outline-offset: -1px;
        background: var(--default-workspace-selected);
      }
      :host-context(:root[data-theme='default']) .file-row.selected {
        background: var(--default-workspace-selected) !important;
      }
      :host-context(:root[data-theme='default']) .file-row.selected .file-name,
      :host-context(:root[data-theme='default']) .file-row.selected .col-owner,
      :host-context(:root[data-theme='default']) .file-row.selected .col-modified,
      :host-context(:root[data-theme='default']) .file-row.selected .col-size {
        color: var(--default-workspace-text);
      }
      :host-context(:root[data-theme='default']) .file-row.dragging {
        background: var(--default-workspace-surface-alt);
      }
      :host-context(:root[data-theme='default']) .file-row.drag-over {
        background: var(--default-workspace-selected) !important;
        outline-color: var(--default-workspace-selected-border) !important;
      }
      :host-context(:root[data-theme='default']) .sortable-header,
      :host-context(:root[data-theme='default']) .col-owner,
      :host-context(:root[data-theme='default']) .col-modified,
      :host-context(:root[data-theme='default']) .col-size,
      :host-context(:root[data-theme='default']) .col-quota {
        color: var(--default-workspace-muted);
      }
      :host-context(:root[data-theme='default']) .sortable-header:hover,
      :host-context(:root[data-theme='default']) .file-name {
        color: var(--default-workspace-text);
      }
      :host-context(:root[data-theme='default']) .grid-layout {
        flex: 1;
        gap: 10px;
        padding: 8px 12px 12px;
        background: var(--default-workspace-bg);
      }
      :host-context(:root[data-theme='default']) .grid-sort-header {
        min-height: 30px;
        margin: 0;
        border-bottom: 1px solid var(--default-workspace-border);
      }
      :host-context(:root[data-theme='default']) .grid-container {
        gap: 8px 4px;
      }
      :host-context(:root[data-theme='default']) .folders-grid,
      :host-context(:root[data-theme='default']) .files-grid,
      :host-context(:root[data-theme='default']) .mixed-grid {
        grid-template-columns: repeat(auto-fill, minmax(var(--default-grid-tile-width), var(--default-grid-tile-width)));
      }
      .grid-renderer {
        display: contents;
      }
      :host-context(:root[data-theme='default']) .grid-card {
        width: var(--default-grid-tile-width);
        height: var(--default-grid-tile-height);
        border: 1px solid transparent;
        border-radius: 0;
        background: transparent;
        transition: none;
        overflow: hidden;
      }
      :host-context(:root[data-theme='default']) .grid-card:hover {
        border-color: var(--default-workspace-border);
        background: var(--default-workspace-hover);
      }
      :host-context(:root[data-theme='default']) .grid-card.selected {
        border-color: var(--default-workspace-selected-border);
        background: var(--default-workspace-selected);
      }
      :host-context(:root[data-theme='default']) .folder-card,
      :host-context(:root[data-theme='default']) .mixed-folder-card {
        flex-direction: column;
        justify-content: flex-start;
        padding: 0;
      }
      :host-context(:root[data-theme='default']) .folder-card.locked-folder {
        align-items: stretch;
      }
      :host-context(:root[data-theme='default']) .default-preview-viewport {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        width: var(--default-grid-preview-width);
        height: var(--default-grid-preview-height);
        margin: 0 auto 6px;
        box-sizing: border-box;
        overflow: hidden;
        flex: 0 0 var(--default-grid-preview-height);
      }
      :host-context(:root[data-theme='default']) .file-card-thumbnail {
        order: 1;
        border: 1px solid var(--default-media-border);
        background-color: var(--default-thumbnail-bg);
        background-repeat: no-repeat;
        background-size: contain;
      }
      :host-context(:root[data-theme='default']) .file-card-thumbnail.locked-preview-viewport {
        border: 0;
        background: transparent;
      }
      :host-context(:root[data-theme='default']) .folder-art-layer {
        position: absolute;
        left: 50%;
        top: 50%;
        display: block;
        width: var(--default-folder-stage-width);
        height: var(--default-folder-stage-height);
        margin-left: calc(var(--default-folder-stage-width) / -2);
        margin-top: calc(var(--default-folder-stage-height) / -2);
        object-fit: contain;
        transform: scale(var(--default-folder-art-scale));
        transform-origin: center;
        pointer-events: none;
      }
      :host-context(:root[data-theme='default']) .folder-back { z-index: 0; }
      :host-context(:root[data-theme='default']) .folder-front { z-index: 2; }
      :host-context(:root[data-theme='default']) .folder-thumbnail {
        position: absolute;
        left: calc((100% - var(--default-folder-thumbnail-width)) / 2);
        top: calc((100% - var(--default-folder-thumbnail-height)) / 2);
        width: var(--default-folder-thumbnail-width);
        height: var(--default-folder-thumbnail-height);
        z-index: 1;
        display: block;
        overflow: hidden;
        box-sizing: border-box;
        background: var(--default-workspace-surface);
        border: 1px solid #b17e14;
      }
      :host-context(:root[data-theme='default']) .folder-thumbnail-image {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      :host-context(:root[data-theme='default']) .folder-card > .folder-card-content,
      :host-context(:root[data-theme='default']) .mixed-folder-card .file-card-header {
        width: var(--default-grid-label-width);
        max-width: 100%;
        height: var(--default-grid-label-height);
        min-height: var(--default-grid-label-height);
        padding: 0 5px;
        box-sizing: border-box;
        justify-content: center;
      }
      :host-context(:root[data-theme='default']) .folder-card > .folder-card-content > app-file-icon,
      :host-context(:root[data-theme='default']) .mixed-folder-card .file-card-header app-file-icon,
      :host-context(:root[data-theme='default']) .mixed-folder-card .file-card-thumbnail {
        display: none;
      }
      :host-context(:root[data-theme='default']) .folder-card.locked-folder > .folder-card-content > app-file-icon,
      :host-context(:root[data-theme='default']) .mixed-folder-card.locked-folder .file-card-header app-file-icon {
        display: none;
      }
      :host-context(:root[data-theme='default']) .folder-card-content {
        justify-content: center;
        gap: 0;
      }
      :host-context(:root[data-theme='default']) .folder-card-content .file-name {
        max-height: 32px;
        color: var(--default-workspace-text);
        font-size: 12px;
        font-weight: 400;
        line-height: 16px;
        text-align: center;
        white-space: normal;
      }
      :host-context(:root[data-theme='default']) .grid-action-btn {
        position: absolute;
        top: 2px;
        right: 2px;
        z-index: 2;
        opacity: 0;
        background: var(--default-context-bg);
      }
      :host-context(:root[data-theme='default']) .grid-card:hover .grid-action-btn,
      :host-context(:root[data-theme='default']) .grid-card:focus-within .grid-action-btn {
        opacity: 1;
      }
      :host-context(:root[data-theme='default']) .file-card:not(.mixed-folder-card) {
        height: var(--default-grid-tile-height);
      }
      :host-context(:root[data-theme='default']) .file-card:not(.mixed-folder-card) .file-card-header {
        order: 2;
        height: var(--default-grid-label-height);
        padding: 3px 5px 2px;
      }
      :host-context(:root[data-theme='default']) .file-card:not(.mixed-folder-card) .file-card-header app-file-icon {
        display: none;
      }
      :host-context(:root[data-theme='default']) .video-card .file-card-thumbnail {
        border-color: #707070;
        box-shadow: inset 0 0 0 2px #0d0d0d;
      }
      :host-context(:root[data-theme='default']) .image-card .file-card-thumbnail {
        border-color: var(--default-workspace-border);
      }
      :host-context(:root[data-theme='default']) .thumbnail-icon {
        opacity: .55;
        transform: scale(2);
      }
    `
  ],
})
export class FileListComponent implements OnInit, OnDestroy, AfterViewInit {
  readonly formatBytes = (bytes: number) => formatBytesValue(bytes, 2);
  private readonly appState = inject(AppStateService);
  readonly driveStore = inject(DriveStore);
  private readonly ngZone = inject(NgZone);
  private readonly renderer = inject(Renderer2);
  private readonly dialogService = inject(DialogService);

  private clickUnsub: (() => void) | null = null;
  private resizeUnsub: (() => void) | null = null;
  private scrollUnsub: (() => void) | null = null;
  @ViewChildren(ThumbnailViewportTargetDirective) private readonly thumbnailTargets!: QueryList<ThumbnailViewportTargetDirective>;
  private thumbnailObserver: IntersectionObserver | null = null;
  private thumbnailTargetsSubscription: Subscription | null = null;
  private readonly observedThumbnailTargets = new Set<HTMLElement>();
  private readonly requestedThumbnailCandidates = new Map<HTMLElement, number>();
  private readonly thumbnailTargetByElement = new Map<HTMLElement, ThumbnailViewportTargetDirective>();

  constructor() {
    effect(() => {
      this.driveStore.displayMode();
      this.viewMode();
      this.isLocked();
      this.sortedFiles();
      this.folderPreviewByFolderId();
      queueMicrotask(() => this.syncThumbnailTargets());
    });
    let previousResetState: string | undefined;
    effect(() => {
      const resetState = `${this.viewMode()}:${this.selectionResetKey()}`;
      if (previousResetState !== undefined && previousResetState !== resetState) {
        this.selectedItemKeys.set(new Set());
        this.closeMenu();
      }
      previousResetState = resetState;
    });
  }

  ngOnInit() {
    this.ngZone.runOutsideAngular(() => {
      this.clickUnsub = this.renderer.listen('document', 'click', () => {
        if (this.activeMenuItem() !== null || this.isContainerMenuOpen()) {
          this.ngZone.run(() => this.closeMenu());
        }
      });

      this.resizeUnsub = this.renderer.listen('window', 'resize', () => {
        if (this.activeMenuItem() !== null || this.isContainerMenuOpen()) {
          this.ngZone.run(() => this.closeMenu());
        }
      });

      this.scrollUnsub = this.renderer.listen('window', 'scroll', () => {
        if (this.activeMenuItem() !== null || this.isContainerMenuOpen()) {
          this.ngZone.run(() => this.closeMenu());
        }
      });
    });
  }

  ngAfterViewInit() {
    if (typeof IntersectionObserver !== 'undefined') {
      this.thumbnailObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const element = entry.target as HTMLElement;
          const target = this.thumbnailTargetByElement.get(element);
          const candidate = target?.appThumbnailViewportTarget;
          if (!candidate || this.isLocked() || this.driveStore.displayMode() !== 'grid' || this.viewMode() === 'storage') continue;
          if (this.requestedThumbnailCandidates.get(element) === candidate.id) continue;
          this.requestedThumbnailCandidates.set(element, candidate.id);
          const observer = this.thumbnailObserver;
          observer?.unobserve(element);
          this.observedThumbnailTargets.delete(element);
          void this.driveStore.loadThumbnail(candidate);
        }
      }, { root: null, rootMargin: '0px', threshold: 0.01 });
    }
    this.thumbnailTargetsSubscription = this.thumbnailTargets.changes.subscribe(() => this.syncThumbnailTargets());
    this.syncThumbnailTargets();
  }

  ngOnDestroy() {
    if (this.clickUnsub) this.clickUnsub();
    if (this.resizeUnsub) this.resizeUnsub();
    if (this.scrollUnsub) this.scrollUnsub();
    this.thumbnailTargetsSubscription?.unsubscribe();
    this.thumbnailObserver?.disconnect();
    this.observedThumbnailTargets.clear();
    this.thumbnailTargetByElement.clear();
    this.requestedThumbnailCandidates.clear();
  }

  readonly files = input.required<DriveFile[]>();
  readonly viewMode = input<'drive' | 'storage' | 'computer' | 'trash'>('drive');
  readonly quota = input<QuotaState | null>(null);
  readonly folderPreviewFiles = input<DriveFile[]>([]);
  readonly movingFileIds = input<ReadonlySet<number>>(new Set<number>());
  readonly selectionResetKey = input('');
  readonly hasMore = input(false);
  readonly loading = input(false);
  readonly emptyMessage = input('Esta unidade não possui arquivos Nanika.');

  @Output() createFolderRequested = new EventEmitter<void>();
  @Output() uploadFileRequested = new EventEmitter<void>();
  @Output() previewRequested = new EventEmitter<FilePreviewRequest>();
  @Output() shareRequested = new EventEmitter<DriveFile>();
  @Output() folderOpenRequested = new EventEmitter<DriveFile>();
  @Output() storageMoveRequested = new EventEmitter<DriveFile>();
  @Output() loadMoreRequested = new EventEmitter<void>();
  private readonly selectedItemKeys = signal<Set<string>>(new Set());

  readonly isLocked = this.appState.isLocked;
  readonly activeMenuItem = signal<DriveFile | null>(null);
  readonly contextMenuPosition = signal<{ x: number, y: number } | null>(null);
  readonly isContainerMenuOpen = signal(false);
  readonly sortMenuPosition = signal<{ x: number, y: number } | null>(null);

  readonly activeMenuFile = computed(() => this.activeMenuItem());

  selectedCount(): number {
    const selected = this.selectedItemKeys();
    return selected.size > 0 ? selected.size : this.driveStore.selectedFileIds().size;
  }

  isFileSelected(file: DriveFile): boolean {
    const selected = this.selectedItemKeys();
    return selected.size > 0 ? selected.has(this.itemKey(file)) : this.driveStore.selectedFileIds().has(file.id);
  }

  canDrag(file: DriveFile): boolean {
    return this.viewMode() !== 'computer' && !this.isLocked() && file.id !== -9999;
  }

  itemKey(file: DriveFile): string {
    return `${file.isFolder ? 'folder' : 'file'}:${file.id}`;
  }

  canRequestStorageMove(file: DriveFile): boolean {
    return this.viewMode() !== 'trash'
      && !file.isFolder
      && file.id !== -9999
      && !file.isHidden
      && !this.isLocked()
      && !this.movingFileIds().has(file.id);
  }

  readonly draggedFiles = signal<DriveFile[]>([]);
  readonly dragOverItemKey = signal<string | null>(null);

  isDragged(file: DriveFile): boolean {
    return this.draggedFiles().some(f => this.itemKey(f) === this.itemKey(file));
  }

  sortColumn = signal<FileSortColumn>('name');
  sortDirection = signal<'asc' | 'desc'>('asc');
  sortFoldersMode = signal<'top' | 'mixed'>('top');
  isSortMenuOpen = signal(false);

  isDraggingSelection = signal(false);
  selectionBox = signal({ startX: 0, startY: 0, x: 0, y: 0, w: 0, h: 0 });
  private dragSelectionInitialSet = new Set<string>();
  private readonly elRef = inject(ElementRef);
  readonly pinnedFoldersStore = inject(PinnedFoldersStore);

  isDefaultTheme(): boolean {
    return document.documentElement.dataset['theme'] === 'default';
  }

  closeMenu() {
    this.activeMenuItem.set(null);
    this.contextMenuPosition.set(null);
    this.isContainerMenuOpen.set(false);
  }

  toggleMenu(file: DriveFile, event: MouseEvent) {
    event.stopPropagation();
    this.isContainerMenuOpen.set(false);

    if (this.activeMenuItem() === file) {
      this.activeMenuItem.set(null);
      this.contextMenuPosition.set(null);
    } else {
      this.activeMenuItem.set(file);

      const target = event.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();

      this.contextMenuPosition.set({
        x: rect.right - 180, // Align menu to right edge of button (approx width 180)
        y: rect.bottom + 4
      });
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
    this.activeMenuItem.set(file);
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
    this.activeMenuItem.set(null);
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

  async togglePinned(file: DriveFile, event: Event): Promise<void> {
    event.stopPropagation();
    try {
      if (this.pinnedFoldersStore.isPinned(file.id)) {
        await this.pinnedFoldersStore.unpin(file.id);
      } else {
        await this.pinnedFoldersStore.pin(file.id);
      }
      this.closeMenu();
    } catch (error) {
      console.error('Erro ao atualizar pasta fixada', error);
    }
  }

  onDragStart(event: DragEvent, file: DriveFile, previewEl: HTMLElement) {
    if (!this.canDrag(file)) {
      event.preventDefault();
      return;
    }

    let filesToDrag = [file];
    const selection = this.selectedItemKeys();
    if (selection.has(this.itemKey(file)) || (selection.size === 0 && this.driveStore.selectedFileIds().has(file.id))) {
      filesToDrag = this.getSelectedFiles();
    }
    this.draggedFiles.set(filesToDrag);

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
      if (filesToDrag.length > 1) {
        nameEl.textContent = `${filesToDrag.length} itens`;
        if (iconEl) {
          iconEl.textContent = 'file_copy';
          iconEl.style.color = '#1a73e8';
          iconEl.style.fontVariationSettings = "'FILL' 0";
        }
      } else {
        nameEl.textContent = this.getDisplayName(file);
      }
    }

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', filesToDrag.map(f => f.id).join(','));
      // Adjust offset so mouse cursor centers on preview card
      event.dataTransfer.setDragImage(previewEl, 20, 20);
    }
  }

  onDragOver(event: DragEvent, targetFile: DriveFile) {
    if (this.viewMode() === 'computer' || this.isLocked()) return;
    const draggedItems = this.draggedFiles();
    if (draggedItems.length === 0) return;

    // Only folders can receive items
    if (!targetFile.isFolder) return;

    for (const dragged of draggedItems) {
      if (targetFile.id === -9999) {
        // Cannot drop back to parent if already in root or already in that parent
        if (dragged.parentId === targetFile.parentId || dragged.folderId === targetFile.parentId) return;
      } else {
        // Cannot drop an item into itself
        if (dragged.id === targetFile.id) return;

        // Cannot drop into its own parent folder
        if (dragged.parentId === targetFile.id || dragged.folderId === targetFile.id) return;
      }
    }

    // Prevent default to allow drop
    event.preventDefault();
    this.dragOverItemKey.set(this.itemKey(targetFile));
  }

  onDragLeave(_event: DragEvent, file: DriveFile) {
    if (this.dragOverItemKey() === this.itemKey(file)) {
      this.dragOverItemKey.set(null);
    }
  }

  onDragEnd() {
    this.draggedFiles.set([]);
    this.dragOverItemKey.set(null);
  }

  async onDrop(event: DragEvent, targetFile: DriveFile) {
    if (this.viewMode() === 'computer' || this.isLocked()) return;
    event.preventDefault();
    this.dragOverItemKey.set(null);

    const draggedItems = this.draggedFiles();
    if (draggedItems.length === 0) return;

    const targetFolderId = (targetFile.id === -9999 ? targetFile.parentId : targetFile.id) ?? null;

    try {
      const movePromises = draggedItems.map(f => this.driveStore.moveItem(f, targetFolderId));
      await Promise.all(movePromises);
    } catch (e: any) {
      alert(e?.message || 'Erro ao mover item(ns)');
    }

    this.draggedFiles.set([]);
    this.clearSelection();
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
    this.activeMenuItem.set(null);
    try {
      await this.driveStore.restoreItem(file);
    } catch (e) {
      alert('Erro ao restaurar');
    }
  }

  async onPermanentDelete(file: DriveFile, event: Event) {
    event.stopPropagation();
    this.activeMenuItem.set(null);
    const confirmed = await this.dialogService.confirm(
      'Excluir permanentemente?',
      `O item "${file.decryptedName || file.encryptedName}" será excluído permanentemente. Não é possível desfazer essa ação.`,
      'Excluir permanentemente',
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
    this.openPreview(file, event);
  }

  onContextMenuAction(file: DriveFile, action: FileContextMenuAction): void {
    const handlers: Record<FileContextMenuAction['type'], (event: Event) => void | Promise<void>> = {
      'open-folder': event => this.onOpenFolder(file, event),
      preview: event => this.onPlayOriginal(file, event),
      'preview-proxy': event => this.onPlayProxy(file, event),
      download: event => this.onDownload(file, event),
      'storage-move': event => this.onStorageMove(file, event),
      share: event => this.onShare(file, event),
      restore: event => this.onRestore(file, event),
      'permanent-delete': event => this.onPermanentDelete(file, event),
      rename: event => this.onRename(file, event),
      'toggle-pin': event => this.togglePinned(file, event),
      delete: event => this.onDelete(file, event),
    };
    void handlers[action.type](action.event);
  }

  onPlayProxy(file: DriveFile, event: Event) {
    this.openPreview(file, event);
  }

  onOpenFolder(file: DriveFile, event: Event): void {
    event.stopPropagation();
    this.closeMenu();
    if (file.isFolder) this.folderOpenRequested.emit(file);
  }

  onStorageMove(file: DriveFile, event: Event): void {
    event.stopPropagation();
    this.closeMenu();
    if (this.canRequestStorageMove(file)) this.storageMoveRequested.emit(file);
  }

  private openPreview(file: DriveFile, event: Event): void {
    event.stopPropagation();
    this.closeMenu();
    const playlist = this.sortedFiles().filter(item => !item.isFolder);
    this.previewRequested.emit({ file, playlist });
  }

  hasProxy(file: DriveFile): boolean {
    const proxyName = file.decryptedName + '.proxy.mp4';
    return this.driveStore.files().some(f => f.decryptedName === proxyName && f.folderId === file.folderId);
  }

  async onRename(file: DriveFile, event: Event) {
    event.stopPropagation();
    this.activeMenuItem.set(null);
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
    this.activeMenuItem.set(null);

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
    this.activeMenuItem.set(null);

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
    const mode = this.viewMode();
    const fileArray = sortFiles(
      this.files(),
      this.sortColumn(),
      this.sortDirection(),
      this.sortFoldersMode(),
      mode === 'storage',
    );

    const currentId = this.driveStore.currentFolderId();
    if (currentId !== null && mode !== 'storage' && mode !== 'trash' && mode !== 'computer') {
      const currentFolder = this.driveStore.files().find(f => f.isFolder && f.id === currentId);
      const parentId = currentFolder?.parentId ?? null;

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
        storageProvider: 'local',
        externalStorageId: null,
        parentId: parentId
      };

      return [parentVirtualFolder, ...fileArray];
    }

    return fileArray;
  });

  sortedFolders = computed(() => this.sortedFiles().filter(f => f.isFolder));
  sortedFilesOnly = computed(() => this.sortedFiles().filter(f => !f.isFolder));

  private readonly folderPreviewByFolderId = computed(() => {
    const candidates = this.viewMode() === 'computer' ? this.folderPreviewFiles() : this.driveStore.files();
    const previews = new Map<number, DriveFile>();
    for (const file of candidates) {
      if (file.isFolder || file.isHidden || file.folderId == null || (file.type !== 'image' && file.type !== 'video')) {
        continue;
      }
      if (!previews.has(file.folderId)) previews.set(file.folderId, file);
    }
    return previews;
  });

  private folderPreviewFile(folder: DriveFile): DriveFile | undefined {
    return this.folderPreviewByFolderId().get(folder.id);
  }

  getFolderPreviewCandidate(folder: DriveFile): DriveFile | null {
    return this.folderPreviewFile(folder) ?? null;
  }

  thumbnailCandidate(file: DriveFile): DriveFile | null {
    return !file.isFolder && !file.isHidden && (file.type === 'image' || file.type === 'video') ? file : null;
  }

  getFolderThumbnail(folder: DriveFile): string | null {
    const preview = this.folderPreviewFile(folder);
    return preview ? this.driveStore.thumbnails()[preview.id] ?? null : null;
  }

  getSortLabel() {
    switch (this.sortColumn()) {
      case 'name': return 'Nome';
      case 'modified': return 'Data de modificação';
      case 'size': return 'Tamanho';
      default: return 'Nome';
    }
  }

  getSortDirectionLabel(dir: 'asc' | 'desc') {
    const col = this.sortColumn();
    if (col === 'name') {
      return dir === 'asc' ? 'A a Z' : 'Z a A';
    } else if (col === 'size') {
      return dir === 'asc' ? 'Menor pro maior' : 'Maior pro menor';
    } else {
      return dir === 'asc' ? 'Mais antigo pro mais recente' : 'Mais recente pro mais antigo';
    }
  }

  setSortDirection(dir: 'asc' | 'desc') {
    this.sortDirection.set(dir);
  }

  setSortFoldersMode(mode: 'top' | 'mixed') {
    this.sortFoldersMode.set(mode);
  }

  toggleSortMenu(event: MouseEvent) {
    event.stopPropagation();
    const willOpen = !this.isSortMenuOpen();
    this.isSortMenuOpen.set(willOpen);

    if (willOpen) {
      const target = event.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const menuWidth = 220; // approximate width of the sort menu

      let x = rect.left;
      if (x + menuWidth > window.innerWidth) {
        x = window.innerWidth - menuWidth - 16;
      }

      this.sortMenuPosition.set({
        x: x,
        y: rect.bottom + 4
      });
      this.closeMenu(); // close file context menus
    } else {
      this.sortMenuPosition.set(null);
    }
  }

  setSort(col: FileSortColumn) {
    if (this.sortColumn() === col) {
      this.sortDirection.update(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortColumn.set(col);
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
    const proxy = this.driveStore.files().find(f => f.decryptedName === proxyName && f.folderId === file.folderId);
    return proxy ? proxy.sizeBytes : 0;
  }

  getTotalSize(file: DriveFile): number {
    return file.sizeBytes + this.getProxySize(file);
  }

  getPercentage(file: DriveFile): string {
    const max = this.getTotalStorageMax();
    if (max === 0) return '0%';
    const pct = (this.getTotalSize(file) / max) * 100;
    if (pct < 0.01 && this.getTotalSize(file) > 0) return '<0.01%';
    return pct.toFixed(2) + '%';
  }

  onFileClick(file: DriveFile, event: MouseEvent) {
    event.stopPropagation();
    if (this.isLocked()) return;

    const currentSelection = new Set(this.selectedItemKeys().size > 0
      ? this.selectedItemKeys()
      : [...this.files()].filter(file => this.driveStore.selectedFileIds().has(file.id)).map(file => this.itemKey(file)));
    if (event.ctrlKey || event.metaKey) {
      const key = this.itemKey(file);
      if (currentSelection.has(key)) {
        currentSelection.delete(key);
      } else {
        currentSelection.add(key);
      }
    } else {
      currentSelection.clear();
      currentSelection.add(this.itemKey(file));
    }
    this.selectedItemKeys.set(currentSelection);
    this.syncDriveSelection(currentSelection);
  }

  onContainerClick(event: MouseEvent) {
    const isDrag = this.selectionBox().w > 5 || this.selectionBox().h > 5;
    if (!event.defaultPrevented && !isDrag) {
      this.clearSelection();
    }
    this.isSortMenuOpen.set(false);
    this.selectionBox.set({ startX: 0, startY: 0, x: 0, y: 0, w: 0, h: 0 }); // reset box
  }

  private selectionMouseMoveListener?: (e: MouseEvent) => void;
  private selectionMouseUpListener?: (e: MouseEvent) => void;

  onContainerMouseDown(event: MouseEvent) {
    if (this.isLocked() || event.button !== 0) return;

    // Don't start drag selection if clicking on an item or a button
    const target = event.target as HTMLElement;
    if (target.closest('.selectable-item') || target.closest('button')) return;

    this.isDraggingSelection.set(true);
    this.selectionBox.set({
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      w: 0,
      h: 0
    });

    if (event.ctrlKey || event.metaKey) {
      this.dragSelectionInitialSet = new Set(this.selectedItemKeys().size > 0
        ? this.selectedItemKeys()
        : [...this.files()].filter(file => this.driveStore.selectedFileIds().has(file.id)).map(file => this.itemKey(file)));
    } else {
      this.dragSelectionInitialSet = new Set();
      this.selectedItemKeys.set(new Set());
      this.driveStore.selectedFileIds.set(new Set());
    }

    // Dynamically bind mouse events to avoid global change detection thrashing
    this.selectionMouseMoveListener = (e: MouseEvent) => this.onWindowMouseMove(e);
    this.selectionMouseUpListener = (e: MouseEvent) => this.onWindowMouseUp(e);
    window.addEventListener('mousemove', this.selectionMouseMoveListener);
    window.addEventListener('mouseup', this.selectionMouseUpListener);

    event.preventDefault(); // prevent text selection
  }

  onWindowMouseMove(event: MouseEvent) {
    if (!this.isDraggingSelection()) return;

    const box = this.selectionBox();
    const currentX = event.clientX;
    const currentY = event.clientY;

    const newX = Math.min(box.startX, currentX);
    const newY = Math.min(box.startY, currentY);
    const newW = Math.abs(currentX - box.startX);
    const newH = Math.abs(currentY - box.startY);

    this.selectionBox.set({ ...box, x: newX, y: newY, w: newW, h: newH });
    this.updateSelectionFromDragBox(newX, newY, newW, newH);
  }

  onWindowMouseUp(_event: MouseEvent) {
    if (this.isDraggingSelection()) {
      this.isDraggingSelection.set(false);
    }
    // Cleanup dynamic listeners
    if (this.selectionMouseMoveListener) {
      window.removeEventListener('mousemove', this.selectionMouseMoveListener);
      this.selectionMouseMoveListener = undefined;
    }
    if (this.selectionMouseUpListener) {
      window.removeEventListener('mouseup', this.selectionMouseUpListener);
      this.selectionMouseUpListener = undefined;
    }
  }

  private updateSelectionFromDragBox(bx: number, by: number, bw: number, bh: number) {
    const items = this.elRef.nativeElement.querySelectorAll('.selectable-item');
    const newSelection = new Set(this.dragSelectionInitialSet);

    const dragRect = { left: bx, top: by, right: bx + bw, bottom: by + bh };

    items.forEach((item: HTMLElement) => {
      const rect = item.getBoundingClientRect();
      const intersects = !(
        rect.right < dragRect.left ||
        rect.left > dragRect.right ||
        rect.bottom < dragRect.top ||
        rect.top > dragRect.bottom
      );

      const key = item.getAttribute('data-item-key');
      if (intersects) {
        if (key && !newSelection.has(key)) newSelection.add(key);
      }
    });

    this.selectedItemKeys.set(newSelection);
    this.syncDriveSelection(newSelection);
  }

  onFileDblClick(file: DriveFile, event: Event) {
    event.stopPropagation();
    if (this.isLocked()) return;
    if (file.id === -9999) {
      if (this.viewMode() !== 'computer') this.driveStore.navigateTo(file.parentId ?? null);
      return;
    }
    if (file.isFolder) {
      if (this.viewMode() === 'computer') this.folderOpenRequested.emit(file);
      else this.driveStore.navigateTo(file.id);
    } else {
      const playlist = this.sortedFiles().filter(f => !f.isFolder);
      this.previewRequested.emit({ file, playlist });
    }
  }

  clearSelection() {
    this.selectedItemKeys.set(new Set());
    this.driveStore.selectedFileIds.set(new Set());
  }

  private syncThumbnailTargets(): void {
    if (!this.thumbnailTargets || !this.thumbnailObserver && typeof IntersectionObserver !== 'undefined') return;

    const active = this.driveStore.displayMode() === 'grid' && this.viewMode() !== 'storage' && !this.isLocked();
    const current = new Set<HTMLElement>();
    for (const target of this.thumbnailTargets) {
      const element = target.element;
      current.add(element);
      this.thumbnailTargetByElement.set(element, target);
      const candidate = active ? target.appThumbnailViewportTarget : null;
      if (!candidate) {
        this.unobserveThumbnailTarget(element);
        this.requestedThumbnailCandidates.delete(element);
        continue;
      }

      if (this.requestedThumbnailCandidates.get(element) === candidate.id) continue;
      this.unobserveThumbnailTarget(element);
      if (!this.thumbnailObserver) {
        this.requestedThumbnailCandidates.set(element, candidate.id);
        void this.driveStore.loadThumbnail(candidate);
      } else {
        this.thumbnailObserver.observe(element);
        this.observedThumbnailTargets.add(element);
      }
    }

    for (const element of [...this.thumbnailTargetByElement.keys()]) {
      if (!current.has(element)) {
        this.unobserveThumbnailTarget(element);
        this.thumbnailTargetByElement.delete(element);
        this.requestedThumbnailCandidates.delete(element);
      }
    }
  }

  private unobserveThumbnailTarget(element: HTMLElement): void {
    if (!this.observedThumbnailTargets.has(element)) return;
    this.thumbnailObserver?.unobserve(element);
    this.observedThumbnailTargets.delete(element);
  }

  getSelectedFiles(): DriveFile[] {
    const selected = this.selectedItemKeys();
    const allFiles = this.viewMode() === 'computer'
      ? this.files()
      : [...this.driveStore.files(), ...this.driveStore.trashFiles()];
    return selected.size > 0
      ? allFiles.filter(file => selected.has(this.itemKey(file)))
      : allFiles.filter(file => this.driveStore.selectedFileIds().has(file.id));
  }

  private syncDriveSelection(keys: ReadonlySet<string>): void {
    if (this.viewMode() === 'computer') return;
    const files = this.viewMode() === 'trash' ? this.driveStore.trashFiles() : this.files();
    this.driveStore.selectedFileIds.set(new Set(
      files.filter(file => keys.has(this.itemKey(file))).map(file => file.id)
    ));
  }

  async onBulkDownload() {
    const files = this.getSelectedFiles();
    const downloadPromises = files
      .filter(f => !f.isFolder)
      .map(async f => {
        try {
          await this.driveStore.downloadFile(f);
        } catch (e) {
          console.error('Erro no download', e);
        }
      });

    await Promise.all(downloadPromises);
    this.clearSelection();
  }

  async onBulkDelete() {
    const files = this.getSelectedFiles();
    const confirmed = await this.dialogService.confirm(
      'Mover para a lixeira?',
      `Tem certeza de que deseja mover os ${files.length} itens selecionados para a lixeira?`,
      'Mover para a lixeira'
    );
    if (!confirmed) return;

    try {
      await this.driveStore.batchTrashItems(files);
    } catch (e) {
      console.error('Erro ao mover para a lixeira', e);
    }
    this.clearSelection();
  }

  async onBulkRestore() {
    const files = this.getSelectedFiles();
    try {
      await this.driveStore.batchRestoreItems(files);
    } catch (e) {
      console.error('Erro ao restaurar lote', e);
    }
    this.clearSelection();
  }

  async onBulkPermanentDelete() {
    const files = this.getSelectedFiles();
    const confirmed = await this.dialogService.confirm(
      'Excluir permanentemente?',
      `Os ${files.length} itens selecionados serão excluídos permanentemente. Não é possível desfazer essa ação.`,
      'Excluir permanentemente',
      true
    );
    if (!confirmed) return;

    try {
      await this.driveStore.batchPermanentDeleteItems(files);
    } catch (e) {
      console.error('Erro ao apagar permanentemente', e);
    }
    this.clearSelection();
  }

  onShare(file: DriveFile, event: Event) {
    event.stopPropagation();
    this.closeMenu();
    if (!getPublicShareAvailability(file).allowed) return;
    this.shareRequested.emit(file);
  }

  getShareAvailability(file: DriveFile) {
    return getPublicShareAvailability(file);
  }

  getShareReason(file: DriveFile): 'folder' | 'google_drive' | undefined {
    const availability = this.getShareAvailability(file);
    return availability.allowed ? undefined : availability.reason;
  }

  getShareMessage(file: DriveFile): string {
    const availability = this.getShareAvailability(file);
    return availability.allowed ? '' : availability.message;
  }
}
