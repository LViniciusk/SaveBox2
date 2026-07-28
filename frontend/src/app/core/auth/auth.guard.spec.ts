import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Router } from '@angular/router';
import { AppStateService, AppStatus } from '../state/app-state.service';
import { authGuard } from './auth.guard';

describe('authGuard', () => {
  let routerSpy: jasmine.SpyObj<Router>;
  let appStateSpy: any;

  beforeEach(() => {
    routerSpy = jasmine.createSpyObj('Router', ['navigate']);
    appStateSpy = {
      status: jasmine.createSpy('status')
    };

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: Router, useValue: routerSpy },
        { provide: AppStateService, useValue: appStateSpy }
      ]
    });
  });

  const runGuard = (url: string) => {
    return TestBed.runInInjectionContext(() => authGuard({} as any, { url } as any));
  };

  it('should navigate to /login and return false if status is Unauthenticated', () => {
    appStateSpy.status.and.returnValue(AppStatus.Unauthenticated);
    const result = runGuard('/some/url');
    expect(result).toBeFalse();
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/login']);
  });

  it('should navigate to /drive/setup if status is Onboarding and url is not /drive/setup', () => {
    appStateSpy.status.and.returnValue(AppStatus.Onboarding);
    const result = runGuard('/some/url');
    expect(result).toBeFalse();
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/drive/setup']);
  });

  it('should return true if status is Onboarding and url is /drive/setup', () => {
    appStateSpy.status.and.returnValue(AppStatus.Onboarding);
    const result = runGuard('/drive/setup');
    expect(result).toBeTrue();
    expect(routerSpy.navigate).not.toHaveBeenCalled();
  });

  it('should navigate to /drive/home if status is Locked and url is /drive/setup', () => {
    appStateSpy.status.and.returnValue(AppStatus.Locked);
    const result = runGuard('/drive/setup');
    expect(result).toBeFalse();
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/drive/home']);
  });

  it('should return true if status is Locked and url is NOT /drive/setup', () => {
    appStateSpy.status.and.returnValue(AppStatus.Locked);
    const result = runGuard('/drive/home');
    expect(result).toBeTrue();
    expect(routerSpy.navigate).not.toHaveBeenCalled();
  });

  it('should navigate to /drive/home if status is Unlocked and url is /drive/setup', () => {
    appStateSpy.status.and.returnValue(AppStatus.Unlocked);
    const result = runGuard('/drive/setup');
    expect(result).toBeFalse();
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/drive/home']);
  });

  it('should return true if status is Unlocked and url is NOT /drive/setup', () => {
    appStateSpy.status.and.returnValue(AppStatus.Unlocked);
    const result = runGuard('/drive/home');
    expect(result).toBeTrue();
    expect(routerSpy.navigate).not.toHaveBeenCalled();
  });
});
