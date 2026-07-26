import { Component, input, output } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { DriveWorkspaceComponent } from './drive-workspace.component';
import { DriveFile, DriveStore } from '../../state/drive.store';
import { DriveDropZoneDirective } from '../../directives/drive-drop-zone.directive';

@Component({ selector: 'app-file-list', standalone: true, template: '' })
class FileListStubComponent {
  readonly files = input<DriveFile[]>([]);
  readonly viewMode = input<'drive' | 'storage' | 'trash'>('drive');
  readonly quota = input<any>(null);
  readonly createFolderRequested = output<void>();
  readonly uploadFileRequested = output<void>();
  readonly videoSelected = output<DriveFile>();
  readonly imageSelected = output<{ file: DriveFile; playlist: DriveFile[] }>();
  readonly shareRequested = output<DriveFile>();
}

@Component({ selector: 'app-transfer-panel', standalone: true, template: '' })
class TransferPanelStubComponent {
  readonly currentView = input.required<string>();
}

describe('DriveWorkspaceComponent', () => {
  let fixture: ComponentFixture<DriveWorkspaceComponent>;
  let store: any;

  beforeEach(async () => {
    store = jasmine.createSpyObj('DriveStore', ['navigateTo', 'setDisplayMode'], {
      currentFolderId: signal(null),
      currentPath: signal([{ id: null, name: 'Meu Drive' }]),
      displayMode: signal('list'),
      trashFiles: signal([]),
      currentTrashFolderFiles: signal([]),
      currentFolderFiles: signal([]),
      files: signal([]),
      quota: signal({ usedBytes: 0, maxBytes: 100 })
    });
    await TestBed.configureTestingModule({
      imports: [DriveWorkspaceComponent],
      providers: [provideZonelessChangeDetection(), { provide: DriveStore, useValue: store }]
    })
      .overrideComponent(DriveWorkspaceComponent, { set: { imports: [FileListStubComponent, TransferPanelStubComponent, DriveDropZoneDirective] } })
      .compileComponents();
    fixture = TestBed.createComponent(DriveWorkspaceComponent);
    fixture.componentRef.setInput('currentView', 'drive');
  });

  afterEach(() => {
    delete document.documentElement.dataset['theme'];
  });

  it('renders drive breadcrumbs and the list view', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.breadcrumb-text')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-file-list')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.view-mode-toggle')).not.toBeNull();
  });

  it('applies the compact workspace surface only to the Default theme', () => {
    document.documentElement.dataset['theme'] = 'default';
    fixture.detectChanges();
    const breadcrumb = fixture.nativeElement.querySelector('.breadcrumb') as HTMLElement;
    expect(getComputedStyle(breadcrumb).borderBottomStyle).toBe('solid');
    expect(getComputedStyle(breadcrumb).fontFamily).toContain('Segoe UI');

    document.documentElement.dataset['theme'] = 'gdrive';
    fixture.detectChanges();
    expect(getComputedStyle(breadcrumb).borderBottomStyle).toBe('none');
    expect(getComputedStyle(breadcrumb).fontFamily).toContain('Roboto');
  });

  it('renders each non-drive mode through its matching branch', () => {
    fixture.componentRef.setInput('currentView', 'trash');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Lixeira');
    expect(fixture.nativeElement.querySelector('app-file-list')).not.toBeNull();

    fixture.componentRef.setInput('currentView', 'transfers');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Pendentes');
    expect(fixture.nativeElement.querySelector('app-transfer-panel')).not.toBeNull();

    fixture.componentRef.setInput('currentView', 'storage');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Armazenamento');
    expect(fixture.nativeElement.querySelector('.view-mode-toggle')).toBeNull();
  });

  it('shows the trash warning and delegates display mode changes', () => {
    store.trashFiles.set([{ id: 1 }]);
    store.currentPath.set([{ id: null, name: 'Meu Drive' }, { id: 7, name: 'Pasta' }]);
    fixture.componentRef.setInput('currentView', 'trash');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.trash-banner')).not.toBeNull();
    const buttons = fixture.nativeElement.querySelectorAll('.view-mode-toggle button') as NodeListOf<HTMLButtonElement>;
    buttons[1].click();
    expect(store.setDisplayMode).toHaveBeenCalledWith('grid');

    const empty = jasmine.createSpy('empty');
    fixture.componentInstance.emptyTrashRequested.subscribe(empty);
    fixture.nativeElement.querySelector('.empty-trash-btn').click();
    expect(empty).toHaveBeenCalled();

    fixture.componentRef.setInput('currentView', 'drive');
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.breadcrumb-link').click();
    expect(store.navigateTo).toHaveBeenCalledWith(null);
  });

  it('sorts storage files by size and excludes hidden folders', () => {
    store.files.set([
      { id: 1, sizeBytes: 1, isFolder: false, isHidden: false },
      { id: 2, sizeBytes: 3, isFolder: false, isHidden: false },
      { id: 3, sizeBytes: 9, isFolder: true, isHidden: false },
      { id: 4, sizeBytes: 8, isFolder: false, isHidden: true },
    ]);
    expect(fixture.componentInstance.currentStorageFiles().map(file => file.id)).toEqual([2, 1]);
  });

  it('does not add a parent entry while browsing storage', () => {
    store.currentFolderId.set(7);
    fixture.componentRef.setInput('currentView', 'storage');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-id="-9999"]')).toBeNull();
  });
});
