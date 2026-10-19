import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppStateService } from '../../../../core/state/app-state.service';
import { CryptoService } from '../../../../core/crypto/crypto.service';
import { UnlockModalComponent } from './unlock-modal.component';

describe('UnlockModalComponent', () => {
  let cryptoService: jasmine.SpyObj<CryptoService>;
  let appState: jasmine.SpyObj<AppStateService>;

  beforeEach(() => {
    cryptoService = jasmine.createSpyObj('CryptoService', ['unlockVault']);
    appState = jasmine.createSpyObj('AppStateService', ['unlock']);

    TestBed.configureTestingModule({
      imports: [UnlockModalComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: CryptoService, useValue: cryptoService },
        { provide: AppStateService, useValue: appState },
      ],
    });
  });

  it('clears loading before closing after a successful unlock', async () => {
    cryptoService.unlockVault.and.resolveTo();
    const component = TestBed.createComponent(UnlockModalComponent).componentInstance;
    component.phrase = 'phrase';
    const closed = jasmine.createSpy('closed');
    component.modalClosed.subscribe(closed);

    await component.onSubmit();

    expect(appState.unlock).toHaveBeenCalled();
    expect(component.loading()).toBeFalse();
    expect(closed).toHaveBeenCalled();
  });
});
