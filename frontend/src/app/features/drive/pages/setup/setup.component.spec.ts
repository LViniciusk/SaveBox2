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
      
      const anchorSpy = jasmine.createSpyObj('a', ['click']);
      spyOn(document, 'createElement').and.returnValue(anchorSpy);
      spyOn(window.URL, 'createObjectURL').and.returnValue('blob-url');
      spyOn(window.URL, 'revokeObjectURL');

      await component.onSubmit();

      expect(cryptoSpy.initializeVault).toHaveBeenCalledWith('12345678');
      expect(authSpy.restoreSession).toHaveBeenCalled();
      expect(appStateSpy.unlock).toHaveBeenCalled();
      expect(routerSpy.navigate).toHaveBeenCalledWith(['/drive/home']);
      
      expect(document.createElement).toHaveBeenCalledWith('a');
      expect(anchorSpy.download).toBe('nanika-recovery.txt');
      expect(anchorSpy.href).toBe('blob-url');
      expect(anchorSpy.click).toHaveBeenCalled();
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
  });
});
