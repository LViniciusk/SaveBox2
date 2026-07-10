import { Component, inject, computed } from '@angular/core';
import { AppStateService, AppStatus } from '../../../../core/state/app-state.service';
import { AuthService } from '../../../../core/auth/auth.service';
import { DriveStore } from '../../state/drive.store';
import { FileListComponent } from '../../components/file-list/file-list.component';
import { LockOverlayComponent } from '../../../../shared/ui/lock-overlay/lock-overlay.component';
import { UnlockModalComponent } from '../../components/unlock-modal/unlock-modal.component';

/**
 * Main vault page — Google Drive clone layout.
 *
 * Structure:
 * ┌─────────────────────────────────────────────────┐
 * │  Topbar: Logo | Search Bar | Avatar             │
 * ├──────────┬──────────────────────────────────────┤
 * │ Sidebar  │  Content Area                        │
 * │ [+ Novo] │  Breadcrumb: Meu Cofre               │
 * │ Meu Cofre│  ┌──────────────────────────────┐    │
 * │ Comparti.│  │  File List (with obfuscation) │    │
 * │ Recentes │  │  + Lock Overlay when Locked   │    │
 * │ Lixeira  │  └──────────────────────────────┘    │
 * │          │                                      │
 * │ Storage  │                                      │
 * └──────────┴──────────────────────────────────────┘
 */
@Component({
  selector: 'app-vault-home',
  imports: [FileListComponent, LockOverlayComponent, UnlockModalComponent],
  template: `
    <div class="vault-layout">
      <!-- ===== TOPBAR ===== -->
      <header class="topbar">
        <div class="topbar-logo">
          <span class="material-symbols-outlined logo-icon">
            enhanced_encryption
          </span>
          <h2 class="logo-text">SaveBox</h2>
        </div>

        <div class="search-bar">
          <span class="material-symbols-outlined">search</span>
          <input
            type="text"
            placeholder="Pesquisar no Cofre"
            id="search-input"
          />
        </div>

        <div class="topbar-actions">
          <button class="icon-btn" title="Configurações" id="settings-btn">
            <span class="material-symbols-outlined">settings</span>
          </button>
          <button class="icon-btn" title="Ajuda" id="help-btn">
            <span class="material-symbols-outlined">help_outline</span>
          </button>
          <button
            class="avatar-btn"
            (click)="onLogout()"
            title="Sair da conta"
            id="avatar-btn"
          >
            {{ userInitial() }}
          </button>
        </div>
      </header>

      <!-- ===== SIDEBAR ===== -->
      <nav class="sidebar">
        <button class="new-btn" id="new-btn">
          <span class="material-symbols-outlined">add</span>
          Novo
        </button>

        <div class="nav-group">
          <button class="nav-item active" id="nav-my-vault">
            <span class="material-symbols-outlined">folder</span>
            Meu Cofre
          </button>
          <button class="nav-item" id="nav-shared">
            <span class="material-symbols-outlined">group</span>
            Compartilhados
          </button>
          <button class="nav-item" id="nav-recent">
            <span class="material-symbols-outlined">schedule</span>
            Recentes
          </button>
          <button class="nav-item" id="nav-trash">
            <span class="material-symbols-outlined">delete</span>
            Lixeira
          </button>
        </div>

        <div class="sidebar-divider"></div>

        <!-- Storage Usage -->
        <div class="storage-widget">
          <span class="material-symbols-outlined storage-icon">cloud</span>
          <div class="storage-details">
            <span class="storage-label">Armazenamento</span>
            <div class="storage-bar-track">
              <div class="storage-bar-fill" style="width: 23%"></div>
            </div>
            <span class="storage-used">2,3 GB de 10 GB usados</span>
          </div>
        </div>
      </nav>

      <!-- ===== CONTENT AREA ===== -->
      <main class="content-area">
        <div class="content-inner">
          <!-- Breadcrumb -->
          <div class="breadcrumb">
            <span class="material-symbols-outlined breadcrumb-icon">
              folder
            </span>
            <span class="breadcrumb-text">Meu Cofre</span>
          </div>

          <!-- File List -->
          <app-file-list [files]="driveStore.files()" />

          <!-- Lock Overlay (visible when Locked) -->
          @if (appState.status() === AppStatus.Locked) {
            <app-lock-overlay>
              <app-unlock-modal />
            </app-lock-overlay>
          }
        </div>
      </main>
    </div>
  `,
  styles: [
    `
      /* === HOST === */
      :host {
        display: block;
        height: 100vh;
        overflow: hidden;
      }

      /* === LAYOUT GRID === */
      .vault-layout {
        display: grid;
        grid-template-rows: 64px 1fr;
        grid-template-columns: 256px 1fr;
        grid-template-areas:
          'topbar topbar'
          'sidebar content';
        height: 100%;
        background: #f8f9fa;
      }

      /* === TOPBAR === */
      .topbar {
        grid-area: topbar;
        display: flex;
        align-items: center;
        padding: 0 16px;
        background: white;
        border-bottom: 1px solid #e0e0e0;
        gap: 16px;
        z-index: 10;
      }

      .topbar-logo {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 220px;
        padding-left: 8px;
      }

      .logo-icon {
        font-size: 36px;
        color: #1a73e8;
        font-variation-settings: 'FILL' 1;
      }

      .logo-text {
        font-size: 22px;
        font-weight: 500;
        color: #5f6368;
        letter-spacing: -0.5px;
        margin: 0;
      }

      .search-bar {
        flex: 1;
        max-width: 720px;
        height: 48px;
        display: flex;
        align-items: center;
        background: #f1f3f4;
        border-radius: 24px;
        padding: 0 16px;
        gap: 12px;
        transition:
          background 200ms cubic-bezier(0.4, 0, 0.2, 1),
          box-shadow 200ms cubic-bezier(0.4, 0, 0.2, 1);
      }

      .search-bar:focus-within {
        background: white;
        box-shadow:
          0 1px 3px rgba(60, 64, 67, 0.3),
          0 4px 8px rgba(60, 64, 67, 0.15);
      }

      .search-bar .material-symbols-outlined {
        color: #5f6368;
        font-size: 22px;
      }

      .search-bar input {
        flex: 1;
        border: none;
        background: transparent;
        font-size: 16px;
        font-family: 'Roboto', sans-serif;
        color: #202124;
        outline: none;
      }

      .search-bar input::placeholder {
        color: #5f6368;
      }

      .topbar-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .icon-btn {
        width: 40px;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        border: none;
        background: transparent;
        cursor: pointer;
        color: #5f6368;
        transition: background 150ms ease;
      }

      .icon-btn:hover {
        background: #f1f3f4;
      }

      .avatar-btn {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: #1a73e8;
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        font-weight: 500;
        font-family: 'Roboto', sans-serif;
        cursor: pointer;
        border: none;
        margin-left: 8px;
        transition: box-shadow 200ms ease;
      }

      .avatar-btn:hover {
        box-shadow: 0 1px 3px rgba(60, 64, 67, 0.4);
      }

      /* === SIDEBAR === */
      .sidebar {
        grid-area: sidebar;
        padding: 12px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .new-btn {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 24px;
        background: white;
        border: none;
        border-radius: 28px;
        box-shadow:
          0 1px 2px rgba(60, 64, 67, 0.3),
          0 1px 3px 1px rgba(60, 64, 67, 0.15);
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        font-family: 'Roboto', sans-serif;
        color: #202124;
        margin-bottom: 16px;
        transition:
          box-shadow 250ms cubic-bezier(0.4, 0, 0.2, 1),
          background 150ms ease;
        width: fit-content;
      }

      .new-btn:hover {
        box-shadow:
          0 1px 3px rgba(60, 64, 67, 0.3),
          0 4px 8px 3px rgba(60, 64, 67, 0.15);
        background: #f8f9ff;
      }

      .new-btn .material-symbols-outlined {
        font-size: 26px;
        color: #1a73e8;
      }

      .nav-group {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .nav-item {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 8px 24px;
        border-radius: 24px;
        border: none;
        background: transparent;
        cursor: pointer;
        font-size: 14px;
        font-family: 'Roboto', sans-serif;
        color: #202124;
        width: 100%;
        text-align: left;
        transition: background 150ms ease;
        height: 40px;
      }

      .nav-item:hover {
        background: #e8eaed;
      }

      .nav-item.active {
        background: #e8f0fe;
        color: #1a73e8;
        font-weight: 500;
      }

      .nav-item .material-symbols-outlined {
        font-size: 20px;
        color: inherit;
      }

      .sidebar-divider {
        height: 1px;
        background: #e0e0e0;
        margin: 12px 16px;
      }

      /* Storage Widget */
      .storage-widget {
        display: flex;
        align-items: flex-start;
        gap: 14px;
        padding: 8px 24px;
      }

      .storage-icon {
        font-size: 20px;
        color: #5f6368;
        margin-top: 2px;
      }

      .storage-details {
        display: flex;
        flex-direction: column;
        gap: 6px;
        flex: 1;
      }

      .storage-label {
        font-size: 14px;
        color: #202124;
        font-weight: 400;
      }

      .storage-bar-track {
        width: 100%;
        height: 4px;
        background: #e0e0e0;
        border-radius: 2px;
        overflow: hidden;
      }

      .storage-bar-fill {
        height: 100%;
        background: #1a73e8;
        border-radius: 2px;
        transition: width 500ms cubic-bezier(0.4, 0, 0.2, 1);
      }

      .storage-used {
        font-size: 12px;
        color: #5f6368;
      }

      /* === CONTENT AREA === */
      .content-area {
        grid-area: content;
        padding: 16px 24px 16px 8px;
        overflow-y: auto;
      }

      .content-inner {
        background: white;
        border-radius: 16px;
        min-height: 100%;
        position: relative;
        overflow: hidden;
      }

      .breadcrumb {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 20px 24px 12px;
        font-size: 18px;
        font-weight: 400;
        color: #202124;
      }

      .breadcrumb-icon {
        font-size: 22px;
        color: #5f6368;
        font-variation-settings: 'FILL' 1;
      }

      .breadcrumb-text {
        font-size: 18px;
      }

      /* === RESPONSIVE === */
      @media (max-width: 900px) {
        .vault-layout {
          grid-template-columns: 200px 1fr;
        }

        .topbar-logo {
          min-width: 168px;
        }
      }

      @media (max-width: 680px) {
        .vault-layout {
          grid-template-columns: 1fr;
          grid-template-areas:
            'topbar'
            'content';
        }

        .sidebar {
          display: none;
        }

        .content-area {
          padding: 8px;
        }
      }
    `,
  ],
})
export class VaultHomeComponent {
  protected readonly appState = inject(AppStateService);
  protected readonly authService = inject(AuthService);
  protected readonly driveStore = inject(DriveStore);
  protected readonly AppStatus = AppStatus;

  /**
   * Computes the first letter of the user's name for the avatar.
   */
  readonly userInitial = computed(() => {
    const user = this.appState.user();
    if (user?.name) return user.name.charAt(0).toUpperCase();
    if (user?.email) return user.email.charAt(0).toUpperCase();
    return 'U';
  });

  onLogout(): void {
    this.authService.logout();
  }
}
