import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { GDriveSidebarComponent } from './gdrive-sidebar.component';

describe('GDriveSidebarComponent', () => {
  let fixture: ComponentFixture<GDriveSidebarComponent>;
  let component: GDriveSidebarComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GDriveSidebarComponent],
      providers: [provideZonelessChangeDetection()]
    }).compileComponents();

    fixture = TestBed.createComponent(GDriveSidebarComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('currentView', 'drive');
    fixture.componentRef.setInput('locked', false);
    fixture.componentRef.setInput('quota', { usedBytes: 1024, maxBytes: 2048 });
  });

  it('renders the current navigation and quota', () => {
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('#nav-my-vault')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.nav-item.active')?.textContent).toContain('Meu Drive');
    expect(fixture.nativeElement.querySelector('.storage-used')?.textContent).toContain('1 KB de 2 KB');
  });

  it('emits folder and upload actions from the New menu', () => {
    const folder = jasmine.createSpy('folder');
    const upload = jasmine.createSpy('upload');
    component.createFolderRequested.subscribe(folder);
    component.uploadFileRequested.subscribe(upload);
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('#new-btn') as HTMLButtonElement).click();
    fixture.detectChanges();
    const items = [...fixture.nativeElement.querySelectorAll('.dropdown-item')] as HTMLButtonElement[];
    items[0].click();
    (fixture.nativeElement.querySelector('#new-btn') as HTMLButtonElement).click();
    fixture.detectChanges();
    fixture.nativeElement.querySelectorAll('.dropdown-item')[1].click();

    expect(folder).toHaveBeenCalled();
    expect(upload).toHaveBeenCalled();
    expect(component.isNewMenuOpen()).toBeFalse();
  });

  it('emits real view changes and keeps placeholder navigation inert', () => {
    const changed = jasmine.createSpy('changed');
    component.viewChange.subscribe(changed);
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('#nav-trash') as HTMLButtonElement).click();
    (fixture.nativeElement.querySelector('.nav-item:nth-of-type(2)') as HTMLButtonElement).click();

    expect(changed).toHaveBeenCalledWith('trash');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('disables New while locked and shows Google Drive quota when available', () => {
    fixture.componentRef.setInput('locked', true);
    fixture.componentRef.setInput('quota', { usedBytes: 0, maxBytes: 100, gdriveUsedBytes: 50, gdriveMaxBytes: 100 });
    fixture.detectChanges();

    expect((fixture.nativeElement.querySelector('#new-btn') as HTMLButtonElement).disabled).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain('Google Drive');
    expect(fixture.nativeElement.querySelector('.gdrive-fill')).not.toBeNull();
  });

  it('handles empty quotas without division or formatting errors', () => {
    fixture.componentRef.setInput('quota', { usedBytes: 0, maxBytes: 0, gdriveUsedBytes: 0, gdriveMaxBytes: 0 });
    fixture.detectChanges();

    expect(component.getQuotaPercent()).toBe(0);
    expect(component.getGDriveQuotaPercent()).toBe(0);
    expect(component.getGDriveQuotaFormatted()).toBe('0 B de 0 B usados');

    fixture.componentRef.setInput('quota', { usedBytes: 0, maxBytes: 100, gdriveMaxBytes: 100 });
    expect(component.getGDriveQuotaPercent()).toBe(0);
    expect(component.getGDriveQuotaFormatted()).toBe('0 B de 100 B usados');
  });
});
