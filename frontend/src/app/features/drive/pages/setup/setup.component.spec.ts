import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { SetupComponent } from './setup.component';
import { CryptoService } from '../../../../core/crypto/crypto.service';
import { AppStateService } from '../../../../core/state/app-state.service';
import { AuthService } from '../../../../core/auth/auth.service';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';

describe('SetupComponent', () => {
  let component: SetupComponent;
  let fixture: any;
  let cryptoSpy: any;
  let appStateSpy: any;
  let authSpy: any;
  let routerSpy: any;
  let anchorClickSpy: jasmine.Spy;

  beforeEach(() => {
    cryptoSpy = jasmine.createSpyObj('CryptoService', ['initializeVault']);
    appStateSpy = jasmine.createSpyObj('AppStateService', ['unlock']);
    authSpy = jasmine.createSpyObj('AuthService', ['restoreSession']);
    routerSpy = jasmine.createSpyObj('Router', ['navigate']);

    TestBed.configureTestingModule({
      imports: [SetupComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: CryptoService, useValue: cryptoSpy },
        { provide: AppStateService, useValue: appStateSpy },
        { provide: AuthService, useValue: authSpy },
        { provide: Router, useValue: routerSpy }
      ]
    });

    fixture = TestBed.createComponent(SetupComponent);
    component = fixture.componentInstance;
    anchorClickSpy = spyOn(HTMLAnchorElement.prototype, 'click').and.stub();
  });

  describe('onSubmit', () => {
    it('should set error if phrases do not match', async () => {
      component.phrase = '12345678';
      component.confirmPhrase = '87654321';
      
      await component.onSubmit();
      
      expect(component.error()).toBe('As frases não coincidem.');
      expect(cryptoSpy.initializeVault).not.toHaveBeenCalled();
    });

    it('should set error if phrase is less than 8 chars', async () => {
      component.phrase = '1234567';
      component.confirmPhrase = '1234567';
      
      await component.onSubmit();
      
      expect(component.error()).toBe('A frase deve ter pelo menos 8 caracteres.');
      expect(cryptoSpy.initializeVault).not.toHaveBeenCalled();
    });

    it('should initialize vault, restore session, download file and navigate to /drive/home', async () => {
      component.phrase = '12345678';
      component.confirmPhrase = '12345678';
      cryptoSpy.initializeVault.and.returnValue(Promise.resolve());
      authSpy.restoreSession.and.returnValue(of({}));
      const createElementSpy = spyOn(document, 'createElement').and.callThrough();
      spyOn(window.URL, 'createObjectURL').and.returnValue('blob-url');
      spyOn(window.URL, 'revokeObjectURL');

      await component.onSubmit();

      expect(cryptoSpy.initializeVault).toHaveBeenCalledWith('12345678');
      expect(authSpy.restoreSession).toHaveBeenCalled();
      expect(appStateSpy.unlock).toHaveBeenCalled();
      expect(routerSpy.navigate).toHaveBeenCalledWith(['/drive/home']);
      expect(component.phrase).toBe('');
      expect(component.confirmPhrase).toBe('');
      expect((component as any).committedPhrase).toBe('');

      expect(document.createElement).toHaveBeenCalledWith('a');
      const anchor = createElementSpy.calls.mostRecent().returnValue as HTMLAnchorElement;
      expect(anchor.download).toBe('nanika-recovery.txt');
      expect(anchor.href).toBe(new URL('blob-url', document.baseURI).href);
      expect(anchorClickSpy).toHaveBeenCalled();
      expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob-url');
    });

    it('should ignore restoreSession error and continue', async () => {
      component.phrase = '12345678';
      component.confirmPhrase = '12345678';
      cryptoSpy.initializeVault.and.returnValue(Promise.resolve());
      authSpy.restoreSession.and.returnValue(throwError(() => new Error('Refresh failed')));
      spyOn(window.URL, 'createObjectURL').and.returnValue('blob-url');
      spyOn(window.URL, 'revokeObjectURL');

      await component.onSubmit();

      expect(appStateSpy.unlock).toHaveBeenCalled();
      expect(routerSpy.navigate).toHaveBeenCalledWith(['/drive/home']);
    });

    it('should catch error from initializeVault and set error', async () => {
      component.phrase = '12345678';
      component.confirmPhrase = '12345678';
      cryptoSpy.initializeVault.and.callFake(() => Promise.reject(new Error('Init failed')));
      
      await component.onSubmit();

      expect(component.error()).toBe('Erro ao inicializar o drive.');
      expect(component.loading()).toBeFalse();
    });

    it('keeps a committed vault when recovery download fails and retries without initialization', async () => {
      component.phrase = '12345678';
      component.confirmPhrase = '12345678';
      cryptoSpy.initializeVault.and.returnValue(Promise.resolve());
      authSpy.restoreSession.and.returnValue(of({}));
      spyOn(window.URL, 'createObjectURL').and.returnValue('blob-url');
      spyOn(window.URL, 'revokeObjectURL');
      anchorClickSpy.and.throwError('download blocked');

      await component.onSubmit();

      expect(cryptoSpy.initializeVault).toHaveBeenCalledOnceWith('12345678');
      expect(component.error()).toBeNull();
      expect(component.warning()).toContain('Não foi possível baixar');
      expect(routerSpy.navigate).not.toHaveBeenCalled();
      expect(component.vaultInitialized()).toBeTrue();

      anchorClickSpy.and.stub();
      await component.retryRecovery();

      expect(cryptoSpy.initializeVault).toHaveBeenCalledTimes(1);
      expect(authSpy.restoreSession).toHaveBeenCalledTimes(1);
      expect(appStateSpy.unlock).toHaveBeenCalledOnceWith();
      expect(routerSpy.navigate).toHaveBeenCalledOnceWith(['/drive/home']);
      expect(component.phrase).toBe('');
      expect(component.confirmPhrase).toBe('');
      expect((component as any).committedPhrase).toBe('');
    });

    it('can continue after a recovery download failure without retrying initialization', async () => {
      component.phrase = '12345678';
      component.confirmPhrase = '12345678';
      cryptoSpy.initializeVault.and.returnValue(Promise.resolve());
      anchorClickSpy.and.throwError('download blocked');

      await component.onSubmit();
      await component.continueWithoutRecovery();

      expect(cryptoSpy.initializeVault).toHaveBeenCalledTimes(1);
      expect(appStateSpy.unlock).toHaveBeenCalledOnceWith();
      expect(routerSpy.navigate).toHaveBeenCalledOnceWith(['/drive/home']);
      expect(component.phrase).toBe('');
      expect(component.confirmPhrase).toBe('');
      expect((component as any).committedPhrase).toBe('');
    });

  });
});
