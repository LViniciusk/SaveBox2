import { Injectable, signal, computed } from '@angular/core';

/**
 * The four authentication states of the application.
 * - Loading: Initial state while APP_INITIALIZER restores session.
 * - Unauthenticated: No session, redirects to /login.
 * - Locked: Has JWT session, but the Vault Key is NOT in RAM.
 * - Unlocked: Vault Key decrypted and held in RAM, files visible.
 */
export enum AppStatus {
  Loading = 'loading',
  Unauthenticated = 'unauthenticated',
  Onboarding = 'onboarding',
  Locked = 'locked',
  Unlocked = 'unlocked',
}

export interface UserInfo {
  email: string;
  name: string;
  picture: string;
}

export interface AppState {
  status: AppStatus;
  user: UserInfo | null;
}

/**
 * Central application state managed via Angular Signals.
 *
 * SECURITY: This service holds the authentication state in RAM only.
 * No sensitive data (JWT, Vault Key, passphrase) is persisted to
 * localStorage, sessionStorage, or cookies.
 */
@Injectable({ providedIn: 'root' })
export class AppStateService {
  /** Private writable signal — the single source of truth. */
  private readonly _state = signal<AppState>({
    status: AppStatus.Loading,
    user: null,
  });

  /** Public read-only projections of the state. */
  readonly state = this._state.asReadonly();
  readonly status = computed(() => this._state().status);
  readonly user = computed(() => this._state().user);
  readonly isAuthenticated = computed(
    () => this._state().status !== AppStatus.Unauthenticated && this._state().status !== AppStatus.Loading,
  );
  readonly isOnboarding = computed(
    () => this._state().status === AppStatus.Onboarding,
  );
  readonly isLocked = computed(
    () => this._state().status === AppStatus.Locked,
  );
  readonly isUnlocked = computed(
    () => this._state().status === AppStatus.Unlocked,
  );

  /**
   * Transitions from Unauthenticated → Locked.
   * Called after successful Google Sign-In.
   */
  login(user: UserInfo, isVaultInitialized: boolean): void {
    this._state.set({
      status: isVaultInitialized ? AppStatus.Locked : AppStatus.Onboarding,
      user,
    });
  }

  /**
   * Transitions to Locked (vault key wiped from RAM).
   */
  lock(): void {
    this._state.update((s) => ({
      ...s,
      status: AppStatus.Locked,
    }));
  }

  /**
   * Transitions from Locked → Unlocked (vault key derived and held in RAM).
   */
  unlock(): void {
    this._state.update((s) => ({
      ...s,
      status: AppStatus.Unlocked,
    }));
  }

  /**
   * Transitions to Unauthenticated (full cleanup).
   */
  logout(): void {
    this._state.set({
      status: AppStatus.Unauthenticated,
      user: null,
    });
  }
}
