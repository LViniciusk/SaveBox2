import { Component, input, output } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { DefaultShellComponent } from './default-shell.component';

@Component({ selector: 'app-pinned-folders-section', standalone: true, template: '<span class="pinned-stub"></span>' })
class PinnedFoldersSectionStubComponent {
  readonly currentFolderId = input<number | null>(null);
  readonly locked = input(false);
  readonly showTitle = input(true);
  readonly variant = input<'gdrive' | 'default'>('gdrive');
  readonly navigate = output<number>();
}

@Component({ selector: 'app-drive-workspace', standalone: true, template: '<span class="workspace-stub"></span>' })
class WorkspaceStubComponent {
  readonly currentView = input<string>();
  readonly createFolderRequested = output<void>(); readonly uploadFileRequested = output<void>();
  readonly videoSelected = output<any>(); readonly imageSelected = output<any>(); readonly shareRequested = output<any>(); readonly emptyTrashRequested = output<void>();
}

@Component({ selector: 'app-topbar', standalone: true, template: '' })
class TopbarStubComponent {
  readonly compact = input(false);
}

describe('DefaultShellComponent', () => {
  let fixture: ComponentFixture<DefaultShellComponent>;
  let component: DefaultShellComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [DefaultShellComponent], providers: [provideZonelessChangeDetection()] })
      .overrideComponent(DefaultShellComponent, { set: { imports: [WorkspaceStubComponent, PinnedFoldersSectionStubComponent, TopbarStubComponent] } })
      .compileComponents();
    fixture = TestBed.createComponent(DefaultShellComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('currentView', 'drive');
    fixture.componentRef.setInput('quota', { usedBytes: 50, maxBytes: 100 });
  });

  it('renders Explorer chrome and the shared workspace slot', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.explorer-titlebar')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.address-bar')?.textContent).toContain('Nanika');
    expect(fixture.nativeElement.querySelector('.workspace-stub')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.storage-track span').style.width).toBe('50%');
  });

  it('renders the current folder path and human-readable storage sizes', () => {
    fixture.componentRef.setInput('currentPath', [
      { id: null, name: 'Meu Drive' },
      { id: 7, name: 'Projetos' },
      { id: 8, name: '2026' },
    ]);
    fixture.componentRef.setInput('quota', {
      usedBytes: 1024 * 1024,
      maxBytes: 2 * 1024 * 1024 * 1024,
      gdriveUsedBytes: 1024,
      gdriveMaxBytes: 4096,
    });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.address-bar')?.textContent.replace(/\s/g, ''))
      .toContain('Nanika>Projetos>2026');
    expect(fixture.nativeElement.querySelector('.storage-summary small')?.textContent)
      .toContain('1 MB de 2 GB');
    expect(fixture.nativeElement.querySelector('.storage-track.gdrive span').style.width).toBe('25%');
  });

  it('formats storage values using binary units', () => {
    expect(component.formatSize(0)).toBe('0 B');
    expect(component.formatSize(1024)).toBe('1 KB');
    expect(component.formatSize(1024 ** 2)).toBe('1 MB');
    expect(component.formatSize(1024 ** 3)).toBe('1 GB');
    expect(component.formatSize(1024 ** 4)).toBe('1 TB');
  });

  it('emits navigation and clamps empty/over quota values', () => {
    const changed = jasmine.createSpy('changed');
    component.viewChange.subscribe(changed);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.explorer-nav:nth-of-type(3)').click();
    expect(changed).toHaveBeenCalledWith('trash');

    fixture.componentRef.setInput('quota', { usedBytes: 300, maxBytes: 100 });
    expect(component.quotaPercent()).toBe(100);
    fixture.componentRef.setInput('quota', { usedBytes: 0, maxBytes: 0 });
    expect(component.quotaPercent()).toBe(0);
  });

  it('places pinned folders below Este Computador and exposes the lock action', () => {
    fixture.detectChanges();
    const sidebar = fixture.nativeElement.querySelector('.explorer-sidebar') as HTMLElement;
    const storage = sidebar.querySelectorAll('.explorer-nav')[1] as HTMLElement;
    const pinned = sidebar.querySelector('app-pinned-folders-section') as HTMLElement;
    expect(storage.compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const lock = jasmine.createSpy('lock');
    component.lockRequested.subscribe(lock);
    fixture.componentRef.setInput('locked', false);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[aria-label="Trancar Drive"]').click();
    expect(lock).toHaveBeenCalled();
  });

  it('emits back, forward, up and address navigation actions', () => {
    const back = jasmine.createSpy('back');
    const forward = jasmine.createSpy('forward');
    const up = jasmine.createSpy('up');
    const address = jasmine.createSpy('address');
    component.backRequested.subscribe(back);
    component.forwardRequested.subscribe(forward);
    component.upRequested.subscribe(up);
    component.addressNavigate.subscribe(address);
    fixture.componentRef.setInput('canGoBack', true);
    fixture.componentRef.setInput('canGoForward', true);
    fixture.componentRef.setInput('canGoUp', true);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[aria-label="Voltar"]').click();
    fixture.nativeElement.querySelector('[aria-label="Avançar"]').click();
    fixture.nativeElement.querySelector('[aria-label="Subir"]').click();
    fixture.nativeElement.querySelector('.address-bar').click();
    fixture.detectChanges();
    component.addressValue.set('Projetos/2026');
    component.submitAddress();

    expect(back).toHaveBeenCalled();
    expect(forward).toHaveBeenCalled();
    expect(up).toHaveBeenCalled();
    expect(address).toHaveBeenCalledWith('Nanika/Projetos/2026');
  });

  it('navigates to the clicked breadcrumb segment', () => {
    const address = jasmine.createSpy('address');
    component.addressNavigate.subscribe(address);
    fixture.componentRef.setInput('currentPath', [
      { id: null, name: 'Meu Drive' },
      { id: 7, name: 'Projetos' },
      { id: 8, name: '2026' },
    ]);
    fixture.detectChanges();

    (fixture.nativeElement.querySelectorAll('.address-segment')[1] as HTMLButtonElement).click();

    expect(address).toHaveBeenCalledWith('Nanika/Projetos');
  });
});
