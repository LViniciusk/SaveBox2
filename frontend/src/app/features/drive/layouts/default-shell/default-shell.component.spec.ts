import { Component, input, output } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { DefaultShellComponent } from './default-shell.component';

@Component({ selector: 'app-drive-workspace', standalone: true, template: '<span class="workspace-stub"></span>' })
class WorkspaceStubComponent {
  readonly currentView = input<string>();
  readonly createFolderRequested = output<void>(); readonly uploadFileRequested = output<void>();
  readonly videoSelected = output<any>(); readonly imageSelected = output<any>(); readonly shareRequested = output<any>(); readonly emptyTrashRequested = output<void>();
}

describe('DefaultShellComponent', () => {
  let fixture: ComponentFixture<DefaultShellComponent>;
  let component: DefaultShellComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [DefaultShellComponent], providers: [provideZonelessChangeDetection()] })
      .overrideComponent(DefaultShellComponent, { set: { imports: [WorkspaceStubComponent] } })
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
});
