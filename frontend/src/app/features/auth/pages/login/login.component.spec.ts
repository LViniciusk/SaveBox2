import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { LoginComponent } from './login.component';
import { AuthService } from '../../../../core/auth/auth.service';
import { AppStateService, AppStatus } from '../../../../core/state/app-state.service';
import { Router, ActivatedRoute } from '@angular/router';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';

describe('LoginComponent', () => {
  let component: LoginComponent;
  let fixture: any;
  let authServiceSpy: any;
  let appStateSpy: any;
  let routerSpy: any;
  let activatedRouteStub: any;
  let mockStatus: any;

  beforeEach(() => {
    mockStatus = signal(AppStatus.Unauthenticated);

    authServiceSpy = jasmine.createSpyObj('AuthService', [
      'loginWithGoogle', 'uploadProfilePic', 'register', 'verifyEmail', 'loginWithCredentials'
    ], {
      error: signal(null),
      loading: signal(false)
    });

    appStateSpy = jasmine.createSpyObj('AppStateService', ['isAuthenticated'], {
      status: mockStatus
    });

    routerSpy = jasmine.createSpyObj('Router', ['navigate']);

    activatedRouteStub = {
      queryParams: of({})
    };

    TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: AuthService, useValue: authServiceSpy },
        { provide: AppStateService, useValue: appStateSpy },
        { provide: Router, useValue: routerSpy },
        { provide: ActivatedRoute, useValue: activatedRouteStub }
      ]
    });

    fixture = TestBed.createComponent(LoginComponent);
    component = fixture.componentInstance;
  });

  it('should redirect to /drive if authenticated', () => {
    appStateSpy.isAuthenticated.and.returnValue(true);
    TestBed.createComponent(LoginComponent);
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/drive']);
  });

  describe('doLogin', () => {
    it('should login and navigate to /drive/setup if onboarding', async () => {
      component.username.set('test');
      component.password.set('pass');
      authServiceSpy.loginWithCredentials.and.returnValue(of({}));
      // Status is Unauthenticated but pretend it becomes Onboarding
      mockStatus.set(AppStatus.Onboarding);
      
      await component.doLogin();
      
      expect(authServiceSpy.loginWithCredentials).toHaveBeenCalledWith('test', 'pass');
      expect(routerSpy.navigate).toHaveBeenCalledWith(['/drive/setup']);
    });

    it('should login and navigate to /drive/home if vault initialized', async () => {
      component.username.set('test');
      component.password.set('pass');
      authServiceSpy.loginWithCredentials.and.returnValue(of({}));
      mockStatus.set(AppStatus.Locked);
      
      await component.doLogin();
      
      expect(routerSpy.navigate).toHaveBeenCalledWith(['/drive/home']);
    });

    it('should show verify view if error 403', async () => {
      component.username.set('test');
      component.password.set('pass');
      authServiceSpy.loginWithCredentials.and.returnValue(throwError(() => ({ status: 403 })));
      
      await component.doLogin();
      
      expect(component.view()).toBe('verify');
      expect(component.localError()).toContain('Conta não verificada');
    });

    it('should show generic error for other failures', async () => {
      component.username.set('test');
      component.password.set('pass');
      authServiceSpy.loginWithCredentials.and.returnValue(throwError(() => ({ error: { error: 'Bad pass' } })));
      
      await component.doLogin();
      
      expect(component.localError()).toBe('Bad pass');
    });
  });

  describe('doRegister', () => {
    it('should register and change view to verify', async () => {
      component.username.set('test');
      component.email.set('t@t.com');
      component.password.set('pass');
      authServiceSpy.register.and.returnValue(of({}));
      
      await component.doRegister();
      
      expect(authServiceSpy.register).toHaveBeenCalledWith('test', 't@t.com', 'pass');
      expect(component.view()).toBe('verify');
    });

    it('should show error on register failure', async () => {
      component.username.set('test');
      component.email.set('t@t.com');
      component.password.set('pass');
      authServiceSpy.register.and.returnValue(throwError(() => ({ error: { error: 'Username taken' } })));
      
      await component.doRegister();
      
      expect(component.localError()).toBe('Username taken');
      expect(component.view()).toBe('register');
    });
  });

  describe('doVerify', () => {
    it('should verify and login if credentials present, then go to avatar', async () => {
      component.verificationCode.set('123456');
      component.username.set('test');
      component.password.set('pass');
      authServiceSpy.verifyEmail.and.returnValue(of({}));
      authServiceSpy.loginWithCredentials.and.returnValue(of({}));
      
      await component.doVerify();
      
      expect(authServiceSpy.verifyEmail).toHaveBeenCalledWith('123456');
      expect(authServiceSpy.loginWithCredentials).toHaveBeenCalledWith('test', 'pass');
      expect(component.view()).toBe('avatar');
    });

    it('should verify and go to login if login fails or missing credentials', async () => {
      component.verificationCode.set('123456');
      component.username.set('');
      authServiceSpy.verifyEmail.and.returnValue(of({}));
      
      await component.doVerify();
      
      expect(component.view()).toBe('login');
      expect(component.localError()).toContain('Conta ativada com sucesso');
    });
    
    it('should show error on verify failure', async () => {
      component.verificationCode.set('123456');
      authServiceSpy.verifyEmail.and.returnValue(throwError(() => ({ error: { error: 'Bad code' } })));
      
      await component.doVerify();
      
      expect(component.localError()).toBe('Bad code');
    });
  });

  describe('finishAvatarUpload', () => {
    it('should navigate if no avatar selected', async () => {
      component.selectedAvatarFile.set(null);
      mockStatus.set(AppStatus.Onboarding);
      
      await component.finishAvatarUpload();
      
      expect(routerSpy.navigate).toHaveBeenCalledWith(['/drive/setup']);
    });

    it('should upload avatar and navigate', async () => {
      const file = new File([''], 'avatar.png', { type: 'image/png' });
      component.selectedAvatarFile.set(file);
      authServiceSpy.uploadProfilePic.and.returnValue(of({}));
      mockStatus.set(AppStatus.Onboarding);
      
      await component.finishAvatarUpload();
      
      expect(authServiceSpy.uploadProfilePic).toHaveBeenCalledWith(file);
      expect(routerSpy.navigate).toHaveBeenCalledWith(['/drive/setup']);
    });

    it('should set error on upload failure', async () => {
      const file = new File([''], 'avatar.png', { type: 'image/png' });
      component.selectedAvatarFile.set(file);
      authServiceSpy.uploadProfilePic.and.returnValue(throwError(() => ({ error: { error: 'Upload failed' } })));
      
      await component.finishAvatarUpload();
      
      expect(component.localError()).toBe('Upload failed');
    });
  });

  describe('Avatar file selection', () => {
    it('should set error if file is too large', () => {
      const file = new File([''], 'avatar.png', { type: 'image/png' });
      Object.defineProperty(file, 'size', { value: 3 * 1024 * 1024 }); // 3MB
      
      component.onAvatarSelected({ target: { files: [file] } });
      
      expect(component.localError()).toBe('A imagem deve ter no máximo 2MB.');
    });
  });
});
