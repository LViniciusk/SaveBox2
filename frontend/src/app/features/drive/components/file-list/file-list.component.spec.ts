import { TestBed, ComponentFixture } from '@angular/core/testing';
import { FileListComponent } from './file-list.component';
import { DriveStore, DriveFile } from '../../state/drive.store';
import { AppStateService } from '../../../../core/state/app-state.service';
import { DialogService } from '../../../../core/dialog/dialog.service';
import { signal } from '@angular/core';
import { provideZonelessChangeDetection } from '@angular/core';

describe('FileListComponent', () => {
  let component: FileListComponent;
  let fixture: ComponentFixture<FileListComponent>;
  let mockDriveStore: any;
  let mockAppState: any;
  let mockDialogService: any;

  beforeEach(async () => {
    // Isolate dependencies with strict mocks (Ponytail philosophy: test logic, not framework)
    mockDriveStore = jasmine.createSpyObj('DriveStore', [
      'restoreItem', 'permanentDeleteItem', 'downloadFile', 'renameItem', 'moveItem', 'trashItem',
      'navigateTo', 'batchTrashItems', 'batchRestoreItems', 'batchPermanentDeleteItems'
    ], {
      files: signal([]),
      trashFiles: signal([]),
      selectedFileIds: signal(new Set()),
      thumbnails: signal({}),
      displayMode: signal('list'),
      currentFolderId: signal(null)
    });

    mockAppState = jasmine.createSpyObj('AppStateService', ['login', 'logout', 'status'], {
      isLocked: signal(false)
    });
    mockDialogService = jasmine.createSpyObj('DialogService', ['confirm', 'prompt']);

    await TestBed.configureTestingModule({
      imports: [FileListComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: DriveStore, useValue: mockDriveStore },
        { provide: AppStateService, useValue: mockAppState },
        { provide: DialogService, useValue: mockDialogService }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(FileListComponent);
    component = fixture.componentInstance;
    
    // Inject inputs
    fixture.componentRef.setInput('files', []);
    fixture.componentRef.setInput('viewMode', 'storage');
    fixture.componentRef.setInput('quota', { maxBytes: 1000, gdriveMaxBytes: 0 }); // Total max = 1000
    
    // Stub methods used by the signals to isolate the test from deep store logic
    spyOn(component, 'getTotalStorageMax').and.returnValue(1000);
    spyOn(component, 'getProxySize').and.returnValue(0); // Ignore proxy logic for these tests
  });

  describe('getPercentage', () => {
    it('should correctly calculate percentages for extreme bounds (0 bytes, over quota, tiny files)', () => {
      // Arrange
      const zeroFile = { sizeBytes: 0 } as DriveFile;
      const tinyFile = { sizeBytes: 1 } as DriveFile; // 0.1% -> <0.01% logic? (1/1000 = 0.001 -> 0.1%)
      const microFile = { sizeBytes: 0.05 } as DriveFile; // (0.05/1000) * 100 = 0.005% (< 0.01%)
      const normalFile = { sizeBytes: 250 } as DriveFile; // 25%
      const overQuotaFile = { sizeBytes: 1500 } as DriveFile; // 150%

      // Act & Assert
      expect(component.getPercentage(zeroFile)).toBe('0.00%');
      expect(component.getPercentage(microFile)).toBe('<0.01%');
      expect(component.getPercentage(normalFile)).toBe('25.00%');
      expect(component.getPercentage(overQuotaFile)).toBe('150.00%');
    });

    it('should return 0% if quota is 0 to avoid division by zero', () => {
      // Arrange
      (component.getTotalStorageMax as jasmine.Spy).and.returnValue(0);
      const normalFile = { sizeBytes: 250 } as DriveFile;
      
      // Act & Assert
      expect(component.getPercentage(normalFile)).toBe('0%');
    });
  });

  describe('sortedFiles', () => {
    it('should sort correctly by decrypted name and size', () => {
      // Arrange
      const unsorted = [
        { id: 1, decryptedName: 'Zebra', sizeBytes: 100, isFolder: false },
        { id: 2, decryptedName: 'Apple', sizeBytes: 50, isFolder: false },
        { id: 3, decryptedName: 'Mango', sizeBytes: 500, isFolder: false }
      ] as DriveFile[];

      // Act - Name ASC
      fixture.componentRef.setInput('files', unsorted);
      fixture.componentRef.setInput('viewMode', 'drive');
      component.sortColumn.set('name');
      component.sortDirection.set('asc');
      
      const sortedByName = component.sortedFiles();
      expect(sortedByName[0].decryptedName).toBe('Apple');
      expect(sortedByName[1].decryptedName).toBe('Mango');
      expect(sortedByName[2].decryptedName).toBe('Zebra');

      // Act - Size DESC
      component.sortColumn.set('size');
      component.sortDirection.set('desc');
      
      const sortedBySize = component.sortedFiles();
      expect(sortedBySize[0].decryptedName).toBe('Mango'); // 500
      expect(sortedBySize[1].decryptedName).toBe('Zebra'); // 100
      expect(sortedBySize[2].decryptedName).toBe('Apple'); // 50
    });
  });

  it('maps icons, colors, names, sizes, proxy size and obfuscated values', () => {
    const file = {
      id: 1,
      type: 'video',
      encryptedName: 'encrypted-name-that-is-long',
      decryptedName: 'movie.mp4',
      sizeBytes: 1024,
      folderId: 3,
      isFolder: false
    } as DriveFile;
    const proxy = { id: 2, decryptedName: 'movie.mp4.proxy.mp4', folderId: 3, sizeBytes: 2048 } as DriveFile;
    mockDriveStore.files.set([file, proxy]);
    (component.getProxySize as jasmine.Spy).and.callThrough();

    expect(component.getFileIcon(file)).toBe('videocam');
    expect(component.getFileIconColor(file)).toBe('#ea4335');
    expect(component.hasProxy(file)).toBeTrue();
    expect(component.getProxySize(file)).toBe(2048);
    expect(component.getTotalSize(file)).toBe(3072);
    expect(component.formatBytes(0)).toBe('0 B');
    expect(component.formatBytes(1024 * 1024)).toBe('1 MB');
    expect(component.getDisplayName(file)).toBe('movie.mp4');
    expect(component.getObfuscatedValue(undefined)).toBe('—');
    expect(component.getObfuscatedValue('secret')).not.toBe('secret');

    mockAppState.isLocked.set(true);
    expect(component.getFileIcon(file)).toBe('lock');
    expect(component.getFileIconColor(file)).toBe('#9aa0a6');
    expect(component.getDisplayName(file)).toBe('encrypted-name-...');
  });

  it('sorts by modified date and owner, toggles sort controls, and labels directions', () => {
    const files = [
      { id: 1, decryptedName: 'z', owner: 'B', modifiedAt: '2025-02-01', sizeBytes: 2, isFolder: false },
      { id: 2, decryptedName: 'a', owner: 'A', modifiedAt: '2025-01-01', sizeBytes: 1, isFolder: false }
    ] as DriveFile[];
    fixture.componentRef.setInput('files', files);
    fixture.componentRef.setInput('viewMode', 'drive');

    component.sortColumn.set('modified');
    expect(component.sortedFiles()[0].id).toBe(2);
    component.sortDirection.set('desc');
    expect(component.sortedFiles()[0].id).toBe(1);
    component.sortColumn.set('owner');
    component.sortDirection.set('asc');
    expect(component.sortedFiles()[0].id).toBe(2);
    expect(component.getSortLabel()).toBe('Nome');
    expect(component.getSortDirectionLabel('asc')).toContain('antigo');
    component.sortColumn.set('size');
    expect(component.getSortLabel()).toBe('Tamanho');
    expect(component.getSortDirectionLabel('desc')).toContain('Maior');
    component.setSort('size');
    expect(component.sortDirection()).toBe('desc');
    component.setSort('name');
    expect(component.sortDirection()).toBe('asc');
    component.setSortFoldersMode('mixed');
    expect(component.sortFoldersMode()).toBe('mixed');
  });

  it('selects, clears and navigates files, folders, and the virtual parent', () => {
    const folder = { id: 7, isFolder: true, parentId: null, decryptedName: 'Folder', type: 'folder', sizeBytes: 0 } as DriveFile;
    const file = { id: 8, isFolder: false, decryptedName: 'photo.jpg', type: 'image', sizeBytes: 1 } as DriveFile;
    fixture.componentRef.setInput('files', [folder, file]);
    mockDriveStore.files.set([folder, file]);
    const event = new MouseEvent('click', { bubbles: true });
    component.onFileClick(file, event);
    expect(mockDriveStore.selectedFileIds()).toEqual(new Set([8]));
    component.onFileClick(folder, new MouseEvent('click', { ctrlKey: true }));
    expect(mockDriveStore.selectedFileIds()).toEqual(new Set([8, 7]));
    expect(component.getSelectedFiles().map(f => f.id)).toEqual([7, 8]);
    component.clearSelection();
    expect(mockDriveStore.selectedFileIds().size).toBe(0);

    component.onFileDblClick(folder, new Event('dblclick'));
    expect(mockDriveStore.navigateTo).toHaveBeenCalledWith(7);
    const virtual = { id: -9999, isFolder: true, parentId: 3 } as DriveFile;
    component.onFileDblClick(virtual, new Event('dblclick'));
    expect(mockDriveStore.navigateTo).toHaveBeenCalledWith(3);
  });

  it('validates drag targets and exposes eligible destination folders', () => {
    const file = { id: 1, isFolder: false, parentId: null, folderId: null } as DriveFile;
    const folder = { id: 2, isFolder: true, parentId: null, folderId: null } as DriveFile;
    mockDriveStore.files.set([file, folder]);
    component.draggedFiles.set([file]);
    const dragEvent = new DragEvent('dragover', { bubbles: true, cancelable: true });
    component.onDragOver(dragEvent, folder);
    expect(component.dragOverFolderId()).toBe(2);
    component.onDragLeave(dragEvent, folder);
    expect(component.dragOverFolderId()).toBeNull();
    component.onDragOver(dragEvent, file);
    expect(component.dragOverFolderId()).toBeNull();
    expect(component.getAvailableFolders(folder)).toEqual([]);
    component.onDragEnd();
    expect(component.draggedFiles()).toEqual([]);
  });

  it('dispatches primary actions and honors confirmation responses', async () => {
    const file = { id: 1, isFolder: false, decryptedName: 'file.txt' } as DriveFile;
    const stop = jasmine.createSpy('stopPropagation');
    const event = { stopPropagation: stop } as any;
    mockDialogService.confirm.and.resolveTo(false);
    await component.onDelete(file, event);
    expect(mockDriveStore.trashItem).not.toHaveBeenCalled();
    mockDialogService.confirm.and.resolveTo(true);
    await component.onDelete(file, event);
    expect(mockDriveStore.trashItem).toHaveBeenCalledWith(file);
    const share = spyOn(component.shareRequested, 'emit');
    component.onShare(file, event);
    expect(share).toHaveBeenCalledWith(file);
  });

  it('opens and clamps file/container menus, while respecting locked and trash views', () => {
    const file = { id: 1, isFolder: false, decryptedName: 'file.txt' } as DriveFile;
    const target = document.createElement('button');
    spyOn(target, 'getBoundingClientRect').and.returnValue({ right: 300, bottom: 100 } as DOMRect);
    const event = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(event, 'currentTarget', { value: target });
    component.toggleMenu(file, event);
    expect(component.activeMenuFileId()).toBe(1);
    component.toggleMenu(file, event);
    expect(component.activeMenuFileId()).toBeNull();
    component.onContextMenu(file, new MouseEvent('contextmenu', { clientX: 10000, clientY: 10000, cancelable: true }));
    expect(component.contextMenuPosition()?.x).toBeLessThan(window.innerWidth);
    component.closeMenu();
    fixture.componentRef.setInput('viewMode', 'trash');
    component.onContainerContextMenu(new MouseEvent('contextmenu', { clientX: 1, clientY: 1, cancelable: true }));
    expect(component.isContainerMenuOpen()).toBeFalse();
    mockAppState.isLocked.set(true);
    component.onContextMenu(file, new MouseEvent('contextmenu'));
    expect(component.activeMenuFileId()).toBeNull();
  });

  it('handles drag selection, multi-item drag previews, drops, and invalid targets', async () => {
    const file = { id: 1, type: 'pdf', decryptedName: 'file.pdf', isFolder: false } as DriveFile;
    const second = { id: 2, type: 'image', decryptedName: 'image.png', isFolder: false } as DriveFile;
    const folder = { id: 3, type: 'folder', decryptedName: 'folder', isFolder: true } as DriveFile;
    mockDriveStore.files.set([file, second, folder]);
    mockDriveStore.selectedFileIds.set(new Set([1, 2]));
    const preview = document.createElement('div');
    preview.innerHTML = '<span class="drag-icon"></span><span class="drag-name"></span>';
    const dataTransfer = jasmine.createSpyObj<DataTransfer>('DataTransfer', ['setData', 'setDragImage']);
    Object.defineProperty(dataTransfer, 'effectAllowed', { writable: true, value: '' });
    const dragStart = new DragEvent('dragstart');
    Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer });
    component.onDragStart(dragStart, file, preview);
    expect(component.draggedFiles().length).toBe(2);
    expect(preview.querySelector('.drag-name')?.textContent).toBe('2 itens');
    component.onDragStart(new DragEvent('dragstart'), { ...file, id: -9999 } as DriveFile, preview);
    component.draggedFiles.set([file]);
    await component.onDrop(new DragEvent('drop', { cancelable: true }), folder);
    expect(mockDriveStore.moveItem).toHaveBeenCalledWith(file, 3);
    expect(component.draggedFiles()).toEqual([]);
    mockAppState.isLocked.set(true);
    component.onDragOver(new DragEvent('dragover'), folder);
    expect(component.dragOverFolderId()).toBeNull();
  });

  it('covers restore, permanent delete, download, rename and move outcomes', async () => {
    const file = { id: 1, isFolder: false, decryptedName: 'file.txt' } as DriveFile;
    const event = { stopPropagation: jasmine.createSpy('stopPropagation') } as any;
    spyOn(window, 'alert');
    mockDriveStore.restoreItem.and.resolveTo();
    await component.onRestore(file, event);
    expect(mockDriveStore.restoreItem).toHaveBeenCalledWith(file);
    mockDialogService.confirm.and.resolveTo(true);
    mockDriveStore.permanentDeleteItem.and.resolveTo();
    await component.onPermanentDelete(file, event);
    expect(mockDriveStore.permanentDeleteItem).toHaveBeenCalledWith(file);
    mockDriveStore.downloadFile.and.resolveTo();
    await component.onDownload(file, event);
    expect(mockDriveStore.downloadFile).toHaveBeenCalledWith(file);
    mockDialogService.prompt.and.resolveTo('renamed.txt');
    mockDriveStore.renameItem.and.resolveTo();
    await component.onRename(file, event);
    expect(mockDriveStore.renameItem).toHaveBeenCalledWith(file, 'renamed.txt');
    mockDialogService.prompt.and.resolveTo(null);
    await component.onRename(file, event);
    spyOn(window, 'prompt').and.returnValue('0');
    mockDriveStore.moveItem.and.resolveTo();
    await component.onMove(file, event);
    expect(mockDriveStore.moveItem).toHaveBeenCalledWith(file, null);
  });

  it('runs bulk actions only after confirmation and clears the selection', async () => {
    const file = { id: 1, isFolder: false, decryptedName: 'file.txt' } as DriveFile;
    mockDriveStore.files.set([file]);
    mockDriveStore.selectedFileIds.set(new Set([1]));
    mockDriveStore.downloadFile.and.resolveTo();
    await component.onBulkDownload();
    expect(mockDriveStore.downloadFile).toHaveBeenCalledWith(file);
    mockDriveStore.selectedFileIds.set(new Set([1]));
    mockDialogService.confirm.and.resolveTo(false);
    await component.onBulkDelete();
    expect(mockDriveStore.batchTrashItems).not.toHaveBeenCalled();
    mockDialogService.confirm.and.resolveTo(true);
    await component.onBulkDelete();
    expect(mockDriveStore.batchTrashItems).toHaveBeenCalledWith([file]);
    mockDriveStore.selectedFileIds.set(new Set([1]));
    await component.onBulkRestore();
    expect(mockDriveStore.batchRestoreItems).toHaveBeenCalledWith([file]);
    mockDriveStore.selectedFileIds.set(new Set([1]));
    mockDialogService.confirm.and.resolveTo(true);
    await component.onBulkPermanentDelete();
    expect(mockDriveStore.batchPermanentDeleteItems).toHaveBeenCalledWith([file]);
  });

  it('updates drag-selection geometry and filters intersecting DOM items', () => {
    fixture.componentRef.setInput('files', [{ id: 1, isFolder: false } as DriveFile]);
    const item = document.createElement('div');
    item.className = 'selectable-item';
    item.setAttribute('data-id', '1');
    spyOn(item, 'getBoundingClientRect').and.returnValue({ left: 5, top: 5, right: 20, bottom: 20 } as DOMRect);
    fixture.nativeElement.appendChild(item);
    const mouseDown = new MouseEvent('mousedown', { button: 0, clientX: 0, clientY: 0, bubbles: true });
    Object.defineProperty(mouseDown, 'target', { value: document.createElement('div') });
    component.onContainerMouseDown(mouseDown);
    component.onWindowMouseMove(new MouseEvent('mousemove', { clientX: 25, clientY: 25 }));
    expect(component.selectionBox()).toEqual(jasmine.objectContaining({ w: 25, h: 25 }));
    expect(mockDriveStore.selectedFileIds()).toEqual(new Set([1]));
    component.onWindowMouseUp(new MouseEvent('mouseup'));
    expect(component.isDraggingSelection()).toBeFalse();
  });
});
