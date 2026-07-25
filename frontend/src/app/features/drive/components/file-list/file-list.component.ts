import { Component, input, inject, signal, computed, Output, EventEmitter, OnInit, OnDestroy, NgZone, Renderer2, effect, HostListener, ViewChildren, QueryList, ElementRef } from '@angular/core';
import { DriveFile, QuotaState, DriveStore } from '../../state/drive.store';
import { FileIconComponent } from '../../../../shared/ui/file-icon/file-icon.component';
import { AppStateService } from '../../../../core/state/app-state.service';
import { CommonModule } from '@angular/common';
import { DialogService } from '../../../../core/dialog/dialog.service';
import { PinnedFoldersStore } from '../../state/pinned-folders.store';

@Component({
  selector: 'app-file-list',
  standalone: true,
  imports: [FileIconComponent, CommonModule],
  host: {
    style: 'display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%;'
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
              Excluir permanentemente
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
              <button class="menu-item" (click)="onShare(file, $event)">
                <span class="material-symbols-outlined">share</span>
                Compartilhar
              </button>
            }
            <button class="menu-item" (click)="onRename(file, $event)">
              <span class="material-symbols-outlined">edit</span>
              Renomear
            </button>
            @if (viewMode() === 'drive' && file.isFolder && file.id !== -9999) {
              <button class="menu-item" [disabled]="pinnedFoldersStore.isPending(file.id)" (click)="togglePinned(file, $event)">
                <span class="material-symbols-outlined">{{ pinnedFoldersStore.isPending(file.id) ? 'hourglass_top' : 'push_pin' }}</span>
                {{ pinnedFoldersStore.isPinned(file.id) ? 'Desafixar do acesso rápido' : 'Fixar no acesso rápido' }}
              </button>
            }
            <div style="height: 1px; background: #e8eaed; margin: 4px 0;"></div>
            <button class="menu-item" (click)="onDelete(file, $event)" style="color: #d93025;">
              <span class="material-symbols-outlined" style="color: #d93025;">delete</span>
              Mover para a lixeira
            </button>
          }
        </div>
      </ng-template>

      <ng-template #folderCardTpl let-file="file">
        <div class="grid-card folder-card selectable-item" [attr.data-id]="file.id"
             [class.selected]="driveStore.selectedFileIds().has(file.id)"
             [class.dragging]="isDragged(file)"
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
          }
        </div>
      </ng-template>

      <ng-template #fileCardTpl let-file="file">
        <div class="grid-card file-card selectable-item" [attr.data-id]="file.id"
             [class.selected]="driveStore.selectedFileIds().has(file.id)"
             [class.dragging]="isDragged(file)"
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
            }
          </div>
          <div class="file-card-thumbnail"
               [style.background-image]="driveStore.thumbnails()[file.id] ? 'url(' + driveStore.thumbnails()[file.id] + ')' : ''">
            @if (!driveStore.thumbnails()[file.id]) {
              <app-file-icon [fileType]="file.type" [locked]="isLocked()" class="thumbnail-icon" />
            }
          </div>
        </div>
      </ng-template>

      <ng-template #sortMenu>
        <div class="sort-menu-dropdown"
             [style.position]="'fixed'"
             [style.top.px]="sortMenuPosition()?.y"
             [style.left.px]="sortMenuPosition()?.x"
             [style.right]="'auto'"
             [style.margin]="'0'"
             [style.z-index]="9999"
             (click)="$event.stopPropagation()">
          <div class="sort-section-title">Ordenar por</div>
          <button class="menu-item" (click)="setSort('name'); isSortMenuOpen.set(false)">
            <span class="material-symbols-outlined check-icon">{{ sortColumn() === 'name' ? 'check' : '' }}</span>
            Nome
          </button>
          <button class="menu-item" (click)="setSort('modified'); isSortMenuOpen.set(false)">
            <span class="material-symbols-outlined check-icon">{{ sortColumn() === 'modified' ? 'check' : '' }}</span>
            Data de modificação
          </button>
          <button class="menu-item" (click)="setSort('size'); isSortMenuOpen.set(false)">
            <span class="material-symbols-outlined check-icon">{{ sortColumn() === 'size' ? 'check' : '' }}</span>
            Tamanho
          </button>
          
          <div class="sort-divider"></div>
          <div class="sort-section-title">Ordem</div>
          <button class="menu-item" (click)="setSortDirection('asc'); isSortMenuOpen.set(false)">
            <span class="material-symbols-outlined check-icon">{{ sortDirection() === 'asc' ? 'check' : '' }}</span>
            {{ getSortDirectionLabel('asc') }}
          </button>
          <button class="menu-item" (click)="setSortDirection('desc'); isSortMenuOpen.set(false)">
            <span class="material-symbols-outlined check-icon">{{ sortDirection() === 'desc' ? 'check' : '' }}</span>
            {{ getSortDirectionLabel('desc') }}
          </button>

          <div class="sort-divider"></div>
          <div class="sort-section-title">Pastas</div>
          <button class="menu-item" (click)="setSortFoldersMode('top'); isSortMenuOpen.set(false)">
            <span class="material-symbols-outlined check-icon">{{ sortFoldersMode() === 'top' ? 'check' : '' }}</span>
            No topo
          </button>
          <button class="menu-item" (click)="setSortFoldersMode('mixed'); isSortMenuOpen.set(false)">
            <span class="material-symbols-outlined check-icon">{{ sortFoldersMode() === 'mixed' ? 'check' : '' }}</span>
            Misturado com arquivos
          </button>
        </div>
      </ng-template>

      @if (driveStore.selectedFileIds().size > 0) {
        <div class="bulk-action-bar" (click)="$event.stopPropagation()">
          <div class="bulk-selection-count">
            <button class="bulk-close-btn" (click)="clearSelection()" title="Limpar seleção">
              <span class="material-symbols-outlined">close</span>
            </button>
            {{ driveStore.selectedFileIds().size }} {{ driveStore.selectedFileIds().size === 1 ? 'item selecionado' : 'itens selecionados' }}
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

      @if (driveStore.displayMode() === 'grid' && viewMode() !== 'storage') {
        <div class="grid-layout">
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
                  @for (file of sortedFolders(); track file.id) {
                    <ng-container *ngTemplateOutlet="folderCardTpl; context: { file: file }"></ng-container>
                  }
                </div>
              </div>
            }
            @if (sortedFilesOnly().length > 0) {
              <div class="grid-section">
                <div class="grid-container files-grid">
                  @for (file of sortedFilesOnly(); track file.id) {
                    <ng-container *ngTemplateOutlet="fileCardTpl; context: { file: file }"></ng-container>
                  }
                </div>
              </div>
            }
          } @else {
            <div class="grid-section">
              <div class="grid-container mixed-grid">
                @for (file of sortedFiles(); track file.id) {
                  <ng-container *ngTemplateOutlet="fileCardTpl; context: { file: file }"></ng-container>
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
          <div class="col col-actions" *ngIf="!isLocked()">
            <button class="sort-btn-list" (click)="toggleSortMenu($event)">
              <span class="material-symbols-outlined">sort</span>
              Sort
            </button>
          </div>
        </div>
        <div class="file-list-body">
          @for (file of sortedFiles(); track file.id) {
            <div class="file-row selectable-item" [attr.data-id]="file.id"
                 tabindex="0"
                 role="row"
                 [class.storage-view]="viewMode() === 'storage'"
                 [class.unlocked]="!isLocked()"
                 [class.selected]="driveStore.selectedFileIds().has(file.id)"
                 [class.dragging]="isDragged(file)"
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

      @if (activeMenuFile()) {
        <ng-container *ngTemplateOutlet="ctxMenu; context: { file: activeMenuFile() }"></ng-container>
      }

      @if (isSortMenuOpen()) {
        <ng-container *ngTemplateOutlet="sortMenu"></ng-container>
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
      .sort-menu-dropdown {
        position: absolute;
        top: 40px;
        left: 16px;
        background: white;
        border: 1px solid #dadce0;
        border-radius: 4px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        padding: 8px 0;
        z-index: 100;
        min-width: 200px;
        display: flex;
        flex-direction: column;
      }
      .col-actions {
        position: relative;
      }
      .col-actions .sort-menu-dropdown {
        left: auto;
        right: 0;
      }
      .sort-section-title {
        padding: 4px 40px;
        font-size: 12px;
        color: #5f6368;
        font-weight: 500;
      }
      .sort-divider {
        height: 1px;
        background-color: #e8eaed;
        margin: 8px 0;
      }
      .check-icon {
        font-size: 18px;
        width: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-right: 8px;
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
      .folders-grid, .files-grid, .mixed-grid {
        grid-template-columns: repeat(auto-fill, minmax(220px, 300px));
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
  @Output() imageSelected = new EventEmitter<{ file: DriveFile, playlist: DriveFile[] }>();
  @Output() shareRequested = new EventEmitter<DriveFile>();

  readonly isLocked = this.appState.isLocked;
  readonly activeMenuFileId = signal<number | null>(null);
  readonly contextMenuPosition = signal<{ x: number, y: number } | null>(null);
  readonly isContainerMenuOpen = signal(false);
  readonly sortMenuPosition = signal<{ x: number, y: number } | null>(null);

  readonly activeMenuFile = computed(() => {
    const id = this.activeMenuFileId();
    if (id === null) return null;
    const allFiles = [...this.driveStore.files(), ...this.driveStore.trashFiles()];
    return allFiles.find(f => f.id === id) || null;
  });

  readonly draggedFiles = signal<DriveFile[]>([]);
  readonly dragOverFolderId = signal<number | null>(null);

  isDragged(file: DriveFile): boolean {
    return this.draggedFiles().some(f => f.id === file.id);
  }

  sortColumn = signal<string>('name');
  sortDirection = signal<'asc' | 'desc'>('asc');
  sortFoldersMode = signal<'top' | 'mixed'>('top');
  isSortMenuOpen = signal(false);

  isDraggingSelection = signal(false);
  selectionBox = signal({ startX: 0, startY: 0, x: 0, y: 0, w: 0, h: 0 });
  private dragSelectionInitialSet = new Set<number>();
  private readonly elRef = inject(ElementRef);
  readonly pinnedFoldersStore = inject(PinnedFoldersStore);

  closeMenu() {
    this.activeMenuFileId.set(null);
    this.contextMenuPosition.set(null);
    this.isContainerMenuOpen.set(false);
  }

  toggleMenu(file: DriveFile, event: MouseEvent) {
    event.stopPropagation();
    this.isContainerMenuOpen.set(false);

    if (this.activeMenuFileId() === file.id) {
      this.activeMenuFileId.set(null);
      this.contextMenuPosition.set(null);
    } else {
      this.activeMenuFileId.set(file.id);

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
    if (this.isLocked() || file.id === -9999) {
      event.preventDefault();
      return;
    }

    let filesToDrag = [file];
    const selection = this.driveStore.selectedFileIds();
    if (selection.has(file.id)) {
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
    if (this.isLocked()) return;
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
    this.dragOverFolderId.set(targetFile.id);
  }

  onDragLeave(event: DragEvent, file: DriveFile) {
    if (this.dragOverFolderId() === file.id) {
      this.dragOverFolderId.set(null);
    }
  }

  onDragEnd() {
    this.draggedFiles.set([]);
    this.dragOverFolderId.set(null);
  }

  async onDrop(event: DragEvent, targetFile: DriveFile) {
    if (this.isLocked()) return;
    event.preventDefault();
    this.dragOverFolderId.set(null);

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

    const foldersMode = this.sortFoldersMode();
    if (foldersMode === 'top') {
      fileArray.sort((a, b) => {
        if (a.isFolder === b.isFolder) return 0;
        return a.isFolder ? -1 : 1;
      });
    }

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

  setSort(col: string) {
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

  onFileClick(file: DriveFile, event: MouseEvent) {
    event.stopPropagation();
    if (this.isLocked()) return;

    const currentSelection = new Set(this.driveStore.selectedFileIds());
    if (event.ctrlKey || event.metaKey) {
      if (currentSelection.has(file.id)) {
        currentSelection.delete(file.id);
      } else {
        currentSelection.add(file.id);
      }
    } else {
      currentSelection.clear();
      currentSelection.add(file.id);
    }
    this.driveStore.selectedFileIds.set(currentSelection);
  }

  onContainerClick(event: MouseEvent) {
    const isDrag = this.selectionBox().w > 5 || this.selectionBox().h > 5;
    if (!event.defaultPrevented && !isDrag) {
      this.driveStore.selectedFileIds.set(new Set());
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
      this.dragSelectionInitialSet = new Set(this.driveStore.selectedFileIds());
    } else {
      this.dragSelectionInitialSet = new Set();
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

  onWindowMouseUp(event: MouseEvent) {
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

      const id = parseInt(item.getAttribute('data-id') || '-1', 10);
      if (intersects) {
        if (!newSelection.has(id)) newSelection.add(id);
      }
    });

    this.driveStore.selectedFileIds.set(newSelection);
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
    } else {
      const playlist = this.sortedFiles().filter(f => !f.isFolder);
      this.imageSelected.emit({ file, playlist });
    }
  }

  clearSelection() {
    this.driveStore.selectedFileIds.set(new Set());
  }

  getSelectedFiles(): DriveFile[] {
    const ids = this.driveStore.selectedFileIds();
    const allFiles = [...this.driveStore.files(), ...this.driveStore.trashFiles()];
    return allFiles.filter(f => ids.has(f.id));
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

  onShare(file: DriveFile, event: MouseEvent) {
    event.stopPropagation();
    this.closeMenu();
    this.shareRequested.emit(file);
  }
}
