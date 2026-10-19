import { Component, input, output } from '@angular/core';
import type { DriveFile } from '../../state/drive.store';

type FileListViewMode = 'drive' | 'storage' | 'computer' | 'trash';
export type FileContextMenuActionType =
  | 'open-folder' | 'preview' | 'preview-proxy' | 'download' | 'storage-move'
  | 'share' | 'restore' | 'permanent-delete' | 'rename' | 'toggle-pin' | 'delete';
export interface FileContextMenuAction {
  type: FileContextMenuActionType;
  event: Event;
}

@Component({
  selector: 'app-file-context-menu',
  standalone: true,
  template: `
    <div class="action-menu"
         [style.position]="position() ? 'fixed' : 'absolute'"
         [style.top]="position() ? (position()!.y + 'px') : '40px'"
         [style.left]="position() ? (position()!.x + 'px') : 'auto'"
         [style.right]="position() ? 'auto' : '20px'"
         [style.margin]="'0'"
         (click)="$event.stopPropagation()">
      @if (viewMode() === 'computer') {
        @if (file().isFolder) {
          <button class="menu-item" (click)="emit('open-folder', $event)"><span class="material-symbols-outlined">folder_open</span>Abrir</button>
        } @else {
          <button class="menu-item" (click)="emit('preview', $event)"><span class="material-symbols-outlined">visibility</span>Preview</button>
          <button class="menu-item" (click)="emit('download', $event)"><span class="material-symbols-outlined">download</span>Baixar</button>
          @if (canMove()) {
            <button class="menu-item" (click)="emit('storage-move', $event)"><span class="material-symbols-outlined">drive_file_move</span>Mover para...</button>
          }
          @if (!shareDisabled()) {
            <button class="menu-item" (click)="emit('share', $event)"><span class="material-symbols-outlined">share</span>Compartilhar</button>
          } @else if (shareDisabledReason() === 'google_drive') {
            <button class="menu-item" disabled aria-disabled="true" [title]="shareDisabledMessage()"><span class="material-symbols-outlined">share_off</span>Compartilhamento indisponível</button>
          }
        }
      } @else if (viewMode() === 'trash') {
        <button class="menu-item" (click)="emit('restore', $event)"><span class="material-symbols-outlined">restore</span>Restaurar</button>
        <div class="menu-divider"></div>
        <button class="menu-item danger" (click)="emit('permanent-delete', $event)"><span class="material-symbols-outlined danger">delete_forever</span>Excluir permanentemente</button>
      } @else {
        @if (!file().isFolder) {
          @if (file().type === 'video' && hasProxy()) {
            <div class="menu-item-wrapper" (mouseenter)="checkSubmenuBounds($event)">
              <button class="menu-item preview-parent"><span><span class="material-symbols-outlined">visibility</span>Preview</span><span class="material-symbols-outlined">chevron_right</span></button>
              <div class="submenu">
                <button class="menu-item" (click)="emit('preview', $event)">Original</button>
                <button class="menu-item" (click)="emit('preview-proxy', $event)">Compacta</button>
              </div>
            </div>
          } @else {
            <button class="menu-item" (click)="emit('preview', $event)"><span class="material-symbols-outlined">visibility</span>Preview</button>
          }
        }
        @if (!file().isFolder) {
          <button class="menu-item" (click)="emit('download', $event)"><span class="material-symbols-outlined">download</span>Baixar</button>
          @if (canMove()) {
            <button class="menu-item" (click)="emit('storage-move', $event)"><span class="material-symbols-outlined">drive_file_move</span>Mover para...</button>
          }
          @if (!shareDisabled()) {
            <button class="menu-item" (click)="emit('share', $event)"><span class="material-symbols-outlined">share</span>Compartilhar</button>
          } @else if (shareDisabledReason() === 'google_drive') {
            <button class="menu-item" disabled aria-disabled="true" [title]="shareDisabledMessage()"><span class="material-symbols-outlined">share_off</span>Compartilhamento indisponível</button>
          }
        }
        <button class="menu-item" (click)="emit('rename', $event)"><span class="material-symbols-outlined">edit</span>Renomear</button>
        @if (showPin()) {
          <button class="menu-item" [disabled]="pinPending()" (click)="emit('toggle-pin', $event)">
            <span class="material-symbols-outlined">{{ pinPending() ? 'hourglass_top' : 'push_pin' }}</span>
            {{ pinLabel() }}
          </button>
        }
        <div class="menu-divider"></div>
        <button class="menu-item danger" (click)="emit('delete', $event)"><span class="material-symbols-outlined danger">delete</span>Mover para a lixeira</button>
      }
    </div>
  `,
  styles: [`
    .action-menu { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(60,64,67,.3), 0 4px 8px 3px rgba(60,64,67,.15); min-width: 180px; z-index: 1000; display: flex; flex-direction: column; padding: 6px 0; animation: fadeIn 150ms ease; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
    .menu-item { background: transparent; border: none; padding: 10px 16px; text-align: left; font-size: 14px; color: #3c4043; cursor: pointer; display: flex; align-items: center; gap: 12px; width: 100%; }
    .menu-item:hover { background: #f1f3f4; color: #202124; }
    .menu-item:disabled { cursor: default; opacity: .6; }
    .menu-item .material-symbols-outlined { font-size: 20px; color: #5f6368; }
    .menu-divider { height: 1px; background: #e8eaed; margin: 4px 0; }
    .danger, .menu-item .danger { color: #d93025; }
    .menu-item-wrapper { position: relative; width: 100%; }
    .preview-parent { justify-content: space-between; }
    .preview-parent > span:first-child { display: flex; align-items: center; gap: 12px; }
    .submenu { display: none; position: absolute; top: 0; left: 100%; background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(60,64,67,.3), 0 4px 8px 3px rgba(60,64,67,.15); min-width: 150px; z-index: 1001; flex-direction: column; padding: 6px 0; }
    .menu-item-wrapper:hover .submenu { display: flex; }
  `]
})
export class FileContextMenuComponent {
  readonly file = input.required<DriveFile>();
  readonly viewMode = input<FileListViewMode>('drive');
  readonly position = input<{ x: number; y: number } | null>(null);
  readonly hasProxy = input(false);
  readonly canMove = input(false);
  readonly shareDisabled = input(false);
  readonly shareDisabledReason = input<'folder' | 'google_drive' | undefined>();
  readonly shareDisabledMessage = input('');
  readonly showPin = input(false);
  readonly pinPending = input(false);
  readonly pinLabel = input('');
  readonly action = output<FileContextMenuAction>();

  emit(type: FileContextMenuActionType, event: Event): void {
    this.action.emit({ type, event });
  }

  checkSubmenuBounds(event: MouseEvent): void {
    const wrapper = event.currentTarget as HTMLElement;
    const submenu = wrapper.querySelector('.submenu') as HTMLElement | null;
    if (!submenu) return;
    if (event.clientX > window.innerWidth / 2) {
      submenu.style.left = 'auto';
      submenu.style.right = '100%';
    } else {
      submenu.style.left = '100%';
      submenu.style.right = 'auto';
    }
  }
}
