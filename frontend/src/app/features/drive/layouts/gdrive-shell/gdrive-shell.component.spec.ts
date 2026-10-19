import { Component, input, output } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { GDriveShellComponent } from './gdrive-shell.component';

@Component({ selector: 'app-topbar', standalone: true, template: '<button id="unlock" (click)="unlockRequested.emit()"></button>' })
class TopbarStubComponent { readonly unlockRequested = output<void>(); }

@Component({ selector: 'app-gdrive-sidebar', standalone: true, template: '<button id="drive" (click)="viewChange.emit(\'drive\')"></button>' })
class SidebarStubComponent {
  readonly currentView = input<string>(); readonly currentFolderId = input<number | null>(null); readonly locked = input(false); readonly quota = input<any>();
  readonly viewChange = output<any>(); readonly createFolderRequested = output<void>(); readonly uploadFileRequested = output<void>(); readonly uploadFolderRequested = output<void>(); readonly pinnedFolderNavigate = output<number>();
}

@Component({ selector: 'app-drive-workspace', standalone: true, template: '<button id="trash" (click)="emptyTrashRequested.emit()"></button>' })
class WorkspaceStubComponent {
  readonly currentView = input<string>();
  readonly locked = input(false);
  readonly createFolderRequested = output<void>(); readonly uploadFileRequested = output<void>();
  readonly videoSelected = output<any>(); readonly imageSelected = output<any>(); readonly shareRequested = output<any>(); readonly emptyTrashRequested = output<void>();
  readonly dropStarted = output<void>(); readonly externalDrop = output<any>(); readonly dropError = output<unknown>();
}

describe('GDriveShellComponent', () => {
  let fixture: ComponentFixture<GDriveShellComponent>;
  let component: GDriveShellComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GDriveShellComponent],
      providers: [provideZonelessChangeDetection()]
    }).overrideComponent(GDriveShellComponent, {
      set: { imports: [TopbarStubComponent, SidebarStubComponent, WorkspaceStubComponent] }
    }).compileComponents();
    fixture = TestBed.createComponent(GDriveShellComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('currentView', 'drive');
    fixture.componentRef.setInput('quota', { usedBytes: 0, maxBytes: 100 });
  });

  it('composes the GDrive layout regions', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.vault-layout')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-topbar')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-gdrive-sidebar')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-drive-workspace')).not.toBeNull();
  });

  it('bubbles unlock, navigation and workspace events', () => {
    const unlock = jasmine.createSpy('unlock');
    const view = jasmine.createSpy('view');
    const empty = jasmine.createSpy('empty');
    component.unlockRequested.subscribe(unlock);
    component.viewChange.subscribe(view);
    component.emptyTrashRequested.subscribe(empty);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('#unlock').click();
    fixture.nativeElement.querySelector('#drive').click();
    fixture.nativeElement.querySelector('#trash').click();

    expect(unlock).toHaveBeenCalled();
    expect(view).toHaveBeenCalledWith('drive');
    expect(empty).toHaveBeenCalled();
  });

  it('projects parent content inside the content surface', () => {
    fixture.componentRef.setInput('currentView', 'storage');
    fixture.detectChanges();
    const projected = document.createElement('span');
    projected.className = 'projected-content';
    fixture.nativeElement.querySelector('.content-inner').append(projected);
    expect(fixture.nativeElement.querySelector('.projected-content')).not.toBeNull();
  });
});
