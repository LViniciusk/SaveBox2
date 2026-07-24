import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { AppStateService } from '../state/app-state.service';
import { CryptoService } from './crypto.service';
import { vaultGuard } from './vault.guard';

describe('vaultGuard', () => {
  let appStateSpy: jasmine.SpyObj<AppStateService>;
  let cryptoSpy: jasmine.SpyObj<CryptoService>;

  beforeEach(() => {
    appStateSpy = jasmine.createSpyObj('AppStateService', ['lock']);
    cryptoSpy = jasmine.createSpyObj('CryptoService', ['isVaultUnlocked']);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: AppStateService, useValue: appStateSpy },
        { provide: CryptoService, useValue: cryptoSpy }
      ]
    });
  });

  const runGuard = () => {
    return TestBed.runInInjectionContext(() => vaultGuard({} as any, {} as any));
  };

  it('should call appState.lock() if vault is not unlocked and return true', () => {
    cryptoSpy.isVaultUnlocked.and.returnValue(false);
    
    const result = runGuard();
    
    expect(appStateSpy.lock).toHaveBeenCalled();
    expect(result).toBeTrue();
  });

  it('should NOT call appState.lock() if vault is already unlocked and return true', () => {
    cryptoSpy.isVaultUnlocked.and.returnValue(true);
    
    const result = runGuard();
    
    expect(appStateSpy.lock).not.toHaveBeenCalled();
    expect(result).toBeTrue();
  });
});
