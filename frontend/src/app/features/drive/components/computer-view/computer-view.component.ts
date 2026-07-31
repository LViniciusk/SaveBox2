import { Component, inject, OnInit, output, signal } from '@angular/core';
import { ComputerStore } from '../../state/computer.store';
import { StorageDriveCardComponent } from '../storage-drive-card/storage-drive-card.component';
import { StorageProjectionBrowserComponent } from '../storage-projection-browser/storage-projection-browser.component';
import { FilePreviewRequest } from '../../services/file-preview-resolver';
import { DriveFile } from '../../state/drive.store';
import { StorageTargetPickerComponent } from '../storage-target-picker/storage-target-picker.component';
import { StorageMoveEngineService } from '../../storage-move/storage-move-engine.service';
import { StorageTarget } from '../../state/drive.types';

@Component({
  selector: 'app-computer-view',
  standalone: true,
  imports: [StorageDriveCardComponent, StorageProjectionBrowserComponent, StorageTargetPickerComponent],
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
        <app-storage-projection-browser (previewRequested)="previewRequested.emit($event)" (moveRequested)="moveFile.set($event)" (shareRequested)="shareRequested.emit($event)" />
      }
      @if (moveFile(); as file) {
        <app-storage-target-picker [file]="file" [targets]="computer.targets()" (cancelled)="moveFile.set(null)" (confirmed)="startMove(file,$event)" />
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
  private readonly moveEngine = inject(StorageMoveEngineService);
  readonly previewRequested = output<FilePreviewRequest>();
  readonly shareRequested = output<DriveFile>();
  readonly moveFile = signal<DriveFile | null>(null);

  ngOnInit(): void {
    if (this.computer.targets().length === 0) void this.computer.loadTargets();
  }

  async startMove(file: DriveFile, target: StorageTarget): Promise<void> {
    this.moveFile.set(null);
    await this.moveEngine.start(file,target);
  }
}
