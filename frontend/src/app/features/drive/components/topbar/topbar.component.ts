import { Component, EventEmitter, Output, inject } from '@angular/core';
import { AppStateService } from '../../../../core/state/app-state.service';
import { AuthService } from '../../../../core/auth/auth.service';

@Component({
  selector: 'app-topbar',
  standalone: true,
  template: `
    <header class="topbar">
      <div class="logo-area">
        <span class="material-symbols-outlined logo-icon">enhanced_encryption</span>
        <span class="logo-text">SaveBox</span>
      </div>

      <div class="search-bar-placeholder">
        <!-- Google Drive has a search bar here. We can add one later. -->
      </div>

      <div class="actions">
        @if (appState.isLocked()) {
          <button class="unlock-btn" (click)="onUnlockClick()">
            <span class="material-symbols-outlined">lock_open</span>
            Desbloquear Cofre
          </button>
        } @else {
          <button class="lock-btn" (click)="lockVault()" title="Trancar Cofre">
            <span class="material-symbols-outlined">lock</span>
          </button>
        }

        <button class="avatar-btn" (click)="logout()" title="Sair">
          @if (appState.user()?.picture) {
            <img [src]="appState.user()?.picture" alt="Avatar" class="avatar-img" />
          } @else {
            <div class="avatar-fallback">{{ appState.user()?.name?.charAt(0) || 'U' }}</div>
          }
        </button>
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
        background-color: #ffffff;
        border-bottom: 1px solid #dadce0;
        box-sizing: border-box;
      }
      .logo-area {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 238px; /* aligns with standard sidebar width */
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
      .search-bar-placeholder {
        flex: 1;
        max-width: 720px;
        /* Placeholder for future search bar */
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
    `,
  ],
})
export class TopbarComponent {
  protected readonly appState = inject(AppStateService);
  private readonly authService = inject(AuthService);

  @Output() unlockRequested = new EventEmitter<void>();

  onUnlockClick() {
    this.unlockRequested.emit();
  }

  lockVault() {
    this.appState.lock();
  }

  logout() {
    this.authService.logout();
  }
}
