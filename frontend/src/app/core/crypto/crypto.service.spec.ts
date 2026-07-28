import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { CryptoService } from './crypto.service';
import { KasumiCryptoService } from './kasumi-crypto.service';
import { AppStateService } from '../state/app-state.service';
import { environment } from '../../../environments/environment';

describe('CryptoService', () => {
  let service: CryptoService;
  let kasumiSpy: jasmine.SpyObj<KasumiCryptoService>;
  let httpMock: HttpTestingController;
  let currentUser: { email: string } | null;

  beforeEach(() => {
    // Ponytail philosophy: isolate dependencies and test logic, not framework
    kasumiSpy = jasmine.createSpyObj('KasumiCryptoService', ['deriveVaultKey', 'decryptName', 'encryptName', 'hashName']);
    currentUser = { email: 'test@example.com' };
    const appStateSpy = jasmine.createSpyObj('AppStateService', [], {
      user: () => currentUser
    });

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        provideZonelessChangeDetection(),
        CryptoService,
        { provide: KasumiCryptoService, useValue: kasumiSpy },
        { provide: AppStateService, useValue: appStateSpy }
      ]
    });
    service = TestBed.inject(CryptoService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  describe('lockVault', () => {
    it('should securely discard vaultKey from RAM and revert unlock signal', () => {
      // Arrange
      // Inject a fake key into the private vaultKey using a mock or direct set (to test wiping)
      const fakeKey = new Uint8Array(32);
      fakeKey.fill(1);
      (service as any).vaultKey = fakeKey;
      (service as any)._isUnlocked.set(true);

      expect(service.getVaultKey()).not.toBeNull();
      expect(service.isVaultUnlocked()).toBeTrue();

      // Act
      service.lockVault();

      // Assert - Vital RAM discard proof
      expect(service.getVaultKey()).toBeNull();
      expect(service.isVaultUnlocked()).toBeFalse();
    });
  });

  it('should return plaintext names while locked and delegate crypto while unlocked', async () => {
    expect(await service.decryptName('plain')).toBe('plain');

    (service as any).vaultKey = new Uint8Array(32);
    kasumiSpy.decryptName.and.returnValue(Promise.resolve('decoded'));
    kasumiSpy.encryptName.and.returnValue(Promise.resolve('encoded'));
    kasumiSpy.hashName.and.returnValue(Promise.resolve('hash'));

    expect(await service.decryptName('cipher')).toBe('decoded');
    expect(await service.encryptName('name')).toBe('encoded');
    expect(await service.hashName('name')).toBe('hash');
    expect(kasumiSpy.decryptName).toHaveBeenCalled();
  });

  it('should expose safe errors for locked and failed name operations', async () => {
    await expectAsync(service.encryptName('name')).toBeRejectedWithError('Drive trancado');

    (service as any).vaultKey = new Uint8Array(32);
    kasumiSpy.decryptName.and.returnValue(Promise.reject(new Error('bad mac')));

    expect(await service.decryptName('cipher')).toBe('[Erro] Nome ilegivel');
  });

  it('should initialize and unlock a vault through the API', async () => {
    kasumiSpy.deriveVaultKey.and.returnValue(Promise.resolve(new Uint8Array(32).fill(1)));
    kasumiSpy.encryptName.and.returnValue(Promise.resolve('verification'));
    const initializePromise = service.initializeVault('phrase');
    await new Promise(resolve => setTimeout(resolve, 0));

    const init = httpMock.expectOne(`${environment.apiUrl}/api/vault/init`);
    expect(init.request.method).toBe('POST');
    init.flush({});
    await initializePromise;
    expect(service.isVaultUnlocked()).toBeTrue();

    service.lockVault();
    kasumiSpy.decryptName.and.returnValue(Promise.resolve(btoa(String.fromCharCode(...new Uint8Array(32).fill(2)))));
    const unlockPromise = service.unlockVault('phrase');
    await new Promise(resolve => setTimeout(resolve, 0));
    const verification = httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`);
    verification.flush({ vault_verification: 'token' });
    await unlockPromise;

    expect(service.getVaultKey()?.length).toBe(32);
    expect(service.isVaultUnlocked()).toBeTrue();
  });

  it('should report unlock failures', async () => {
    currentUser = null;
    await expectAsync(service.unlockVault('phrase')).toBeRejectedWithError('Email do utilizador nao encontrado no estado.');

    currentUser = { email: ' Test@Example.COM ' };
    kasumiSpy.deriveVaultKey.and.returnValue(Promise.resolve(new Uint8Array(32)));
    const missingPromise = service.unlockVault('phrase');
    await Promise.resolve();
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`).flush({});
    await expectAsync(missingPromise).toBeRejectedWithError('Drive nao inicializado');

    const wrongPromise = service.unlockVault('phrase');
    kasumiSpy.decryptName.and.returnValue(Promise.reject(new Error('wrong')));
    await Promise.resolve();
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`).flush({ vault_verification: 'token' });
    await expectAsync(wrongPromise).toBeRejectedWithError('WRONG_PASSPHRASE');

    const malformedPromise = service.unlockVault('phrase');
    kasumiSpy.decryptName.and.returnValue(Promise.resolve('not-base64'));
    await new Promise(resolve => setTimeout(resolve, 0));
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`).flush({ vault_verification: 'token' });
    await expectAsync(malformedPromise).toBeRejectedWithError('WRONG_PASSPHRASE');

    const networkPromise = service.unlockVault('phrase');
    await new Promise(resolve => setTimeout(resolve, 0));
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`).error(new ProgressEvent('error'));
    await expectAsync(networkPromise).toBeRejected();
  });

  it('should reject vault initialization when the user email is unavailable', async () => {
    currentUser = null;
    await expectAsync(service.initializeVault('phrase'))
      .toBeRejectedWithError('Email do utilizador nao encontrado no estado.');
    await expectAsync(service.changeSecurityPhrase('old', 'new'))
      .toBeRejectedWithError('Drive trancado');

    (service as any).vaultKey = new Uint8Array(32);
    await expectAsync(service.changeSecurityPhrase('old', 'new'))
      .toBeRejectedWithError('Email do utilizador nao encontrado no estado.');

    currentUser = { email: 'test@example.com' };
    kasumiSpy.deriveVaultKey.and.returnValue(Promise.resolve(new Uint8Array(32)));
    const uninitializedPromise = service.changeSecurityPhrase('old', 'new');
    await new Promise(resolve => setTimeout(resolve, 0));
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`).flush({});
    await expectAsync(uninitializedPromise).toBeRejectedWithError('Drive nao inicializado');
  });
});
