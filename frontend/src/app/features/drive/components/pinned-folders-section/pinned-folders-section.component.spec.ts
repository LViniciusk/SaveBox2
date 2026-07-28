import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { DialogService } from '../../../../core/dialog/dialog.service';
import { DriveStore } from '../../state/drive.store';
import { PinnedFoldersSectionComponent } from './pinned-folders-section.component';
import { PinnedFoldersStore } from '../../state/pinned-folders.store';

describe('PinnedFoldersSectionComponent', () => {
  let fixture: ComponentFixture<PinnedFoldersSectionComponent>;
  let store: any;
  let driveStore: any;
  let dialogService: any;

  beforeEach(async () => {
    store = {
      isLoading: signal(false),
      error: signal(null),
      pinnedFolders: signal([]),
      isPending: jasmine.createSpy('isPending').and.returnValue(false),
      unpin: jasmine.createSpy('unpin').and.resolveTo(),
    };
    driveStore = jasmine.createSpyObj('DriveStore', ['renameItem', 'trashItem'], { files: signal([]) });
    dialogService = jasmine.createSpyObj('DialogService', ['prompt', 'confirm']);
    await TestBed.configureTestingModule({
      imports: [PinnedFoldersSectionComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: PinnedFoldersStore, useValue: store },
        { provide: DriveStore, useValue: driveStore },
        { provide: DialogService, useValue: dialogService },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PinnedFoldersSectionComponent);
    fixture.componentRef.setInput('currentFolderId', 2);
  });

  it('does not reserve space without pins', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pinned-section')).toBeNull();
  });

  it('renders ordered accessible variants and emits only available navigation', () => {
    store.pinnedFolders.set([
      { id: 1, position: 0, name: 'Projetos', available: true, locked: false },
      { id: 2, position: 1, name: 'Pasta protegida', available: true, locked: true },
      { id: 3, position: 2, name: 'Pasta indisponível', available: false, locked: false },
    ]);
    fixture.componentRef.setInput('variant', 'default');
    fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll('.pinned-item') as NodeListOf<HTMLButtonElement>;
    expect(buttons.length).toBe(3);
    expect(buttons[0].textContent).toContain('Projetos');
    expect(buttons[0].querySelector('.pinned-folder-icon')?.getAttribute('src')).toContain('folder-default.ico');
    expect(buttons[0].getAttribute('aria-current')).toBeNull();
    expect(buttons[1].disabled).toBeTrue();
    expect(buttons[2].disabled).toBeTrue();
    expect(buttons[0].classList.contains('active')).toBeFalse();

    const navigate = jasmine.createSpy('navigate');
    fixture.componentInstance.navigate.subscribe(navigate);
    buttons[0].click();
    buttons[1].click();
    expect(navigate).toHaveBeenCalledOnceWith(1);
  });

  it('marks the current folder and shows loading/error feedback', () => {
    store.isLoading.set(true);
    store.error.set('offline');
    store.pinnedFolders.set([{ id: 2, position: 0, name: 'Pasta', available: true, locked: false }]);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.pinned-item') as HTMLButtonElement;
    expect(button.getAttribute('aria-current')).toBe('page');
    expect(fixture.nativeElement.querySelector('[role="status"]')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('offline');
  });

  it('opens the same folder actions from the context menu', async () => {
    const folder = { id: 2, position: 0, name: 'Pasta', available: true, locked: false };
    const file = { id: 2, isFolder: true, decryptedName: 'Pasta', encryptedName: 'encrypted' };
    store.pinnedFolders.set([folder]);
    driveStore.files.set([file]);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.pinned-item') as HTMLButtonElement;
    button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
    fixture.detectChanges();

    const menu = fixture.nativeElement.querySelector('.action-menu') as HTMLElement;
    expect(menu.textContent).toContain('Renomear');
    expect(menu.textContent).toContain('Desafixar do acesso rápido');
    expect(menu.textContent).toContain('Mover para a lixeira');

    dialogService.prompt.and.resolveTo('Renomeada');
    await fixture.componentInstance.onRename(2, new Event('click'));
    expect(driveStore.renameItem).toHaveBeenCalledWith(file, 'Renomeada');

    await fixture.componentInstance.onUnpin(2, new Event('click'));
    expect(store.unpin).toHaveBeenCalledWith(2);

    dialogService.confirm.and.resolveTo(true);
    await fixture.componentInstance.onDelete(2, new Event('click'));
    expect(driveStore.trashItem).toHaveBeenCalledWith(file);
  });
});
