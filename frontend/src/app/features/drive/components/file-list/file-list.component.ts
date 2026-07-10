import { Component, input, inject } from '@angular/core';
import { DriveFile } from '../../state/drive.store';
import { FileIconComponent } from '../../../../shared/ui/file-icon/file-icon.component';
import { ObfuscatePipe } from '../../../../shared/pipes/obfuscate.pipe';
import { AppStateService, AppStatus } from '../../../../core/state/app-state.service';

/**
 * File list table component styled like Google Drive.
 *
 * Applies the ObfuscatePipe to all file metadata when the vault
 * is in the Locked state, showing "🔒 Arquivo Encriptado" instead
 * of the real values.
 */
@Component({
  selector: 'app-file-list',
  imports: [FileIconComponent, ObfuscatePipe],
  template: `
    <div class="file-list-container">
      <div class="file-list-header">
        <div class="col col-name">Nome</div>
        <div class="col col-owner">Proprietário</div>
        <div class="col col-modified">Última modificação</div>
        <div class="col col-size">Tamanho do arquivo</div>
      </div>

      <div class="file-list-body">
        @for (file of files(); track file.id) {
          <div class="file-row" tabindex="0" role="row">
            <div class="col col-name">
              <app-file-icon [fileType]="file.type" [locked]="isLocked()" />
              <span class="file-name">{{ file.name | obfuscate: isLocked() }}</span>
            </div>
            <div class="col col-owner">
              {{ file.owner | obfuscate: isLocked() }}
            </div>
            <div class="col col-modified">
              {{ file.modifiedAt | obfuscate: isLocked() }}
            </div>
            <div class="col col-size">
              {{ file.size | obfuscate: isLocked() }}
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
        font-size: 12px;
        font-weight: 500;
        color: #5f6368;
        text-transform: none;
        letter-spacing: 0;
        user-select: none;
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

      /* Responsive: hide columns on small screens */
      @media (max-width: 768px) {
        .file-list-header,
        .file-row {
          grid-template-columns: 1fr 120px;
        }
        .col-owner,
        .col-size {
          display: none;
        }
      }
    `,
  ],
})
export class FileListComponent {
  private readonly appState = inject(AppStateService);

  readonly files = input.required<DriveFile[]>();
  readonly isLocked = this.appState.isLocked;
}
