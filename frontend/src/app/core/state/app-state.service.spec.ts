import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { AppStateService, AppStatus } from './app-state.service';

describe('AppStateService', () => {
  let service: AppStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), AppStateService]
    });
    service = TestBed.inject(AppStateService);
  });

  describe('AppStatus transitions', () => {
    it('should correctly transition through the authentication lifecycle', () => {
      // Assert Initial State
      expect(service.status()).toBe(AppStatus.Loading);

      // Act: Logout (to Unauthenticated)
      service.logout();
      expect(service.status()).toBe(AppStatus.Unauthenticated);
      expect(service.user()).toBeNull();

      // Act: Login (to Locked, assuming vault initialized)
      const mockUser = { email: 'a@a.com', name: 'A', picture: '' };
      service.login(mockUser, true);
      
      expect(service.status()).toBe(AppStatus.Locked);
      expect(service.user()).toEqual(mockUser);
      expect(service.isAuthenticated()).toBeTrue();
      expect(service.isLocked()).toBeTrue();
      expect(service.isUnlocked()).toBeFalse();

      // Act: Unlock
      service.unlock();
      expect(service.status()).toBe(AppStatus.Unlocked);
      expect(service.isLocked()).toBeFalse();
      expect(service.isUnlocked()).toBeTrue();

      // Act: Lock
      service.lock();
      expect(service.status()).toBe(AppStatus.Locked);

      // Act: Login (to Onboarding, assuming vault NOT initialized)
      service.login(mockUser, false);
      expect(service.status()).toBe(AppStatus.Onboarding);
      expect(service.isOnboarding()).toBeTrue();
    });
  });
});
