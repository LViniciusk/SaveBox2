import { Component, input, inject, signal, computed } from '@angular/core';
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
      <div class="file-list-header" [class.storage-view]="viewMode() === 'storage'">
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
      </div>

      <div class="file-list-body">
        @for (file of sortedFiles(); track file.id) {
          <div class="file-row" tabindex="0" role="row" [class.storage-view]="viewMode() === 'storage'" (click)="onFileClick(file)">
            <div class="col col-name">
              <app-file-icon [fileType]="file.type" [locked]="isLocked()" />
              <span class="file-name">{{ getDisplayName(file) }}</span>
            </div>
            
            <div class="col col-owner" *ngIf="viewMode() === 'drive'">
              {{ isLocked() ? '[Trancado]' : file.owner }}
            </div>
            
            <div class="col col-modified" *ngIf="viewMode() === 'drive'">
              {{ isLocked() ? '[Trancado]' : file.modifiedAt }}
            </div>
            
            <div class="col col-size">
              {{ isLocked() ? '[Trancado]' : file.sizeFormatted }}
            </div>

            <div class="col col-quota" *ngIf="viewMode() === 'storage'">
               <div class="quota-bar-container" *ngIf="!isLocked()">
                 <span class="quota-percent-text">{{ getPercentage(file) }} da conta</span>
                 <progress class="quota-progress" [value]="file.sizeBytes" [max]="quota()?.maxBytes || 1"></progress>
               </div>
               <span *ngIf="isLocked()">[Trancado]</span>
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
        overflow-x: auto;
      }

      .file-list-header {
        display: grid;
        grid-template-columns: 1fr 140px 160px 140px;
        padding: 0 24px;
        height: 40px;
        align-items: center;
        border-bottom: 1px solid #e0e0e0;
      }

      .file-list-header.storage-view {
        grid-template-columns: 1fr 140px 200px;
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
        border-bottom: 1px solid #f1f3f4;
        cursor: pointer;
        transition: background 150ms cubic-bezier(0.4, 0, 0.2, 1);
        outline: none;
      }

      .file-row.storage-view {
        grid-template-columns: 1fr 140px 200px;
      }

      .file-row:hover {
        background: #f8f9fa;
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
    `
  ],
})
export class FileListComponent {
  private readonly appState = inject(AppStateService);
  private readonly driveStore = inject(DriveStore);

  readonly files = input.required<DriveFile[]>();
  readonly viewMode = input<'drive' | 'storage'>('drive');
  readonly quota = input<QuotaState | null>(null);
  
  readonly isLocked = this.appState.isLocked;

  sortColumn = signal<string>('name');
  sortDirection = signal<'asc' | 'desc'>('asc');

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
      return '[Trancado] ' + truncated;
    }
    return file.decryptedName || file.encryptedName;
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
    if (file.isFolder) {
      // Future implementation: open folder
      console.log('Open folder', file);
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
