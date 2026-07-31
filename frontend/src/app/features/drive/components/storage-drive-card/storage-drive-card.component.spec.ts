import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { StorageTarget } from '../../state/drive.types';
import { StorageDriveCardComponent } from './storage-drive-card.component';

describe('StorageDriveCardComponent', () => {
  let fixture: ComponentFixture<StorageDriveCardComponent>;
  const target: StorageTarget = {
    key: 'local', provider: 'local', label: 'Disco local', externalStorageId: null,
    usedBytes: 25, maxBytes: 100, availableBytes: 75, nanikaUsedBytes: 25, status: 'ready',
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [StorageDriveCardComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    fixture = TestBed.createComponent(StorageDriveCardComponent);
    fixture.componentRef.setInput('target', target);
    fixture.detectChanges();
  });

  it('renders capacity and opens a ready drive', () => {
    const opened = jasmine.createSpy('opened');
    fixture.componentInstance.opened.subscribe(opened);
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    button.click();

    expect(fixture.nativeElement.textContent).toContain('75 B livre(s) de 100 B');
    expect((fixture.nativeElement.querySelector('.capacity > span') as HTMLElement).style.width).toBe('25%');
    expect(opened).toHaveBeenCalledOnceWith(target);
  });

  it('disables unavailable accounts', () => {
    fixture.componentRef.setInput('target', { ...target, provider: 'google_drive', status: 'unavailable' });
    fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('button') as HTMLButtonElement).disabled).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain('Indisponível');
  });
});
