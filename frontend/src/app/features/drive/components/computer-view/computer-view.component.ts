import { Component, computed, inject, input, OnInit, output } from '@angular/core';
import { ComputerStore } from '../../state/computer.store';
import { StorageDriveCardComponent } from '../storage-drive-card/storage-drive-card.component';
import { FileListComponent } from '../file-list/file-list.component';
import { FilePreviewRequest } from '../../services/file-preview-resolver';
import { DriveFile } from '../../state/drive.store';

@Component({
  selector: 'app-computer-view',
  standalone: true,
  imports: [StorageDriveCardComponent, FileListComponent],
  template: `
    <div class="computer-view">
      @if (!computer.selectedTarget()) {
        <header><h1>Este Computador</h1></header>
        <section aria-labelledby="drives-title">
          <h2 id="drives-title"><span class="material-symbols-outlined">expand_more</span> Dispositivos e unidades</h2>
          @if (computer.loading()) {
            <p class="state">Carregando...</p>
          } @else if (computer.error()) {
            <p class="state" role="alert">{{ computer.error() }} <button (click)="computer.loadTargets()">Tentar novamente</button></p>
          } @else {
            <div class="drives">
              @for (target of computer.targets(); track target.key) {
                <app-storage-drive-card [target]="target" (opened)="computer.openTarget($event)" />
              }
            </div>
          }
        </section>
      } @else {
        @if (computer.error() && computer.files().length === 0) {
          <div class="state" role="alert">{{ computer.error() }} <button (click)="computer.refresh()">Tentar novamente</button></div>
        } @else if (computer.loading() && computer.files().length === 0) {
          <div class="state" aria-live="polite">Carregando...</div>
        } @else {
          <app-file-list
            [files]="computer.files()"
            [viewMode]="'computer'"
            [movingFileIds]="movingFileIds()"
            [folderPreviewFiles]="computer.folderPreviewFiles()"
            [selectionResetKey]="selectionResetKey()"
            [hasMore]="computer.hasMore()"
            [loading]="computer.loading()"
            [emptyMessage]="computer.currentFolderId() === null ? 'Esta unidade não possui arquivos Nanika.' : 'Esta pasta não possui arquivos Nanika.'"
            (folderOpenRequested)="computer.openFolder($event)"
            (loadMoreRequested)="computer.loadMore()"
            (previewRequested)="previewRequested.emit($event)"
            (storageMoveRequested)="storageMoveRequested.emit($event)"
            (shareRequested)="shareRequested.emit($event)" />
        }
      }
    </div>
  `,
  styles: [`
    :host, .computer-view { display: flex; flex: 1; min-width: 0; min-height: 0; }
    .computer-view { flex-direction: column; overflow: auto; color: var(--default-text); background: var(--default-content-bg); }
    header { padding: 16px 20px 6px; }
    h1 { margin: 0; font-size: 20px; font-weight: 500; }
    section { padding: 6px 12px 24px; }
    h2 { display: flex; align-items: center; gap: 3px; margin: 0 0 8px; padding-bottom: 5px; border-bottom: 1px solid var(--default-border); font-size: 14px; font-weight: 400; }
    h2 .material-symbols-outlined { font-size: 18px; }
    .drives { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 360px)); gap: 4px 12px; }
    .state { color: var(--default-muted); }
    @media (max-width: 680px) { .drives { grid-template-columns: 1fr; } }
  `],
})
export class ComputerViewComponent implements OnInit {
  protected readonly computer = inject(ComputerStore);
  readonly movingFileIds = input<ReadonlySet<number>>(new Set<number>());
  readonly previewRequested = output<FilePreviewRequest>();
  readonly shareRequested = output<DriveFile>();
  readonly storageMoveRequested = output<DriveFile>();
  readonly selectionResetKey = computed(() => this.computer.currentPath().map(segment => `${segment.id}:${segment.name}`).join('/'));

  ngOnInit(): void {
    void this.computer.loadTargets();
  }
}
