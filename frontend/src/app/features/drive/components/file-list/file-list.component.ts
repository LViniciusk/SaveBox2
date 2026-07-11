import { Component, input, inject, signal, computed, HostListener } from '@angular/core';
import { DriveFile, QuotaState, DriveStore } from '../../state/drive.store';
import { FileIconComponent } from '../../../../shared/ui/file-icon/file-icon.component';
import { AppStateService } from '../../../../core/state/app-state.service';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-file-list',
  standalone: true,
  imports: [FileIconComponent, CommonModule],
  template: `
    <div class="file-list-container">
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

        <div class="col col-quota" *ngIf="viewMode() === 'storage'">
          Uso da cota
        </div>

        <div class="col col-actions" *ngIf="!isLocked()" style="font-size: 12px; font-weight: 500; color: #5f6368; display: flex; justify-content: center;">
          Ações
        </div>
      </div>

      <div class="file-list-body">
        @for (file of sortedFiles(); track file.id) {
          <div class="file-row" tabindex="0" role="row" [class.storage-view]="viewMode() === 'storage'" [class.unlocked]="!isLocked()" (click)="onFileClick(file)" (contextmenu)="onContextMenu(file, $event)">
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
            </div>

            <div class="col col-quota" *ngIf="viewMode() === 'storage'">
               <div class="quota-bar-container" *ngIf="!isLocked()">
                 <span class="quota-percent-text">{{ getPercentage(file) }} da conta</span>
                 <progress class="quota-progress" [value]="file.sizeBytes" [max]="quota()?.maxBytes || 1"></progress>
               </div>
               <span *ngIf="isLocked()">{{ getObfuscatedValue(getPercentage(file) + ' da conta') }}</span>
            </div>

            <!-- Actions Context Menu -->
            <div class="col col-actions" *ngIf="!isLocked()" (click)="$event.stopPropagation()">
              <button class="action-btn" (click)="toggleMenu(file, $event)">
                <span class="material-symbols-outlined">more_vert</span>
              </button>
              
              @if (activeMenuFileId() === file.id) {
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
                    <button class="menu-item" (click)="onMove(file, $event)">
                      <span class="material-symbols-outlined">drive_file_move</span>
                      Mover
                    </button>
                    <div style="height: 1px; background: #e8eaed; margin: 4px 0;"></div>
                    <button class="menu-item" (click)="onDelete(file, $event)" style="color: #d93025;">
                      <span class="material-symbols-outlined" style="color: #d93025;">delete</span>
                      Mover para a lixeira
                    </button>
                  }
                </div>
              }
            </div>
          </div>
        }
      </div>
    </div>
  `,
  styles: [
    `
      .file-list-container {
        width: 100%;
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

      .file-row:focus-visible {
        background: #e8f0fe;
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
    `
  ],
})
export class FileListComponent {
  private readonly appState = inject(AppStateService);
  private readonly driveStore = inject(DriveStore);

  readonly files = input.required<DriveFile[]>();
  readonly viewMode = input<'drive' | 'storage' | 'trash'>('drive');
  readonly quota = input<QuotaState | null>(null);

  readonly isLocked = this.appState.isLocked;
  readonly activeMenuFileId = signal<number | null>(null);
  readonly contextMenuPosition = signal<{ x: number, y: number } | null>(null);

  sortColumn = signal<string>('name');
  sortDirection = signal<'asc' | 'desc'>('asc');

  @HostListener('document:click')
  @HostListener('window:resize')
  @HostListener('window:scroll')
  closeMenu() {
    this.activeMenuFileId.set(null);
    this.contextMenuPosition.set(null);
  }

  toggleMenu(file: DriveFile, event: Event) {
    event.stopPropagation();
    this.contextMenuPosition.set(null);
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
    const confirmed = confirm(`Tem certeza de que deseja apagar permanentemente "${file.decryptedName || file.encryptedName}"? Esta ação não pode ser desfeita.`);
    if (!confirmed) return;
    try {
      await this.driveStore.permanentDeleteItem(file);
    } catch (e) {
      alert('Erro ao apagar permanentemente');
    }
  }

  async onDownload(file: DriveFile, event: Event) {
    event.stopPropagation();
    this.activeMenuFileId.set(null);
    try {
      await this.driveStore.downloadFile(file);
    } catch (e) {
      console.error('Erro no download', e);
      alert('Falha ao transferir ficheiro.');
    }
  }

  async onRename(file: DriveFile, event: Event) {
    event.stopPropagation();
    this.activeMenuFileId.set(null);
    const newName = prompt('Novo nome:', file.decryptedName || file.encryptedName);
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

    const confirmed = confirm(`Tem certeza de que deseja mover "${file.decryptedName || file.encryptedName}" para a lixeira?`);
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

  getPercentage(file: DriveFile): string {
    const q = this.quota();
    if (!q || q.maxBytes === 0) return '0%';
    const pct = (file.sizeBytes / q.maxBytes) * 100;
    if (pct < 0.01 && file.sizeBytes > 0) return '<0.01%';
    return pct.toFixed(2) + '%';
  }

  async onFileClick(file: DriveFile) {
    if (this.isLocked()) return;
    if (file.id === -9999) {
      this.driveStore.navigateTo(file.parentId ?? null);
      return;
    }
    if (file.isFolder) {
      this.driveStore.navigateTo(file.id);
    } else {
      try {
        await this.driveStore.downloadFile(file);
      } catch (e: any) {
        console.error('Erro no download', e);
        alert('Falha ao transferir ficheiro. Pode estar corrompido ou encriptado com outra chave.');
      }
    }
  }
}
