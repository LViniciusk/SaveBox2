import { Component, input, output, provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ComputerViewComponent } from './computer-view.component';
import { StorageDriveCardComponent } from '../storage-drive-card/storage-drive-card.component';
import { StorageTarget } from '../../state/drive.types';
import { DriveFile } from '../../state/drive.store';
import { FilePreviewRequest } from '../../services/file-preview-resolver';
import { ComputerStore } from '../../state/computer.store';

@Component({ selector: 'app-file-list', standalone: true, template: '<div class="file-list-stub"></div>' })
class FileListStubComponent {
  readonly files = input<DriveFile[]>([]);
  readonly viewMode = input('drive');
  readonly folderPreviewFiles = input<DriveFile[]>([]);
  readonly movingFileIds = input<ReadonlySet<number>>(new Set<number>());
  readonly selectionResetKey = input('');
  readonly hasMore = input(false);
  readonly loading = input(false);
  readonly emptyMessage = input('');
  readonly folderOpenRequested = output<DriveFile>();
  readonly loadMoreRequested = output<void>();
  readonly previewRequested = output<FilePreviewRequest>();
  readonly storageMoveRequested = output<DriveFile>();
  readonly shareRequested = output<DriveFile>();
}

describe('ComputerViewComponent', () => {
  let fixture: ComponentFixture<ComputerViewComponent>;
  let component: ComputerViewComponent;
  let computer: any;

  const local: StorageTarget = {
    key: 'local', provider: 'local', label: 'Local', externalStorageId: null,
    usedBytes: 10, maxBytes: 100, availableBytes: 90, nanikaUsedBytes: 10, status: 'ready',
  };
  const google: StorageTarget = {
    key: 'google:7', provider: 'google_drive', label: 'user@example.com', externalStorageId: 7,
    usedBytes: null, maxBytes: null, availableBytes: null, nanikaUsedBytes: 0, status: 'unavailable',
  };
  const file = { id: 1, isFolder: false, decryptedName: 'arquivo.txt', encryptedName: 'enc', type: 'doc', sizeBytes: 1 } as DriveFile;

  beforeEach(async () => {
    computer = {
      targets: signal<StorageTarget[]>([local, google]),
      selectedTarget: signal<StorageTarget | null>(null),
      currentFolderId: signal<number | null>(null),
      currentPath: signal([{ id: null, name: 'Nanika' }, { id: 'computer', name: 'Este Computador' }]),
      files: signal<DriveFile[]>([]),
      folderPreviewFiles: signal<DriveFile[]>([]),
      loading: signal(false),
      error: signal<string | null>(null),
      hasMore: signal(false),
      loadTargets: jasmine.createSpy('loadTargets').and.resolveTo(),
      openTarget: jasmine.createSpy('openTarget'),
      openFolder: jasmine.createSpy('openFolder'),
      refresh: jasmine.createSpy('refresh').and.resolveTo(),
      loadMore: jasmine.createSpy('loadMore').and.resolveTo(),
    };
    await TestBed.configureTestingModule({
      imports: [ComputerViewComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ComputerStore, useValue: computer },
      ],
    }).overrideComponent(ComputerViewComponent, {
      set: { imports: [StorageDriveCardComponent, FileListStubComponent] },
    }).compileComponents();

    fixture = TestBed.createComponent(ComputerViewComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('loads targets and renders Local plus unavailable Google accounts at the root', () => {
    expect(computer.loadTargets).toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Local');
    expect(fixture.nativeElement.textContent).toContain('user@example.com');
    expect(fixture.nativeElement.textContent).toContain('Indisponível');
  });

  it('reuses FileListComponent for an opened unit and keeps the custom renderer absent', () => {
    computer.selectedTarget.set(local);
    computer.files.set([file]);
    fixture.detectChanges();

    const fileList = fixture.debugElement.query(By.directive(FileListStubComponent));
    expect(fileList).not.toBeNull();
    expect(fileList.componentInstance.viewMode()).toBe('computer');
    expect(fileList.componentInstance.files()).toEqual([file]);
    expect(fixture.nativeElement.querySelector('app-file-list')).not.toBeNull();
  });

  it('forwards folder, preview, share, move and pagination intentions', () => {
    computer.selectedTarget.set(local);
    fixture.detectChanges();
    const child = fixture.debugElement.query(By.directive(FileListStubComponent)).componentInstance as FileListStubComponent;
    const folder = { ...file, id: 2, isFolder: true, type: 'folder' } as DriveFile;
    const preview = jasmine.createSpy('preview');
    const share = jasmine.createSpy('share');
    const move = jasmine.createSpy('move');
    component.previewRequested.subscribe(preview);
    component.shareRequested.subscribe(share);
    component.storageMoveRequested.subscribe(move);

    child.folderOpenRequested.emit(folder);
    child.previewRequested.emit({ file, playlist: [file] });
    child.shareRequested.emit(file);
    child.storageMoveRequested.emit(file);
    child.loadMoreRequested.emit();

    expect(computer.openFolder).toHaveBeenCalledWith(folder);
    expect(preview).toHaveBeenCalledWith({ file, playlist: [file] });
    expect(share).toHaveBeenCalledWith(file);
    expect(move).toHaveBeenCalledWith(file);
    expect(computer.loadMore).toHaveBeenCalled();
  });
});
