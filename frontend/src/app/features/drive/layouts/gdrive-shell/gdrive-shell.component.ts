import { Component, input, output } from '@angular/core';
import { TopbarComponent } from '../../components/topbar/topbar.component';
import { GDriveSidebarComponent } from '../../components/gdrive-sidebar/gdrive-sidebar.component';
import { DriveWorkspaceComponent } from '../../components/drive-workspace/drive-workspace.component';
import { DriveFile, QuotaState } from '../../state/drive.store';
import { DriveView } from '../../state/drive.types';
import { DroppedItems } from '../../services/data-transfer-reader.service';
import { FilePreviewRequest } from '../../services/file-preview-resolver';

@Component({
  selector: 'app-gdrive-shell',
  standalone: true,
  imports: [TopbarComponent, GDriveSidebarComponent, DriveWorkspaceComponent],
  template: `
    <div class="vault-layout">
      <app-topbar (unlockRequested)="unlockRequested.emit()" (lockRequested)="lockRequested.emit()" style="grid-area: topbar; z-index: 10;" />
      <app-gdrive-sidebar
        [currentView]="currentView()"
        [currentFolderId]="currentFolderId()"
        [locked]="locked()"
        [quota]="quota()"
        (viewChange)="viewChange.emit($event)"
        (createFolderRequested)="createFolderRequested.emit()"
        (uploadFileRequested)="uploadFileRequested.emit()"
        (uploadFolderRequested)="uploadFolderRequested.emit()"
        (pinnedFolderNavigate)="pinnedFolderNavigate.emit($event)" />
      <main class="content-area">
        <div class="content-inner">
          <app-drive-workspace
            [currentView]="currentView()"
            [locked]="locked()"
            [movingFileIds]="movingFileIds()"
            (createFolderRequested)="createFolderRequested.emit()"
            (uploadFileRequested)="uploadFileRequested.emit()"
            (previewRequested)="previewRequested.emit($event)"
            (shareRequested)="shareRequested.emit($event)"
            (storageMoveRequested)="storageMoveRequested.emit($event)"
            (emptyTrashRequested)="emptyTrashRequested.emit()"
            (dropStarted)="dropStarted.emit()"
            (externalDrop)="externalDrop.emit($event)"
            (dropError)="dropError.emit($event)" />
          <ng-content />
        </div>
      </main>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100vh; overflow: hidden; }
    .vault-layout { display: grid; grid-template-rows: 64px 1fr; grid-template-columns: 256px 1fr; grid-template-areas: 'topbar topbar' 'sidebar content'; height: 100%; background: #F8FAFD; }
    .content-area { grid-area: content; display: flex; min-width: 0; min-height: 0; padding: 8px 16px 16px 0; overflow: hidden; }
    .content-inner { flex: 1 1 auto; min-width: 0; min-height: 0; background: #ffffff; border-radius: 16px; height: 100%; position: relative; overflow: hidden; display: flex; flex-direction: column; }
    .content-inner app-drive-workspace { flex: 1 1 auto; min-width: 0; min-height: 0; }
    @media (max-width: 900px) {
      .vault-layout { grid-template-columns: 200px 1fr; }
      .topbar-logo { min-width: 168px; }
    }
    @media (max-width: 680px) {
      .vault-layout { grid-template-columns: 1fr; grid-template-areas: 'topbar' 'content'; }
      .content-area { padding: 8px; }
    }
  `],
})
export class GDriveShellComponent {
  readonly currentView = input.required<DriveView>();
  readonly currentFolderId = input<number | null>(null);
  readonly locked = input(false);
  readonly movingFileIds = input<ReadonlySet<number>>(new Set<number>());
  readonly quota = input.required<QuotaState>();
  readonly unlockRequested = output<void>();
  readonly lockRequested = output<void>();
  readonly viewChange = output<DriveView>();
  readonly createFolderRequested = output<void>();
  readonly uploadFileRequested = output<void>();
  readonly uploadFolderRequested = output<void>();
  readonly pinnedFolderNavigate = output<number>();
  readonly previewRequested = output<FilePreviewRequest>();
  readonly shareRequested = output<DriveFile>();
  readonly storageMoveRequested = output<DriveFile>();
  readonly emptyTrashRequested = output<void>();
  readonly externalDrop = output<DroppedItems>();
  readonly dropStarted = output<void>();
  readonly dropError = output<unknown>();
}
