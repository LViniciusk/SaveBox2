import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { CryptoService } from './crypto.service';
import { KasumiCryptoService } from './kasumi-crypto.service';
import { AppStateService } from '../state/app-state.service';
import { environment } from '../../../environments/environment';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(value => { resolve = value; });
  return { promise, resolve };
}

function base64Key(length: number, value = 7): string {
  return btoa(String.fromCharCode(...new Uint8Array(length).fill(value)));
}

async function settle<T>(promise: Promise<T>): Promise<{ resolved: boolean; error?: unknown }> {
  try {
    await promise;
    return { resolved: true };
  } catch (error) {
    return { resolved: false, error };
  }
}

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
      expect(fakeKey).toEqual(new Uint8Array(32));

      service.lockVault();
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
      .toBeRejectedWithError('VAULT_LOCKED');

    expect(kasumiSpy.deriveVaultKey).not.toHaveBeenCalled();
    expect(kasumiSpy.decryptName).not.toHaveBeenCalled();
    expect(kasumiSpy.encryptName).not.toHaveBeenCalled();

    (service as any).vaultKey = new Uint8Array(32);
    await expectAsync(service.changeSecurityPhrase('old', 'new'))
      .toBeRejectedWithError('USER_CONTEXT_MISSING');

    expect(kasumiSpy.deriveVaultKey).not.toHaveBeenCalled();
    expect(kasumiSpy.decryptName).not.toHaveBeenCalled();
    expect(kasumiSpy.encryptName).not.toHaveBeenCalled();

    currentUser = { email: 'test@example.com' };
    kasumiSpy.deriveVaultKey.and.returnValue(Promise.resolve(new Uint8Array(32)));
    const uninitializedPromise = service.changeSecurityPhrase('old', 'new');
    await new Promise(resolve => setTimeout(resolve, 0));
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`).flush({});
    await expectAsync(uninitializedPromise).toBeRejectedWithError('VAULT_NOT_INITIALIZED');
  });

  it('changes only the Vault Key wrapping and sends no plaintext material', async () => {
    const vaultKey = new Uint8Array(32).fill(7);
    const oldMasterKey = new Uint8Array(32).fill(1);
    const newMasterKey = new Uint8Array(32).fill(2);
    (service as any).vaultKey = vaultKey;
    kasumiSpy.deriveVaultKey.and.callFake((phrase: string) =>
      Promise.resolve(phrase === 'old' ? oldMasterKey : newMasterKey));
    kasumiSpy.decryptName.and.returnValue(Promise.resolve(btoa(String.fromCharCode(...vaultKey))));
    kasumiSpy.encryptName.and.returnValue(Promise.resolve('encrypted-new-verification'));
    const objectUrl = spyOn(URL, 'createObjectURL');

    const changePromise = service.changeSecurityPhrase('old', 'new phrase');
    await Promise.resolve();
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`).flush({ vault_verification: 'encrypted-old' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const update = httpMock.expectOne(`${environment.apiUrl}/api/vault/init`);
    expect(update.request.body).toEqual({ vault_verification: 'encrypted-new-verification' });
    expect(JSON.stringify(update.request.body)).not.toContain('old');
    expect(JSON.stringify(update.request.body)).not.toContain('new phrase');
    expect(JSON.stringify(update.request.body)).not.toContain('Vault Key');
    update.flush({});
    await changePromise;

    expect(service.getVaultKey()).toBe(vaultKey);
    expect(Array.from(vaultKey)).toEqual(new Array(32).fill(7));
    expect(Array.from(oldMasterKey)).toEqual(new Array(32).fill(0));
    expect(Array.from(newMasterKey)).toEqual(new Array(32).fill(0));
    expect(objectUrl).not.toHaveBeenCalled();
  });

  it('rejects the phrase update locally when the old phrase MAC is invalid', async () => {
    const vaultKey = new Uint8Array(32).fill(7);
    const oldMasterKey = new Uint8Array(32).fill(1);
    (service as any).vaultKey = vaultKey;
    kasumiSpy.deriveVaultKey.and.resolveTo(oldMasterKey);
    kasumiSpy.decryptName.and.returnValue(Promise.reject(new Error('bad mac')));

    const changePromise = service.changeSecurityPhrase('wrong', 'new phrase');
    await Promise.resolve();
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`).flush({ vault_verification: 'encrypted-old' });

    await expectAsync(changePromise).toBeRejectedWithError('CURRENT_PHRASE_INCORRECT');
    expect(Array.from(oldMasterKey)).toEqual(new Array(32).fill(0));
    expect(service.getVaultKey()).toBe(vaultKey);
    expect(Array.from(vaultKey)).toEqual(new Array(32).fill(7));
    expect(kasumiSpy.deriveVaultKey).toHaveBeenCalledOnceWith('wrong', 'test@example.com');
    httpMock.expectNone(`${environment.apiUrl}/api/vault/init`);
  });

  it('uses the normalized email as salt for both master-key derivations', async () => {
    currentUser = { email: ' Test@Example.COM ' };
    const vaultKey = new Uint8Array(32).fill(7);
    const oldMasterKey = new Uint8Array(32).fill(1);
    const newMasterKey = new Uint8Array(32).fill(2);
    const derivations: Array<[string, string]> = [];
    (service as any).vaultKey = vaultKey;
    kasumiSpy.deriveVaultKey.and.callFake((phrase: string, salt: string) => {
      derivations.push([phrase, salt]);
      return Promise.resolve(phrase === 'old' ? oldMasterKey : newMasterKey);
    });
    kasumiSpy.decryptName.and.resolveTo('verified');
    kasumiSpy.encryptName.and.resolveTo('encrypted-new-verification');

    const changePromise = service.changeSecurityPhrase('old', 'new');
    await Promise.resolve();
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`)
      .flush({ vault_verification: 'encrypted-old' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const update = httpMock.expectOne(`${environment.apiUrl}/api/vault/init`);
    update.flush({});
    await changePromise;

    expect(derivations).toEqual([
      ['old', 'test@example.com'],
      ['new', 'test@example.com'],
    ]);
  });

  it('keeps the active Vault Key when deriving the old master key fails', async () => {
    const vaultKey = new Uint8Array(32).fill(7);
    (service as any).vaultKey = vaultKey;
    kasumiSpy.deriveVaultKey.and.rejectWith(new Error('kdf failed'));

    await expectAsync(service.changeSecurityPhrase('old', 'new'))
      .toBeRejectedWithError('CRYPTO_OPERATION_FAILED');

    expect(service.getVaultKey()).toBe(vaultKey);
    expect(Array.from(vaultKey)).toEqual(new Array(32).fill(7));
    expect(kasumiSpy.deriveVaultKey).toHaveBeenCalledOnceWith('old', 'test@example.com');
    expect(kasumiSpy.decryptName).not.toHaveBeenCalled();
    expect(kasumiSpy.encryptName).not.toHaveBeenCalled();
    httpMock.expectNone(`${environment.apiUrl}/api/vault/verification`);
    httpMock.expectNone(`${environment.apiUrl}/api/vault/init`);
  });

  it('zeroizes the old master key when verification lookup fails', async () => {
    const vaultKey = new Uint8Array(32).fill(7);
    const oldMasterKey = new Uint8Array(32).fill(1);
    (service as any).vaultKey = vaultKey;
    kasumiSpy.deriveVaultKey.and.resolveTo(oldMasterKey);

    const changePromise = service.changeSecurityPhrase('old', 'new');
    await Promise.resolve();
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`)
      .error(new ProgressEvent('error'));

    await expectAsync(changePromise).toBeRejectedWithError('NETWORK_UNAVAILABLE');
    expect(Array.from(oldMasterKey)).toEqual(new Array(32).fill(0));
    expect(service.getVaultKey()).toBe(vaultKey);
    expect(kasumiSpy.decryptName).not.toHaveBeenCalled();
    expect(kasumiSpy.encryptName).not.toHaveBeenCalled();
    httpMock.expectNone(`${environment.apiUrl}/api/vault/init`);
  });

  it('preserves the verification error matrix', async () => {
    for (const [status, expected] of [
      [401, 'SESSION_EXPIRED'],
      [404, 'VAULT_NOT_INITIALIZED'],
      [500, 'SERVER_UNAVAILABLE'],
      [400, 'VAULT_UPDATE_FAILED'],
      [403, 'VAULT_UPDATE_FAILED'],
    ] as const) {
      const vaultKey = new Uint8Array(32).fill(7);
      const oldMasterKey = new Uint8Array(32).fill(1);
      (service as any).vaultKey = vaultKey;
      kasumiSpy.deriveVaultKey.and.resolveTo(oldMasterKey);
      const changePromise = service.changeSecurityPhrase('old', 'new');
      await Promise.resolve();
      httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`)
        .flush({}, { status, statusText: 'failure' });

      await expectAsync(changePromise).toBeRejectedWithError(expected);
      expect(Array.from(oldMasterKey)).toEqual(new Array(32).fill(0));
      expect(service.getVaultKey()).toBe(vaultKey);
      expect(kasumiSpy.decryptName).not.toHaveBeenCalled();
      expect(kasumiSpy.encryptName).not.toHaveBeenCalled();
    }
  });

  it('maps a network verification failure to NETWORK_UNAVAILABLE', async () => {
    const vaultKey = new Uint8Array(32).fill(7);
    const oldMasterKey = new Uint8Array(32).fill(1);
    (service as any).vaultKey = vaultKey;
    kasumiSpy.deriveVaultKey.and.resolveTo(oldMasterKey);
    const changePromise = service.changeSecurityPhrase('old', 'new');
    await Promise.resolve();
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`)
      .error(new ProgressEvent('error'));

    await expectAsync(changePromise).toBeRejectedWithError('NETWORK_UNAVAILABLE');
    expect(Array.from(oldMasterKey)).toEqual(new Array(32).fill(0));
    httpMock.expectNone(`${environment.apiUrl}/api/vault/init`);
  });

  it('rejects malformed verification values without deriving the new key', async () => {
    for (const value of [{}, { vault_verification: null }, { vault_verification: '' }, { vault_verification: 123 }]) {
      const vaultKey = new Uint8Array(32).fill(7);
      const oldMasterKey = new Uint8Array(32).fill(1);
      (service as any).vaultKey = vaultKey;
      kasumiSpy.deriveVaultKey.and.resolveTo(oldMasterKey);
      const changePromise = service.changeSecurityPhrase('old', 'new');
      await Promise.resolve();
      httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`).flush(value);

      await expectAsync(changePromise).toBeRejectedWithError('VAULT_NOT_INITIALIZED');
      expect(Array.from(oldMasterKey)).toEqual(new Array(32).fill(0));
      expect(kasumiSpy.decryptName).not.toHaveBeenCalled();
      expect(kasumiSpy.encryptName).not.toHaveBeenCalled();
      httpMock.expectNone(`${environment.apiUrl}/api/vault/init`);
      kasumiSpy.decryptName.calls.reset();
      kasumiSpy.encryptName.calls.reset();
    }
  });

  it('maps replacement-key derivation failures without posting an update', async () => {
    const vaultKey = new Uint8Array(32).fill(7);
    const oldMasterKey = new Uint8Array(32).fill(1);
    (service as any).vaultKey = vaultKey;
    kasumiSpy.deriveVaultKey.and.callFake((phrase: string) =>
      phrase === 'old' ? Promise.resolve(oldMasterKey) : Promise.reject(new Error('kdf failed')));
    kasumiSpy.decryptName.and.resolveTo('verified');

    const changePromise = service.changeSecurityPhrase('old', 'new');
    await Promise.resolve();
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`)
      .flush({ vault_verification: 'encrypted-old' });

    await expectAsync(changePromise).toBeRejectedWithError('CRYPTO_OPERATION_FAILED');
    expect(Array.from(oldMasterKey)).toEqual(new Array(32).fill(0));
    expect(service.getVaultKey()).toBe(vaultKey);
    expect(Array.from(vaultKey)).toEqual(new Array(32).fill(7));
    expect(kasumiSpy.encryptName).not.toHaveBeenCalled();
    httpMock.expectNone(`${environment.apiUrl}/api/vault/init`);
  });

  it('maps wrapping failures without posting an update', async () => {
    const vaultKey = new Uint8Array(32).fill(7);
    const oldMasterKey = new Uint8Array(32).fill(1);
    const newMasterKey = new Uint8Array(32).fill(2);
    (service as any).vaultKey = vaultKey;
    kasumiSpy.deriveVaultKey.and.callFake((phrase: string) =>
      Promise.resolve(phrase === 'old' ? oldMasterKey : newMasterKey));
    kasumiSpy.decryptName.and.resolveTo('verified');
    kasumiSpy.encryptName.and.rejectWith(new Error('encrypt failed'));

    const changePromise = service.changeSecurityPhrase('old', 'new');
    await Promise.resolve();
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`)
      .flush({ vault_verification: 'encrypted-old' });

    await expectAsync(changePromise).toBeRejectedWithError('CRYPTO_OPERATION_FAILED');
    expect(Array.from(oldMasterKey)).toEqual(new Array(32).fill(0));
    expect(Array.from(newMasterKey)).toEqual(new Array(32).fill(0));
    expect(service.getVaultKey()).toBe(vaultKey);
    expect(Array.from(vaultKey)).toEqual(new Array(32).fill(7));
    httpMock.expectNone(`${environment.apiUrl}/api/vault/init`);
  });

  it('preserves the update error matrix and key identity after POST failure', async () => {
    for (const [status, expected] of [
      [401, 'SESSION_EXPIRED'],
      [0, 'NETWORK_UNAVAILABLE'],
      [400, 'VAULT_UPDATE_FAILED'],
      [403, 'VAULT_UPDATE_FAILED'],
      [404, 'VAULT_UPDATE_FAILED'],
      [500, 'SERVER_UNAVAILABLE'],
    ] as const) {
      const vaultKey = new Uint8Array(32).fill(7);
      const oldMasterKey = new Uint8Array(32).fill(1);
      const newMasterKey = new Uint8Array(32).fill(2);
      (service as any).vaultKey = vaultKey;
      kasumiSpy.deriveVaultKey.and.callFake((phrase: string) =>
        Promise.resolve(phrase === 'old' ? oldMasterKey : newMasterKey));
      kasumiSpy.decryptName.and.resolveTo('verified');
      kasumiSpy.encryptName.and.resolveTo('encrypted-new-verification');

      const changePromise = service.changeSecurityPhrase('old', 'new');
      await Promise.resolve();
      httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`)
        .flush({ vault_verification: 'encrypted-old' });
      await new Promise(resolve => setTimeout(resolve, 0));
      const update = httpMock.expectOne(`${environment.apiUrl}/api/vault/init`);
      if (status === 0) update.error(new ProgressEvent('error'));
      else update.flush({}, { status, statusText: 'failure' });

      await expectAsync(changePromise).toBeRejectedWithError(expected);
      expect(Array.from(oldMasterKey)).toEqual(new Array(32).fill(0));
      expect(Array.from(newMasterKey)).toEqual(new Array(32).fill(0));
      expect(service.getVaultKey()).toBe(vaultKey);
      expect(Array.from(vaultKey)).toEqual(new Array(32).fill(7));
      kasumiSpy.decryptName.calls.reset();
      kasumiSpy.encryptName.calls.reset();
    }
  });

  it('rejects a phrase change when the vault is locked during new-key derivation', async () => {
    const vaultKey = new Uint8Array(32).fill(7);
    const oldMasterKey = new Uint8Array(32).fill(1);
    const newMasterKey = new Uint8Array(32).fill(2);
    let releaseNew!: (key: Uint8Array) => void;
    let markNewDerivationStarted!: () => void;
    const newDerivation = new Promise<Uint8Array>(resolve => { releaseNew = resolve; });
    const newDerivationStarted = new Promise<void>(resolve => { markNewDerivationStarted = resolve; });
    (service as any).vaultKey = vaultKey;
    kasumiSpy.deriveVaultKey.and.callFake((phrase: string) => {
      if (phrase === 'old') return Promise.resolve(oldMasterKey);
      markNewDerivationStarted();
      return newDerivation;
    });
    kasumiSpy.decryptName.and.resolveTo('verified');

    const changePromise = service.changeSecurityPhrase('old', 'new');
    await Promise.resolve();
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`)
      .flush({ vault_verification: 'encrypted-old' });
    await newDerivationStarted;

    service.lockVault();
    expect(service.getVaultKey()).toBeNull();
    expect(Array.from(vaultKey)).toEqual(new Array(32).fill(0));
    releaseNew(newMasterKey);

    await expectAsync(changePromise).toBeRejectedWithError('CRYPTO_OPERATION_FAILED');
    expect(Array.from(oldMasterKey)).toEqual(new Array(32).fill(0));
    expect(Array.from(newMasterKey)).toEqual(new Array(32).fill(0));
    httpMock.expectNone(`${environment.apiUrl}/api/vault/init`);
  });

  it('zeroizes the current master key before deriving the replacement key', async () => {
    const vaultKey = new Uint8Array(32).fill(7);
    const oldMasterKey = new Uint8Array(32).fill(1);
    const newMasterKey = new Uint8Array(32).fill(2);
    (service as any).vaultKey = vaultKey;
    kasumiSpy.deriveVaultKey.and.callFake((phrase: string) => {
      if (phrase === 'new') expect(Array.from(oldMasterKey)).toEqual(new Array(32).fill(0));
      return Promise.resolve(phrase === 'old' ? oldMasterKey : newMasterKey);
    });
    kasumiSpy.decryptName.and.resolveTo('verified');
    kasumiSpy.encryptName.and.resolveTo('encrypted-new-verification');

    const changePromise = service.changeSecurityPhrase('old', 'new');
    await Promise.resolve();
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`)
      .flush({ vault_verification: 'encrypted-old' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const update = httpMock.expectOne(`${environment.apiUrl}/api/vault/init`);
    update.flush({});
    await changePromise;
  });

  it('zeroizes the replacement master key before POST completion', async () => {
    const vaultKey = new Uint8Array(32).fill(7);
    const oldMasterKey = new Uint8Array(32).fill(1);
    const newMasterKey = new Uint8Array(32).fill(2);
    (service as any).vaultKey = vaultKey;
    kasumiSpy.deriveVaultKey.and.callFake((phrase: string) =>
      Promise.resolve(phrase === 'old' ? oldMasterKey : newMasterKey));
    kasumiSpy.decryptName.and.resolveTo('verified');
    kasumiSpy.encryptName.and.resolveTo('encrypted-new-verification');

    const changePromise = service.changeSecurityPhrase('old', 'new');
    await Promise.resolve();
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`)
      .flush({ vault_verification: 'encrypted-old' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const update = httpMock.expectOne(`${environment.apiUrl}/api/vault/init`);
    expect(Array.from(newMasterKey)).toEqual(new Array(32).fill(0));
    update.flush({});
    await changePromise;
  });

  it('has both master keys wiped before a representative POST failure arrives', async () => {
    const vaultKey = new Uint8Array(32).fill(7);
    const oldMasterKey = new Uint8Array(32).fill(1);
    const newMasterKey = new Uint8Array(32).fill(2);
    (service as any).vaultKey = vaultKey;
    kasumiSpy.deriveVaultKey.and.callFake((phrase: string) =>
      Promise.resolve(phrase === 'old' ? oldMasterKey : newMasterKey));
    kasumiSpy.decryptName.and.resolveTo('verified');
    kasumiSpy.encryptName.and.resolveTo('encrypted-new-verification');

    const changePromise = service.changeSecurityPhrase('old', 'new');
    await Promise.resolve();
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`)
      .flush({ vault_verification: 'encrypted-old' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const update = httpMock.expectOne(`${environment.apiUrl}/api/vault/init`);
    expect(Array.from(oldMasterKey)).toEqual(new Array(32).fill(0));
    expect(Array.from(newMasterKey)).toEqual(new Array(32).fill(0));
    update.flush({}, { status: 500, statusText: 'failure' });

    await expectAsync(changePromise).toBeRejectedWithError('SERVER_UNAVAILABLE');
    expect(service.getVaultKey()).toBe(vaultKey);
    expect(Array.from(vaultKey)).toEqual(new Array(32).fill(7));
  });

  it('maps verification HTTP failures to stable errors', async () => {
    for (const [status, expected] of [
      [401, 'SESSION_EXPIRED'], [404, 'VAULT_NOT_INITIALIZED'], [500, 'SERVER_UNAVAILABLE'],
    ] as const) {
      (service as any).vaultKey = new Uint8Array(32);
      kasumiSpy.deriveVaultKey.and.returnValue(Promise.resolve(new Uint8Array(32)));
      const promise = service.changeSecurityPhrase('old', 'new phrase');
      await Promise.resolve();
      const request = httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`);
      request.flush({}, { status, statusText: 'failure' });
      await expectAsync(promise).toBeRejectedWithError(expected);
    }
  });

  it('does not update the backend when verification lookup is offline', async () => {
    (service as any).vaultKey = new Uint8Array(32);
    kasumiSpy.deriveVaultKey.and.returnValue(Promise.resolve(new Uint8Array(32)));
    const promise = service.changeSecurityPhrase('old', 'new phrase');
    await Promise.resolve();
    httpMock.expectOne(`${environment.apiUrl}/api/vault/verification`)
      .error(new ProgressEvent('error'));

    await expectAsync(promise).toBeRejectedWithError('NETWORK_UNAVAILABLE');
    httpMock.expectNone(`${environment.apiUrl}/api/vault/init`);
  });

  describe('unlock ownership and key hygiene', () => {
    const verificationUrl = `${environment.apiUrl}/api/vault/verification`;

    it('rejects and stops before HTTP when locked during KDF', async () => {
      const masterKey = new Uint8Array(32).fill(1);
      const kdf = deferred<Uint8Array>();
      kasumiSpy.deriveVaultKey.and.returnValue(kdf.promise);
      kasumiSpy.decryptName.and.resolveTo(base64Key(32));

      const unlock = service.unlockVault('phrase');
      service.lockVault();
      kdf.resolve(masterKey);
      await new Promise(resolve => setTimeout(resolve, 0));
      httpMock.match(verificationUrl).forEach(request => request.flush({ vault_verification: 'token' }));

      const result = await settle(unlock);
      expect(result.resolved).toBeFalse();
      expect((result.error as Error).message).toBe('UNLOCK_CANCELLED');
      expect(masterKey).toEqual(new Uint8Array(32));
      expect(service.getVaultKey()).toBeNull();
      expect(service.isVaultUnlocked()).toBeFalse();
    });

    it('rejects and stops before decrypt when locked during verification GET', async () => {
      const masterKey = new Uint8Array(32).fill(1);
      kasumiSpy.deriveVaultKey.and.resolveTo(masterKey);
      kasumiSpy.decryptName.and.resolveTo(base64Key(32));

      const unlock = service.unlockVault('phrase');
      await Promise.resolve();
      const request = httpMock.expectOne(verificationUrl);
      service.lockVault();
      request.flush({ vault_verification: 'token' });

      const result = await settle(unlock);
      expect(result.resolved).toBeFalse();
      expect((result.error as Error).message).toBe('UNLOCK_CANCELLED');
      expect(kasumiSpy.decryptName).not.toHaveBeenCalled();
      expect(masterKey).toEqual(new Uint8Array(32));
      expect(service.getVaultKey()).toBeNull();
      expect(service.isVaultUnlocked()).toBeFalse();
    });

    it('rejects without publishing when locked during verification decrypt', async () => {
      const masterKey = new Uint8Array(32).fill(1);
      const decryption = deferred<string>();
      kasumiSpy.deriveVaultKey.and.resolveTo(masterKey);
      kasumiSpy.decryptName.and.returnValue(decryption.promise);

      const unlock = service.unlockVault('phrase');
      await Promise.resolve();
      httpMock.expectOne(verificationUrl).flush({ vault_verification: 'token' });
      await Promise.resolve();
      service.lockVault();
      decryption.resolve(base64Key(32));

      const result = await settle(unlock);
      expect(result.resolved).toBeFalse();
      expect((result.error as Error).message).toBe('UNLOCK_CANCELLED');
      expect(masterKey).toEqual(new Uint8Array(32));
      expect(service.getVaultKey()).toBeNull();
      expect(service.isVaultUnlocked()).toBeFalse();
    });

    it('lets only the latest-started unlock commit when A resolves before B', async () => {
      const masterA = new Uint8Array(32).fill(1);
      const masterB = new Uint8Array(32).fill(2);
      const keyA = base64Key(32, 3);
      const keyB = base64Key(32, 4);
      const kdfA = deferred<Uint8Array>();
      const kdfB = deferred<Uint8Array>();
      kasumiSpy.deriveVaultKey.and.callFake((phrase: string) => phrase === 'a' ? kdfA.promise : kdfB.promise);
      kasumiSpy.decryptName.and.callFake((token: string) => Promise.resolve(token === 'a' ? keyA : keyB));

      const unlockA = service.unlockVault('a');
      const unlockB = service.unlockVault('b');
      kdfA.resolve(masterA);
      await new Promise(resolve => setTimeout(resolve, 0));
      httpMock.match(verificationUrl).forEach(request => request.flush({ vault_verification: 'a' }));
      const resultA = await settle(unlockA);

      kdfB.resolve(masterB);
      await new Promise(resolve => setTimeout(resolve, 0));
      httpMock.expectOne(verificationUrl).flush({ vault_verification: 'b' });
      const resultB = await settle(unlockB);

      expect(resultA.resolved).toBeFalse();
      expect((resultA.error as Error).message).toBe('UNLOCK_CANCELLED');
      expect(resultB.resolved).toBeTrue();
      expect(service.getVaultKey()).not.toBeNull();
      expect(Array.from(service.getVaultKey()!)).toEqual(new Array(32).fill(4));
      expect(masterA).toEqual(new Uint8Array(32));
      expect(masterB).toEqual(new Uint8Array(32));
    });

    it('keeps the latest-started unlock when B resolves before A', async () => {
      const masterA = new Uint8Array(32).fill(1);
      const masterB = new Uint8Array(32).fill(2);
      const kdfA = deferred<Uint8Array>();
      const kdfB = deferred<Uint8Array>();
      kasumiSpy.deriveVaultKey.and.callFake((phrase: string) => phrase === 'a' ? kdfA.promise : kdfB.promise);
      kasumiSpy.decryptName.and.callFake((token: string) => Promise.resolve(base64Key(32, token === 'a' ? 3 : 4)));

      const unlockA = service.unlockVault('a');
      const unlockB = service.unlockVault('b');
      kdfB.resolve(masterB);
      await new Promise(resolve => setTimeout(resolve, 0));
      httpMock.expectOne(verificationUrl).flush({ vault_verification: 'b' });
      const resultB = await settle(unlockB);

      kdfA.resolve(masterA);
      await new Promise(resolve => setTimeout(resolve, 0));
      httpMock.match(verificationUrl).forEach(request => request.flush({ vault_verification: 'a' }));
      const resultA = await settle(unlockA);

      expect(resultB.resolved).toBeTrue();
      expect(resultA.resolved).toBeFalse();
      expect((resultA.error as Error).message).toBe('UNLOCK_CANCELLED');
      expect(Array.from(service.getVaultKey()!)).toEqual(new Array(32).fill(4));
      expect(masterA).toEqual(new Uint8Array(32));
      expect(masterB).toEqual(new Uint8Array(32));
    });

    it('requires a string verification and exactly 32 decoded Vault Key bytes', async () => {
      kasumiSpy.deriveVaultKey.and.resolveTo(new Uint8Array(32).fill(1));
      kasumiSpy.decryptName.and.callFake(() => Promise.resolve(base64Key(32)));

      for (const response of [null, {}, { vault_verification: '' }, { vault_verification: 123 }] as const) {
        service.lockVault();
        kasumiSpy.decryptName.calls.reset();
        const unlock = service.unlockVault('phrase');
        await Promise.resolve();
        httpMock.expectOne(verificationUrl).flush(response);
        const result = await settle(unlock);
        expect(result.resolved).toBeFalse();
        expect((result.error as Error).message).toBe('Drive nao inicializado');
        expect(kasumiSpy.decryptName).not.toHaveBeenCalled();
        expect(service.getVaultKey()).toBeNull();
      }

      for (const length of [31, 33]) {
        service.lockVault();
        kasumiSpy.decryptName.and.resolveTo(base64Key(length));
        const unlock = service.unlockVault('phrase');
        await Promise.resolve();
        httpMock.expectOne(verificationUrl).flush({ vault_verification: 'token' });
        const result = await settle(unlock);
        expect(result.resolved).toBeFalse();
        expect((result.error as Error).message).toBe('WRONG_PASSPHRASE');
        expect(service.getVaultKey()).toBeNull();
        expect(service.isVaultUnlocked()).toBeFalse();
      }

      service.lockVault();
      kasumiSpy.decryptName.and.resolveTo(base64Key(32));
      const validUnlock = service.unlockVault('phrase');
      await Promise.resolve();
      const validRequest = httpMock.expectOne(verificationUrl);
      expect(validRequest.request.withCredentials).toBeTrue();
      expect(validRequest.request.urlWithParams).not.toContain('phrase');
      validRequest.flush({ vault_verification: 'token' });
      await validUnlock;
      expect(Array.from(service.getVaultKey()!)).toEqual(new Array(32).fill(7));
      expect(service.isVaultUnlocked()).toBeTrue();
    });

    it('wipes the transient Master Key immediately after decrypt resolves', async () => {
      const masterKey = new Uint8Array(32).fill(1);
      const decryption = deferred<string>();
      let decryptStarted!: () => void;
      const started = new Promise<void>(resolve => { decryptStarted = resolve; });
      kasumiSpy.deriveVaultKey.and.resolveTo(masterKey);
      kasumiSpy.decryptName.and.callFake(() => {
        decryptStarted();
        return decryption.promise;
      });

      const unlock = service.unlockVault('phrase');
      await Promise.resolve();
      httpMock.expectOne(verificationUrl).flush({ vault_verification: 'token' });
      await started;
      expect(masterKey).toEqual(new Uint8Array(32).fill(1));
      decryption.resolve(base64Key(32));
      await unlock;
      expect(masterKey).toEqual(new Uint8Array(32));
    });

    it('wipes the replaced active key only after a successful re-unlock', async () => {
      const oldVaultKey = new Uint8Array(32).fill(7);
      (service as any).vaultKey = oldVaultKey;
      (service as any)._isUnlocked.set(true);
      kasumiSpy.deriveVaultKey.and.resolveTo(new Uint8Array(32).fill(1));
      kasumiSpy.decryptName.and.resolveTo(base64Key(32, 9));

      const unlock = service.unlockVault('phrase');
      await Promise.resolve();
      httpMock.expectOne(verificationUrl).flush({ vault_verification: 'token' });
      await unlock;

      expect(service.getVaultKey()).not.toBe(oldVaultKey);
      expect(Array.from(oldVaultKey)).toEqual(new Array(32).fill(0));
      expect(Array.from(service.getVaultKey()!)).toEqual(new Array(32).fill(9));
      expect(service.isVaultUnlocked()).toBeTrue();
    });

    it('preserves the active key when a re-unlock fails', async () => {
      const oldVaultKey = new Uint8Array(32).fill(7);
      (service as any).vaultKey = oldVaultKey;
      (service as any)._isUnlocked.set(true);
      kasumiSpy.deriveVaultKey.and.resolveTo(new Uint8Array(32).fill(1));
      kasumiSpy.decryptName.and.rejectWith(new Error('bad mac'));

      const unlock = service.unlockVault('phrase');
      await Promise.resolve();
      httpMock.expectOne(verificationUrl).flush({ vault_verification: 'token' });
      await expectAsync(unlock).toBeRejectedWithError('WRONG_PASSPHRASE');

      expect(service.getVaultKey()).toBe(oldVaultKey);
      expect(Array.from(oldVaultKey)).toEqual(new Array(32).fill(7));
      expect(service.isVaultUnlocked()).toBeTrue();
    });

    it('does not let a failed latest unlock resurrect an older attempt', async () => {
      const masterA = new Uint8Array(32).fill(1);
      const masterB = new Uint8Array(32).fill(2);
      const kdfA = deferred<Uint8Array>();
      kasumiSpy.deriveVaultKey.and.callFake((phrase: string) => phrase === 'a' ? kdfA.promise : Promise.resolve(masterB));
      kasumiSpy.decryptName.and.rejectWith(new Error('bad mac'));

      const unlockA = service.unlockVault('a');
      const unlockB = service.unlockVault('b');
      await Promise.resolve();
      httpMock.expectOne(verificationUrl).flush({ vault_verification: 'b' });
      const resultB = await settle(unlockB);

      kdfA.resolve(masterA);
      await new Promise(resolve => setTimeout(resolve, 0));
      httpMock.match(verificationUrl).forEach(request => request.flush({ vault_verification: 'a' }));
      const resultA = await settle(unlockA);

      expect(resultB.resolved).toBeFalse();
      expect((resultB.error as Error).message).toBe('WRONG_PASSPHRASE');
      expect(resultA.resolved).toBeFalse();
      expect((resultA.error as Error).message).toBe('UNLOCK_CANCELLED');
      expect(masterA).toEqual(new Uint8Array(32));
      expect(masterB).toEqual(new Uint8Array(32));
      expect(service.getVaultKey()).toBeNull();
      expect(service.isVaultUnlocked()).toBeFalse();
    });

    it('wipes the transient Master Key on verification, missing-value and decrypt failures', async () => {
      for (const failure of ['network', 'missing', 'decrypt'] as const) {
        service.lockVault();
        const masterKey = new Uint8Array(32).fill(1);
        kasumiSpy.deriveVaultKey.and.resolveTo(masterKey);
        kasumiSpy.decryptName.and.rejectWith(new Error('bad mac'));
        const unlock = service.unlockVault('phrase');
        await Promise.resolve();
        const request = httpMock.expectOne(verificationUrl);
        if (failure === 'network') request.error(new ProgressEvent('error'));
        else if (failure === 'missing') request.flush({});
        else request.flush({ vault_verification: 'token' });

        const result = await settle(unlock);
        expect(result.resolved).toBeFalse();
        expect(masterKey).toEqual(new Uint8Array(32));
        expect(service.getVaultKey()).toBeNull();
        expect(service.isVaultUnlocked()).toBeFalse();
      }
    });
  });
});
