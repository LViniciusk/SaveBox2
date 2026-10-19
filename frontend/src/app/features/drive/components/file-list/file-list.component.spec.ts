import { TestBed, ComponentFixture } from '@angular/core/testing';
import { FileListComponent } from './file-list.component';
import { DriveStore, DriveFile } from '../../state/drive.store';
import { AppStateService } from '../../../../core/state/app-state.service';
import { DialogService } from '../../../../core/dialog/dialog.service';
import { PinnedFoldersStore } from '../../state/pinned-folders.store';
import { signal } from '@angular/core';
import { provideZonelessChangeDetection } from '@angular/core';

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;

  constructor(private readonly callback: (entries: IntersectionObserverEntry[]) => void) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.add(element);
  }

  unobserve(element: Element): void {
    this.observed.delete(element);
  }

  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }

  emit(element: Element, isIntersecting = true): void {
    this.callback([{ target: element, isIntersecting } as IntersectionObserverEntry]);
  }
}

describe('FileListComponent', () => {
  let component: FileListComponent;
  let fixture: ComponentFixture<FileListComponent>;
  let mockDriveStore: any;
  let mockAppState: any;
  let mockDialogService: any;
  let mockPinnedFoldersStore: any;
  let nativeIntersectionObserver: typeof IntersectionObserver;

  beforeEach(async () => {
    nativeIntersectionObserver = globalThis.IntersectionObserver;
    FakeIntersectionObserver.instances = [];
    (globalThis as any).IntersectionObserver = FakeIntersectionObserver;
    // Isolate dependencies with strict mocks (Ponytail philosophy: test logic, not framework)
    mockDriveStore = jasmine.createSpyObj('DriveStore', [
      'restoreItem', 'permanentDeleteItem', 'downloadFile', 'renameItem', 'moveItem', 'trashItem',
      'navigateTo', 'batchTrashItems', 'batchRestoreItems', 'batchPermanentDeleteItems', 'loadThumbnail'
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
    mockPinnedFoldersStore = jasmine.createSpyObj('PinnedFoldersStore', ['isPinned', 'isPending', 'pin', 'unpin'], {
      pinnedFolders: signal([]),
      error: signal(null),
      isLoading: signal(false)
    });
    mockPinnedFoldersStore.isPinned.and.returnValue(false);
    mockPinnedFoldersStore.isPending.and.returnValue(false);

    await TestBed.configureTestingModule({
      imports: [FileListComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: DriveStore, useValue: mockDriveStore },
        { provide: AppStateService, useValue: mockAppState },
        { provide: DialogService, useValue: mockDialogService }
        , { provide: PinnedFoldersStore, useValue: mockPinnedFoldersStore }
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

  afterEach(() => {
    delete document.documentElement.dataset['theme'];
    (globalThis as any).IntersectionObserver = nativeIntersectionObserver;
  });

  describe('getPercentage', () => {
    it('should correctly calculate percentages for extreme bounds (0 bytes, over quota, tiny files)', () => {
      // Arrange
      const zeroFile = { sizeBytes: 0 } as DriveFile;
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

  it('routes audio through the generic preview event', () => {
    const audio = { id: 9, isFolder: false, decryptedName: 'song.m4a', type: 'audio', sizeBytes: 1 } as DriveFile;
    fixture.componentRef.setInput('files', [audio]);
    fixture.detectChanges();
    const preview = jasmine.createSpy('preview');
    component.previewRequested.subscribe(preview);

    component.onFileDblClick(audio, new Event('dblclick'));

    expect(preview).toHaveBeenCalledWith(jasmine.objectContaining({ file: audio }));
  });

  it('routes the context-menu preview through the same generic event as double click', () => {
    const video = { id: 10, isFolder: false, decryptedName: 'movie.mp4', type: 'video', sizeBytes: 1 } as DriveFile;
    fixture.componentRef.setInput('files', [video]);
    fixture.detectChanges();
    const preview = jasmine.createSpy('preview');
    component.previewRequested.subscribe(preview);

    component.onPlayOriginal(video, new Event('click'));

    expect(preview).toHaveBeenCalledWith({ file: video, playlist: [video] });
  });

  it('opens unsupported files through the generic preview event too', () => {
    const archive = { id: 11, isFolder: false, decryptedName: 'archive.zip', type: 'archive', sizeBytes: 1 } as DriveFile;
    fixture.componentRef.setInput('files', [archive]);
    fixture.detectChanges();
    const preview = jasmine.createSpy('preview');
    component.previewRequested.subscribe(preview);

    component.onFileDblClick(archive, new Event('dblclick'));

    expect(preview).toHaveBeenCalledWith({ file: archive, playlist: [archive] });
  });

  it('does not expose the virtual parent shortcut in the trash', () => {
    const folder = { id: 7, isFolder: true, parentId: 3, decryptedName: 'Folder', type: 'folder', sizeBytes: 0 } as DriveFile;
    fixture.componentRef.setInput('files', [folder]);
    fixture.componentRef.setInput('viewMode', 'trash');
    mockDriveStore.currentFolderId.set(7);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-item-key="folder:-9999"]')).toBeNull();
  });

  it('validates drag targets and exposes eligible destination folders', () => {
    const file = { id: 1, isFolder: false, parentId: null, folderId: null } as DriveFile;
    const folder = { id: 2, isFolder: true, parentId: null, folderId: null } as DriveFile;
    mockDriveStore.files.set([file, folder]);
    component.draggedFiles.set([file]);
    const dragEvent = new DragEvent('dragover', { bubbles: true, cancelable: true });
    component.onDragOver(dragEvent, folder);
    expect(component.dragOverItemKey()).toBe('folder:2');
    component.onDragLeave(dragEvent, folder);
    expect(component.dragOverItemKey()).toBeNull();
    component.onDragOver(dragEvent, file);
    expect(component.dragOverItemKey()).toBeNull();
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

  it('disables Google sharing in list/grid and both themes without emitting', () => {
    const googleFile = {
      id: 91,
      isFolder: false,
      encryptedName: 'ciphertext',
      decryptedName: 'remote.mp4',
      type: 'video',
      sizeBytes: 1,
      storageProvider: 'google_drive',
    } as DriveFile;
    mockDriveStore.files.set([googleFile]);
    fixture.componentRef.setInput('files', [googleFile]);
    fixture.componentRef.setInput('viewMode', 'drive');
    const share = spyOn(component.shareRequested, 'emit');

    for (const [theme, mode] of [['gdrive', 'list'], ['default', 'grid']] as const) {
      document.documentElement.dataset['theme'] = theme;
      mockDriveStore.displayMode.set(mode);
      component.activeMenuItem.set(googleFile);
      fixture.detectChanges();
      const action = [...fixture.nativeElement.querySelectorAll('.menu-item')]
        .find((item: Element) => item.textContent?.includes('Compartilhamento indisponível')) as HTMLButtonElement;
      expect(action).toBeTruthy();
      expect(action.disabled).toBeTrue();
      expect(action.getAttribute('aria-disabled')).toBe('true');
    }

    component.onShare(googleFile, { stopPropagation: jasmine.createSpy() } as any);
    expect(share).not.toHaveBeenCalled();
  });

  it('opens and clamps file/container menus, while respecting locked and trash views', () => {
    const file = { id: 1, isFolder: false, decryptedName: 'file.txt' } as DriveFile;
    const target = document.createElement('button');
    spyOn(target, 'getBoundingClientRect').and.returnValue({ right: 300, bottom: 100 } as DOMRect);
    const event = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(event, 'currentTarget', { value: target });
    component.toggleMenu(file, event);
    expect(component.activeMenuItem()).toBe(file);
    component.toggleMenu(file, event);
    expect(component.activeMenuItem()).toBeNull();
    component.onContextMenu(file, new MouseEvent('contextmenu', { clientX: 10000, clientY: 10000, cancelable: true }));
    expect(component.contextMenuPosition()?.x).toBeLessThan(window.innerWidth);
    component.closeMenu();
    fixture.componentRef.setInput('viewMode', 'trash');
    component.onContainerContextMenu(new MouseEvent('contextmenu', { clientX: 1, clientY: 1, cancelable: true }));
    expect(component.isContainerMenuOpen()).toBeFalse();
    mockAppState.isLocked.set(true);
    component.onContextMenu(file, new MouseEvent('contextmenu'));
    expect(component.activeMenuItem()).toBeNull();
  });

  it('renders Explorer folder, video and image variants with thumbnail fallback', () => {
    document.documentElement.dataset['theme'] = 'default';
    mockDriveStore.displayMode.set('grid');
    const files = [
      { id: 1, type: 'folder', decryptedName: 'Projetos', isFolder: true, sizeBytes: 0 },
      { id: 2, type: 'video', decryptedName: 'demo.mp4', isFolder: false, sizeBytes: 2 },
      { id: 3, type: 'image', decryptedName: 'captura.png', isFolder: false, sizeBytes: 1 },
    ] as DriveFile[];
    mockDriveStore.files.set(files);
    mockDriveStore.thumbnails.set({ 2: 'data:image/png;base64,AA==' });
    fixture.componentRef.setInput('files', files);
    fixture.componentRef.setInput('viewMode', 'drive');
    fixture.detectChanges();

    const folder = fixture.nativeElement.querySelector('.folder-card') as HTMLElement;
    const video = fixture.nativeElement.querySelector('.video-card') as HTMLElement;
    const image = fixture.nativeElement.querySelector('.image-card') as HTMLElement;
    expect(folder.querySelector('.default-preview-viewport.folder-preview-viewport')).not.toBeNull();
    expect(video.querySelector('.file-card-thumbnail')?.getAttribute('style')).toContain('data:image/png');
    expect(image.querySelector('.thumbnail-icon')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Projetos');
    expect(fixture.nativeElement.textContent).toContain('demo.mp4');
    expect(fixture.nativeElement.textContent).toContain('captura.png');
    expect(getComputedStyle(folder).borderRadius).toBe('0px');
    expect(mockDriveStore.loadThumbnail).not.toHaveBeenCalled();
  });

  it('does not authorize offscreen grid thumbnails before viewport demand', () => {
    document.documentElement.dataset['theme'] = 'default';
    mockDriveStore.displayMode.set('grid');
    const files = Array.from({ length: 20 }, (_, id) => ({
      id: id + 1,
      type: id % 2 === 0 ? 'image' : 'video',
      decryptedName: `media-${String(id).padStart(2, '0')}`,
      isFolder: false,
      sizeBytes: 1,
    })) as DriveFile[];
    fixture.componentRef.setInput('files', files);
    fixture.componentRef.setInput('viewMode', 'drive');
    fixture.detectChanges();

    expect(mockDriveStore.loadThumbnail).not.toHaveBeenCalled();
  });

  it('uses the first media thumbnail inside a folder and keeps empty folders plain', () => {
    document.documentElement.dataset['theme'] = 'default';
    mockDriveStore.displayMode.set('grid');
    const folder = { id: 1, type: 'folder', decryptedName: 'Com fotos', isFolder: true, sizeBytes: 0 } as DriveFile;
    const emptyFolder = { id: 4, type: 'folder', decryptedName: 'Vazia', isFolder: true, sizeBytes: 0 } as DriveFile;
    const child = { id: 2, type: 'image', decryptedName: 'foto.png', isFolder: false, folderId: 1, encryptedFdk: 'fdk' } as DriveFile;
    const files = [folder, emptyFolder, child];
    mockDriveStore.files.set(files);
    mockDriveStore.thumbnails.set({ 2: 'data:image/png;base64,AA==' });
    fixture.componentRef.setInput('files', [folder, emptyFolder]);
    fixture.componentRef.setInput('viewMode', 'drive');
    fixture.detectChanges();

    const cards = [...fixture.nativeElement.querySelectorAll('.folder-card')] as HTMLElement[];
    expect(cards[0].querySelector('.default-folder-preview-image')?.getAttribute('src')).toContain('data:image/png');
    expect(cards[1].querySelector('.default-folder-preview')).toBeNull();
    expect(mockDriveStore.loadThumbnail).not.toHaveBeenCalled();
  });

  it('authorizes only intersecting media cards and ignores repeated entry', () => {
    document.documentElement.dataset['theme'] = 'default';
    mockDriveStore.displayMode.set('grid');
    const files = Array.from({ length: 20 }, (_, id) => ({
      id: id + 1,
      type: id % 2 === 0 ? 'image' : 'video',
      decryptedName: `media-${String(id).padStart(2, '0')}`,
      isFolder: false,
      sizeBytes: 1,
    })) as DriveFile[];
    fixture.componentRef.setInput('files', files);
    fixture.componentRef.setInput('viewMode', 'drive');
    fixture.detectChanges();

    const observer = FakeIntersectionObserver.instances.at(-1)!;
    const cards = [...fixture.nativeElement.querySelectorAll('.file-card-thumbnail')] as Element[];
    expect(observer.observed.size).toBe(20);
    expect(mockDriveStore.loadThumbnail).not.toHaveBeenCalled();

    observer.emit(cards[2]);
    observer.emit(cards[2]);
    observer.emit(cards[9]);

    expect(mockDriveStore.loadThumbnail).toHaveBeenCalledTimes(2);
    expect(mockDriveStore.loadThumbnail.calls.argsFor(0)[0]).toBe(files[2]);
    expect(mockDriveStore.loadThumbnail.calls.argsFor(1)[0]).toBe(files[9]);
  });

  it('authorizes a folder preview only when its folder card intersects', () => {
    document.documentElement.dataset['theme'] = 'default';
    mockDriveStore.displayMode.set('grid');
    const folder = { id: 1, type: 'folder', decryptedName: 'Pasta', isFolder: true, sizeBytes: 0 } as DriveFile;
    const child = { id: 2, type: 'video', decryptedName: 'video.mp4', isFolder: false, folderId: 1, sizeBytes: 1 } as DriveFile;
    mockDriveStore.files.set([folder, child]);
    fixture.componentRef.setInput('files', [folder]);
    fixture.componentRef.setInput('viewMode', 'drive');
    fixture.detectChanges();

    const observer = FakeIntersectionObserver.instances.at(-1)!;
    const viewport = fixture.nativeElement.querySelector('.folder-preview-viewport') as Element;
    expect(observer.observed.has(viewport)).toBeTrue();
    expect(mockDriveStore.loadThumbnail).not.toHaveBeenCalled();

    observer.emit(viewport);

    expect(mockDriveStore.loadThumbnail).toHaveBeenCalledOnceWith(child);
  });

  it('uses one locked preview for every Default grid item and restores type renderers when unlocked', () => {
    document.documentElement.dataset['theme'] = 'default';
    mockDriveStore.displayMode.set('grid');
    const files = [
      { id: 11, type: 'folder', encryptedName: 'encrypted-folder-name', decryptedName: 'Segredo', isFolder: true, sizeBytes: 0 },
      { id: 12, type: 'image', encryptedName: 'encrypted-image', decryptedName: 'foto.png', isFolder: false, sizeBytes: 1 },
      { id: 13, type: 'video', encryptedName: 'encrypted-video', decryptedName: 'video.mp4', isFolder: false, sizeBytes: 1 },
      { id: 14, type: 'doc', encryptedName: 'encrypted-doc', decryptedName: 'arquivo.txt', isFolder: false, sizeBytes: 1 },
    ] as DriveFile[];
    mockDriveStore.files.set(files);
    mockDriveStore.thumbnails.set({ 12: 'data:image/png;base64,AA==' });
    fixture.componentRef.setInput('files', files);
    fixture.componentRef.setInput('viewMode', 'drive');

    mockAppState.isLocked.set(true);
    fixture.detectChanges();
    const lockedCards = [...fixture.nativeElement.querySelectorAll('.grid-card')] as HTMLElement[];
    expect(lockedCards.length).toBe(4);
    lockedCards.forEach(card => {
      expect(card.querySelector('app-default-locked-preview')).not.toBeNull();
      expect(card.querySelectorAll('.default-preview-viewport').length).toBe(1);
      expect(card.querySelector('.folder-art-stage')).toBeNull();
      expect(card.querySelector('.folder-thumbnail')).toBeNull();
      expect(card.querySelector('.file-card-thumbnail .thumbnail-icon')).toBeNull();
      expect(card.querySelector('app-file-icon')).toBeNull();
    });

    const lockedStructure = lockedCards.map(card => card.querySelector('.default-preview-viewport')?.outerHTML);
    mockDriveStore.selectedFileIds.set(new Set([files[0].id]));
    fixture.detectChanges();
    expect(lockedCards[0].classList.contains('selected')).toBeTrue();
    expect(lockedCards.map(card => card.querySelector('.default-preview-viewport')?.outerHTML)).toEqual(lockedStructure);

    mockAppState.isLocked.set(false);
    fixture.detectChanges();
    const unlockedFolder = fixture.nativeElement.querySelector('.folder-card') as HTMLElement;
    expect(unlockedFolder.querySelector('.default-preview-viewport')).not.toBeNull();
    expect(unlockedFolder.querySelector('.folder-art-stage')).toBeNull();
    expect(unlockedFolder.querySelectorAll('.folder-art-layer')).toHaveSize(2);
    expect(unlockedFolder.querySelector('app-default-locked-preview')).toBeNull();
    expect(fixture.nativeElement.querySelector('.image-card app-default-locked-preview')).toBeNull();
    expect(fixture.nativeElement.querySelector('.video-card .file-card-thumbnail')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.file-card:not(.mixed-folder-card) .thumbnail-icon')).not.toBeNull();
  });

  it('keeps the folder thumbnail in the viewport instead of the scaled art layer', () => {
    document.documentElement.dataset['theme'] = 'default';
    mockDriveStore.displayMode.set('grid');
    const folder = { id: 31, type: 'folder', encryptedName: 'folder', decryptedName: 'Folder', isFolder: true, sizeBytes: 0 } as DriveFile;
    const child = { id: 32, type: 'image', encryptedName: 'image', decryptedName: 'image.png', isFolder: false, folderId: 31, sizeBytes: 1 } as DriveFile;
    mockDriveStore.files.set([folder, child]);
    mockDriveStore.thumbnails.set({ 32: 'data:image/png;base64,AA==' });
    fixture.componentRef.setInput('files', [folder]);
    fixture.componentRef.setInput('viewMode', 'drive');
    mockAppState.isLocked.set(false);
    fixture.detectChanges();

    const viewport = fixture.nativeElement.querySelector('.folder-preview-viewport') as HTMLElement;
    const thumbnail = viewport.querySelector('.folder-thumbnail') as HTMLElement;
    expect(thumbnail).not.toBeNull();
    expect(thumbnail.parentElement).toBe(viewport);
    expect(thumbnail.closest('.folder-art-stage')).toBeNull();
    expect(viewport.querySelector('.folder-back')?.classList.contains('folder-art-layer')).toBeTrue();
    expect(viewport.querySelector('.folder-front')?.classList.contains('folder-art-layer')).toBeTrue();
    expect(viewport.querySelectorAll('.folder-thumbnail')).toHaveSize(1);
  });

  it('preserves the GDrive locked grid renderer', () => {
    document.documentElement.dataset['theme'] = 'gdrive';
    mockDriveStore.displayMode.set('grid');
    const files = [
      { id: 21, type: 'folder', encryptedName: 'folder', isFolder: true, sizeBytes: 0 },
      { id: 22, type: 'image', encryptedName: 'image', isFolder: false, sizeBytes: 1 },
    ] as DriveFile[];
    mockDriveStore.files.set(files);
    fixture.componentRef.setInput('files', files);
    fixture.componentRef.setInput('viewMode', 'drive');
    mockAppState.isLocked.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.grid-layout[data-renderer="gdrive"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-default-locked-preview')).toBeNull();
    expect(fixture.nativeElement.querySelector('.folder-card app-file-icon')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.file-card-thumbnail app-file-icon')).not.toBeNull();
  });

  it('uses the dark context-menu variant only for the Default theme', () => {
    const file = { id: 1, type: 'doc', decryptedName: 'arquivo.txt', isFolder: false, sizeBytes: 1 } as DriveFile;
    mockDriveStore.files.set([file]);
    fixture.componentRef.setInput('files', [file]);
    fixture.componentRef.setInput('viewMode', 'drive');
    document.documentElement.dataset['theme'] = 'default';
    component.onContextMenu(file, new MouseEvent('contextmenu', { clientX: 10, clientY: 10, cancelable: true }));
    fixture.detectChanges();

    const menu = fixture.nativeElement.querySelector('.action-menu') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.textContent).toContain('Renomear');
    expect(menu.querySelectorAll('.menu-divider').length).toBe(1);
    const defaultMenuRule = Array.from(document.styleSheets)
      .flatMap(sheet => Array.from(sheet.cssRules))
      .find((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule
        && rule.selectorText.includes('app-file-list .file-list-container .action-menu'));
    expect(defaultMenuRule).toBeDefined();
    expect(defaultMenuRule?.style.animationName).toBe('none');
    expect(defaultMenuRule?.style.border).toContain('solid');

    document.documentElement.dataset['theme'] = 'gdrive';
    fixture.detectChanges();
    expect(getComputedStyle(menu).animationName).toContain('fadeIn');
    expect(getComputedStyle(menu).borderStyle).toBe('none');
  });

  it('pins and unpins folders from the context menu without files receiving the action', async () => {
    const folder = { id: 3, isFolder: true } as DriveFile;
    const file = { id: 4, isFolder: false } as DriveFile;
    const event = { stopPropagation: jasmine.createSpy('stopPropagation') } as any;
    mockPinnedFoldersStore.pin.and.resolveTo();
    await component.togglePinned(folder, event);
    expect(mockPinnedFoldersStore.pin).toHaveBeenCalledWith(3);
    mockPinnedFoldersStore.isPinned.and.returnValue(true);
    mockPinnedFoldersStore.unpin.and.resolveTo();
    await component.togglePinned(folder, event);
    expect(mockPinnedFoldersStore.unpin).toHaveBeenCalledWith(3);
    expect(component.togglePinned(file, event)).toBeInstanceOf(Promise);
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
    expect(component.dragOverItemKey()).toBeNull();
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
    item.setAttribute('data-item-key', 'file:1');
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

  it('uses the projected collection in computer mode without touching DriveStore navigation', () => {
    const folder = { id: 50, isFolder: true, decryptedName: 'Google', type: 'folder', sizeBytes: 0 } as DriveFile;
    const file = { id: 51, isFolder: false, decryptedName: 'remote.txt', type: 'doc', sizeBytes: 1, storageProvider: 'google_drive' } as DriveFile;
    fixture.componentRef.setInput('viewMode', 'computer');
    fixture.componentRef.setInput('files', [folder, file]);
    fixture.detectChanges();

    const folderOpen = spyOn(component.folderOpenRequested, 'emit');
    component.onFileDblClick(folder, new Event('dblclick'));
    expect(folderOpen).toHaveBeenCalledWith(folder);
    expect(mockDriveStore.navigateTo).not.toHaveBeenCalledWith(50);

    component.onFileClick(file, new MouseEvent('click'));
    expect(component.selectedCount()).toBe(1);
    expect(mockDriveStore.selectedFileIds()).toEqual(new Set());
    expect(component.getSelectedFiles()).toEqual([file]);
  });

  it('keeps folder and file with the same numeric id independent in list and grid', () => {
    const folder = { id: 7, isFolder: true, type: 'folder', decryptedName: 'Pasta' } as DriveFile;
    const file = { id: 7, isFolder: false, type: 'doc', decryptedName: 'Arquivo' } as DriveFile;
    fixture.componentRef.setInput('viewMode', 'computer');
    fixture.componentRef.setInput('files', [folder, file]);

    for (const mode of ['list', 'grid'] as const) {
      mockDriveStore.displayMode.set(mode);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-item-key="folder:7"]')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('[data-item-key="file:7"]')).not.toBeNull();

      component.onContextMenu(folder, new MouseEvent('contextmenu', { clientX: 10, clientY: 10, cancelable: true }));
      fixture.detectChanges();
      let labels = [...fixture.nativeElement.querySelectorAll('.action-menu .menu-item')]
        .map((item: Element) => item.textContent?.trim());
      expect(labels.some(label => label?.includes('Abrir'))).toBeTrue();
      expect(labels.some(label => label?.includes('Preview'))).toBeFalse();

      component.onContextMenu(file, new MouseEvent('contextmenu', { clientX: 10, clientY: 10, cancelable: true }));
      fixture.detectChanges();
      labels = [...fixture.nativeElement.querySelectorAll('.action-menu .menu-item')]
        .map((item: Element) => item.textContent?.trim());
      expect(labels.some(label => label?.includes('Preview'))).toBeTrue();
      expect(labels.some(label => label?.includes('Baixar'))).toBeTrue();
      expect(labels.some(label => label?.includes('Mover para...'))).toBeTrue();
      expect(labels.some(label => label?.includes('Abrir'))).toBeFalse();
    }

    component.onFileClick(folder, new MouseEvent('click'));
    expect(component.isFileSelected(folder)).toBeTrue();
    expect(component.isFileSelected(file)).toBeFalse();
    component.onFileClick(file, new MouseEvent('click', { ctrlKey: true }));
    expect(component.getSelectedFiles()).toEqual([folder, file]);
  });

  it('offers storage move in drive and storage, but not for invalid items', () => {
    const file = {
      id: 21, isFolder: false, isHidden: false, type: 'doc', decryptedName: 'Arquivo', encryptedName: 'cipher',
      sizeBytes: 1, sizeFormatted: '1 B', modifiedAt: '—', owner: 'eu', storageProvider: 'local', externalStorageId: null,
    } as DriveFile;
    fixture.componentRef.setInput('files', [file]);

    for (const mode of ['drive', 'storage'] as const) {
      fixture.componentRef.setInput('viewMode', mode);
      fixture.detectChanges();
      component.onContextMenu(file, new MouseEvent('contextmenu', { clientX: 10, clientY: 10, cancelable: true }));
      fixture.detectChanges();
      expect([...fixture.nativeElement.querySelectorAll('.action-menu .menu-item')]
        .some((item: Element) => item.textContent?.includes('Mover para...'))).toBeTrue();
      component.closeMenu();
    }

    expect(component.canRequestStorageMove({ ...file, isFolder: true })).toBeFalse();
    expect(component.canRequestStorageMove({ ...file, isHidden: true })).toBeFalse();
    expect(component.canRequestStorageMove({ ...file, id: -9999 })).toBeFalse();
    fixture.componentRef.setInput('viewMode', 'trash');
    expect(component.canRequestStorageMove(file)).toBeFalse();
  });

  it('takes folder previews only from the current computer projection and blocks drag/drop', () => {
    const folder = { id: 60, isFolder: true, decryptedName: 'Vídeos', type: 'folder', sizeBytes: 0 } as DriveFile;
    const ownChild = { id: 61, isFolder: false, folderId: 60, type: 'image', encryptedFdk: 'own', sizeBytes: 1 } as DriveFile;
    const otherChild = { id: 62, isFolder: false, folderId: 60, type: 'image', encryptedFdk: 'other', sizeBytes: 1 } as DriveFile;
    mockDriveStore.files.set([otherChild]);
    mockDriveStore.thumbnails.set({ 61: 'data:image/png;base64,own' });
    fixture.componentRef.setInput('viewMode', 'computer');
    fixture.componentRef.setInput('files', [folder]);
    fixture.componentRef.setInput('folderPreviewFiles', [ownChild]);
    fixture.detectChanges();

    expect(component.getFolderThumbnail(folder)).toContain('own');
    expect(component.canDrag(folder)).toBeFalse();
    component.onDragOver(new DragEvent('dragover', { cancelable: true }), folder);
    expect(component.dragOverItemKey()).toBeNull();
  });

  it('keeps computer selection and drag restrictions in list mode', () => {
    const file = { id: 70, isFolder: false, decryptedName: 'remote.txt', type: 'doc', sizeBytes: 1 } as DriveFile;
    fixture.componentRef.setInput('viewMode', 'computer');
    fixture.componentRef.setInput('files', [file]);
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('.file-row') as HTMLElement;
    row.click();
    fixture.detectChanges();

    expect(row.classList.contains('selected')).toBeTrue();
    expect(row.getAttribute('draggable')).toBeNull();
    expect(mockDriveStore.selectedFileIds()).toEqual(new Set());
  });
});
