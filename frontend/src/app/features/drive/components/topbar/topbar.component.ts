import { Component, EventEmitter, Output, inject, signal } from '@angular/core';
import { AppStateService } from '../../../../core/state/app-state.service';
import { AuthService } from '../../../../core/auth/auth.service';
import { DriveStore } from '../../state/drive.store';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-topbar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <header class="topbar">
      <div class="left-section">
        <div class="logo-area">
          <span class="material-symbols-outlined logo-icon">enhanced_encryption</span>
          <span class="logo-text">SaveBox</span>
        </div>

        <div class="search-bar">
          <span class="material-symbols-outlined search-icon">search</span>
          <input type="text" placeholder="Pesquisar no Drive" class="search-input" />
        </div>
      </div>

      <div class="actions">
        @if (appState.isLocked()) {
          <button class="unlock-btn" (click)="onUnlockClick()">
            <span class="material-symbols-outlined">lock_open</span>
            Desbloquear Drive
          </button>
        } @else {
          <button class="lock-btn" (click)="lockVault()" title="Trancar Drive">
            <span class="material-symbols-outlined">lock</span>
          </button>
        }

        <div class="avatar-container">
          <button class="avatar-btn" (click)="toggleProfileMenu()">
            @if (appState.user()?.picture) {
              <img [src]="appState.user()?.picture" alt="Avatar" class="avatar-img" />
            } @else {
              <div class="avatar-fallback">{{ appState.user()?.name?.charAt(0) || 'U' }}</div>
            }
          </button>

          @if (isProfileMenuOpen()) {
            <div class="profile-dropdown">
              <div class="profile-header">
                <div class="profile-email">{{ appState.user()?.email || 'user@example.com' }}</div>
              </div>
              <div class="profile-quota-section">
                <div class="quota-header">
                  <span class="material-symbols-outlined quota-icon">cloud</span>
                  <span class="quota-text">Armazenamento</span>
                </div>
                <progress class="quota-progress-bar" [value]="driveStore.quota().usedBytes" [max]="driveStore.quota().maxBytes || 1"></progress>
                <div class="quota-text-sub">{{ getQuotaPercent() }}% utilizado</div>
              </div>
              <div class="dropdown-divider"></div>
              <button class="dropdown-item">Configurações</button>
              <button class="dropdown-item" (click)="logout()">Sair</button>
            </div>
          }
        </div>
      </div>
    </header>
  `,
  styles: [
    `
      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 16px;
        height: 64px;
        background-color: #f8f9fa;
        border-bottom: none;
        box-sizing: border-box;
      }
      .left-section {
        display: flex;
        align-items: center;
        gap: 60px;
        flex: 1;
      }
      .logo-area {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 178px;
      }
      .logo-icon {
        font-size: 28px;
        color: #5f6368;
      }
      .logo-text {
        font-size: 22px;
        color: #3c4043;
        font-weight: 400;
      }
      .search-bar {
        flex: 1;
        max-width: 720px;
        height: 48px;
        background: #e9eef6;
        border-radius: 24px;
        display: flex;
        align-items: center;
        padding: 0 16px;
        gap: 12px;
        transition: background 0.2s, box-shadow 0.2s;
      }
      .search-bar:focus-within {
        background: #ffffff;
        box-shadow: 0 1px 2px 0 rgba(60, 64, 67, 0.3), 0 1px 3px 1px rgba(60, 64, 67, 0.15);
      }
      .search-icon {
        color: #444746;
      }
      .search-input {
        flex: 1;
        border: none;
        background: transparent;
        font-size: 16px;
        color: #1f1f1f;
        outline: none;
      }
      .search-input::placeholder {
        color: #444746;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 16px;
      }
      .unlock-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        background: #d93025; /* Red warning color to stand out */
        color: white;
        border: none;
        border-radius: 4px;
        padding: 8px 16px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.2s;
      }
      .unlock-btn:hover {
        background: #b31412;
      }
      .lock-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        color: #5f6368;
        border: none;
        border-radius: 50%;
        width: 40px;
        height: 40px;
        cursor: pointer;
        transition: background 0.2s;
      }
      .lock-btn:hover {
        background: #f1f3f4;
      }
      .avatar-btn {
        background: none;
        border: none;
        padding: 4px;
        cursor: pointer;
        border-radius: 50%;
      }
      .avatar-img {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        object-fit: cover;
      }
      .avatar-fallback {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: #1a73e8;
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 500;
        font-size: 16px;
      }
      .avatar-container {
        position: relative;
      }
      .profile-dropdown {
        position: absolute;
        right: 0;
        top: 100%;
        margin-top: 8px;
        background: #ffffff;
        border: 1px solid #dadce0;
        border-radius: 16px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1), 0 1px 3px rgba(0,0,0,0.08);
        min-width: 280px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        z-index: 100;
        padding: 8px 0;
      }
      .profile-header {
        padding: 16px 20px;
        text-align: center;
      }
      .profile-email {
        font-size: 14px;
        color: #5f6368;
      }
      .profile-quota-section {
        padding: 16px 20px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        background: #f8f9fa;
        margin: 0 12px;
        border-radius: 12px;
      }
      .quota-header {
        display: flex;
        align-items: center;
        gap: 8px;
        color: #202124;
      }
      .quota-icon {
        font-size: 20px;
        color: #5f6368;
      }
      .quota-text {
        font-size: 14px;
        font-weight: 500;
      }
      .quota-progress-bar {
        width: 100%;
        height: 8px;
        border-radius: 4px;
        appearance: none;
        -webkit-appearance: none;
      }
      .quota-progress-bar::-webkit-progress-bar {
        background-color: #e0e0e0;
        border-radius: 4px;
      }
      .quota-progress-bar::-webkit-progress-value {
        background-color: #1a73e8;
        border-radius: 4px;
      }
      .quota-text-sub {
        font-size: 12px;
        color: #5f6368;
        text-align: right;
      }
      .dropdown-divider {
        height: 1px;
        background: #e0e0e0;
        margin: 8px 0;
      }
      .dropdown-item {
        padding: 12px 24px;
        border: none;
        background: transparent;
        text-align: left;
        font-size: 14px;
        color: #3c4043;
        cursor: pointer;
        transition: background 0.2s;
        font-weight: 500;
      }
      .dropdown-item:hover {
        background: #f1f3f4;
      }
    `,
  ],
})
export class TopbarComponent {
  protected readonly appState = inject(AppStateService);
  protected readonly driveStore = inject(DriveStore);
  private readonly authService = inject(AuthService);

  isProfileMenuOpen = signal(false);

  @Output() unlockRequested = new EventEmitter<void>();

  toggleProfileMenu() {
    this.isProfileMenuOpen.set(!this.isProfileMenuOpen());
  }

  onUnlockClick() {
    this.unlockRequested.emit();
  }

  lockVault() {
    this.appState.lock();
  }

  logout() {
    this.authService.logout();
  }

  getQuotaPercent(): string {
    const q = this.driveStore.quota();
    if (!q || q.maxBytes === 0) return '0';
    return ((q.usedBytes / q.maxBytes) * 100).toFixed(1);
  }
}
