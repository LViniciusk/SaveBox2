import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { DriveFile } from '../../state/drive.store';
import { StorageTarget } from '../../state/drive.types';
import { StorageTargetPickerComponent } from './storage-target-picker.component';

describe('StorageTargetPickerComponent', () => {
  let fixture: ComponentFixture<StorageTargetPickerComponent>;
  const file: DriveFile = {
    id: 1, isFolder: false, encryptedName: 'cipher', decryptedName: 'vídeo.mp4', type: 'video',
    sizeBytes: 80, proxySizeBytes: 30, sizeFormatted: '80 B', modifiedAt: '—', owner: 'eu',
    storageProvider: 'local', externalStorageId: null,
  };
  const targets: StorageTarget[] = [
    { key: 'local', provider: 'local', label: 'Local', externalStorageId: null, usedBytes: 0, maxBytes: 1000, availableBytes: 1000, nanikaUsedBytes: 0, status: 'ready' },
    { key: 'small', provider: 'google_drive', label: 'Sem espaço', externalStorageId: 2, usedBytes: 0, maxBytes: 100, availableBytes: 100, nanikaUsedBytes: 0, status: 'ready' },
    { key: 'google', provider: 'google_drive', label: 'Conta Google', externalStorageId: 3, usedBytes: 0, maxBytes: 1000, availableBytes: 1000, nanikaUsedBytes: 0, status: 'ready' },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [StorageTargetPickerComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    fixture = TestBed.createComponent(StorageTargetPickerComponent);
    fixture.componentRef.setInput('file', file);
    fixture.componentRef.setInput('targets', targets);
    fixture.detectChanges();
  });

  it('blocks the current drive and checks original plus proxy quota', () => {
    const buttons = [...fixture.nativeElement.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];
    expect(buttons[0].disabled).toBeTrue();
    expect(buttons[0].textContent).toContain('Armazenamento atual');
    expect(buttons[1].disabled).toBeTrue();
    expect(buttons[1].textContent).toContain('Espaço insuficiente');
    expect(buttons[2].disabled).toBeFalse();
  });

  it('emits only a valid selected destination', () => {
    const confirmed = jasmine.createSpy('confirmed');
    fixture.componentInstance.confirmed.subscribe(confirmed);
    fixture.componentInstance.selected.set(targets[2]);
    fixture.componentInstance.confirm();
    expect(confirmed).toHaveBeenCalledOnceWith(targets[2]);
  });
});
