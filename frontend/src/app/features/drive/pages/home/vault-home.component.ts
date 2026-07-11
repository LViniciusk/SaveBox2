import { Component, inject, computed, signal, OnInit, effect, HostListener } from '@angular/core';
import { AppStateService, AppStatus } from '../../../../core/state/app-state.service';
import { AuthService } from '../../../../core/auth/auth.service';
import { CryptoService } from '../../../../core/crypto/crypto.service';
import { DriveStore } from '../../state/drive.store';
import { FileListComponent } from '../../components/file-list/file-list.component';
import { TopbarComponent } from '../../components/topbar/topbar.component';
import { UnlockModalComponent } from '../../components/unlock-modal/unlock-modal.component';
import { CommonModule } from '@angular/common';

/**
 * Main vault page — Google Drive clone layout.
 *
 * Structure:
 * ┌─────────────────────────────────────────────────┐
 * │  Topbar: Logo | Search Bar | Avatar             │
 * ├──────────┬──────────────────────────────────────┤
 * │ Sidebar  │  Content Area                        │
 * │ [+ Novo] │  Breadcrumb: Meu Drive               │
 * │ Meu Drive│  ┌──────────────────────────────┐    │
 * │ Comparti.│  │  File List (with obfuscation) │    │
 * │ Recentes │  │  + Lock Overlay when Locked   │    │
 * │ Lixeira  │  └──────────────────────────────┘    │
 * │          │                                      │
 * │ Storage  │                                      │
 * └──────────┴──────────────────────────────────────┘
 */
@Component({
  selector: 'app-vault-home',
  standalone: true,
  imports: [FileListComponent, TopbarComponent, UnlockModalComponent, CommonModule],
  template: `
    <div class="vault-layout">
      <!-- ===== TOPBAR ===== -->
      <app-topbar (unlockRequested)="isUnlockModalOpen.set(true)" style="grid-area: topbar; z-index: 10;" />

      <!-- ===== SIDEBAR ===== -->
      <nav class="sidebar">
        <div class="new-dropdown-container">
          <button class="new-btn" id="new-btn" (click)="toggleNewMenu()" [disabled]="appState.isLocked()">
            <span class="material-symbols-outlined">add</span>
            Novo
          </button>
          
          @if (isNewMenuOpen()) {
            <div class="new-dropdown">
              <button class="dropdown-item" (click)="createNewFolder()">
                <span class="material-symbols-outlined">create_new_folder</span>
                Nova pasta
              </button>
              <div class="dropdown-divider"></div>
              <button class="dropdown-item" (click)="fileInput.click()">
                <span class="material-symbols-outlined">upload_file</span>
                Upload de ficheiro
              </button>
            </div>
          }
          <input type="file" #fileInput style="display: none" (change)="onFileSelected($event)" />
        </div>

        <div class="nav-group">
          <button class="nav-item" [class.active]="currentView() === 'drive'" (click)="currentView.set('drive'); driveStore.navigateTo(null)" id="nav-my-vault">
            <span class="material-symbols-outlined">folder</span>
            Meu Drive
          </button>
          <button class="nav-item" id="nav-shared">
            <span class="material-symbols-outlined">group</span>
            Compartilhados
          </button>
          <button class="nav-item" id="nav-recent">
            <span class="material-symbols-outlined">schedule</span>
            Recentes
          </button>
          <button class="nav-item" [class.active]="currentView() === 'trash'" (click)="currentView.set('trash'); driveStore.loadTrash()" id="nav-trash">
            <span class="material-symbols-outlined">delete</span>
            Lixeira
          </button>
          <button class="nav-item" [class.active]="currentView() === 'storage'" (click)="currentView.set('storage')">
            <span class="material-symbols-outlined">cloud</span>
            Armazenamento
          </button>
        </div>

        <div class="sidebar-divider"></div>

        <!-- Storage Usage Details -->
        <div class="storage-quota-container">
          <div class="storage-bar-track">
            <div class="storage-bar-fill" [style.width.%]="getQuotaPercent()"></div>
          </div>
          <span class="storage-used">{{ getQuotaFormatted() }}</span>
        </div>
      </nav>

      <!-- ===== CONTENT AREA ===== -->
      <main class="content-area">
        <div class="content-inner">
          <!-- Breadcrumb -->
          <div class="breadcrumb">
            <span class="material-symbols-outlined breadcrumb-icon">
              {{ currentView() === 'drive' ? (driveStore.currentFolderId() ? 'folder_open' : 'folder') : (currentView() === 'trash' ? 'delete' : 'cloud') }}
            </span>
            @if (currentView() === 'drive') {
              <div class="breadcrumb-path">
                @for (segment of driveStore.currentPath(); track segment.id; let last = $last) {
                  <button 
                    class="breadcrumb-link" 
                    (click)="driveStore.navigateTo(segment.id)"
                    [disabled]="last">
                    {{ segment.name }}
                  </button>
                  @if (!last) {
                    <span class="breadcrumb-separator">/</span>
                  }
                }
              </div>
            } @else if (currentView() === 'storage') {
              <span class="breadcrumb-text">Armazenamento</span>
            } @else if (currentView() === 'trash') {
              <span class="breadcrumb-text">Lixeira</span>
            }
          </div>

          <!-- Empty Trash Banner -->
          @if (currentView() === 'trash' && driveStore.trashFiles().length > 0) {
            <div class="trash-banner">
              <span class="trash-banner-text">Os itens da lixeira serão excluídos definitivamente após 30 dias</span>
              <button class="empty-trash-btn" (click)="onEmptyTrash()">
                Esvaziar lixeira
              </button>
            </div>
          }

          <!-- File List -->
          @if (currentView() === 'trash') {
            <app-file-list [files]="driveStore.currentTrashFolderFiles()" [viewMode]="'trash'" [quota]="driveStore.quota()" />
          } @else {
            <app-file-list [files]="driveStore.currentFolderFiles()" [viewMode]="currentView()" [quota]="driveStore.quota()" />
          }

          <!-- Upload Progress -->
          @if (driveStore.isUploading()) {
            <div class="upload-progress-container">
              <div class="upload-header">
                <span>Fazendo upload...</span>
                <span>{{ driveStore.uploadProgress() }}%</span>
              </div>
              <progress class="quota-progress-bar upload-progress-bar" [value]="driveStore.uploadProgress()" max="100"></progress>
            </div>
          }

          <!-- Unlock Modal (visible when unlocked requested) -->
          @if (isUnlockModalOpen()) {
            <app-unlock-modal (modalClosed)="isUnlockModalOpen.set(false)" />
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
        background: #F8FAFD;
      }

      /* Topbar is now a separate component but occupies the same grid area */

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
        border-radius: 16px;
        box-shadow: 0 1px 2px 0 rgba(60, 64, 67, 0.3), 0 1px 3px 1px rgba(60, 64, 67, 0.15);
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
        box-shadow: 0 1px 3px 0 rgba(60, 64, 67, 0.3), 0 4px 8px 3px rgba(60, 64, 67, 0.15);
        background: #fdfdfd;
      }

      .new-btn .material-symbols-outlined {
        font-size: 26px;
        color: #1a73e8;
      }
      .new-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .new-dropdown-container {
        position: relative;
        margin-bottom: 16px;
      }

      .new-dropdown {
        position: absolute;
        top: 100%;
        left: 0;
        margin-top: 4px;
        background: #ffffff;
        border: 1px solid #dadce0;
        border-radius: 8px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1), 0 1px 3px rgba(0,0,0,0.08);
        min-width: 200px;
        display: flex;
        flex-direction: column;
        padding: 8px 0;
        z-index: 100;
        animation: fadeIn 0.2s ease;
      }

      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .dropdown-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 16px;
        border: none;
        background: transparent;
        text-align: left;
        font-size: 14px;
        color: #3c4043;
        cursor: pointer;
        transition: background 0.2s;
        font-family: 'Roboto', sans-serif;
      }

      .dropdown-item:hover {
        background: #f1f3f4;
      }

      .dropdown-item .material-symbols-outlined {
        font-size: 20px;
        color: #5f6368;
      }

      .dropdown-divider {
        height: 1px;
        background: #e0e0e0;
        margin: 4px 0;
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
        padding: 8px 16px;
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
        background: #c2e7ff;
        color: #001d35;
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

      /* Storage Quota Container */
      .storage-quota-container {
        padding: 8px 24px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        box-sizing: border-box;
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
        font-size: 13px;
        color: #5f6368;
        font-weight: 500;
        font-family: 'Roboto', sans-serif;
      }

      /* === CONTENT AREA === */
      .content-area {
        grid-area: content;
        padding: 8px 16px 16px 0;
        overflow-y: hidden;
      }

      .content-inner {
        background: #ffffff;
        border-radius: 16px;
        height: 100%;
        position: relative;
        overflow-y: auto;
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

      .breadcrumb-path {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 18px;
        font-family: 'Roboto', sans-serif;
      }

      .breadcrumb-link {
        background: transparent;
        border: none;
        padding: 0;
        font-size: 18px;
        font-weight: 400;
        color: #1a73e8;
        cursor: pointer;
        transition: color 0.15s ease;
      }

      .breadcrumb-link:hover:not(:disabled) {
        color: #1557b0;
        text-decoration: underline;
      }

      .breadcrumb-link:disabled {
        color: #202124;
        cursor: default;
        text-decoration: none;
      }

      .breadcrumb-separator {
        color: #5f6368;
        user-select: none;
      }

      /* Upload Progress */
      .upload-progress-container {
        position: absolute;
        bottom: 24px;
        right: 24px;
        background: white;
        border-radius: 8px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1), 0 1px 3px rgba(0,0,0,0.08);
        padding: 16px;
        width: 320px;
        z-index: 50;
        border: 1px solid #dadce0;
      }

      .upload-header {
        display: flex;
        justify-content: space-between;
        margin-bottom: 8px;
        font-size: 14px;
        color: #202124;
        font-weight: 500;
      }

      .upload-progress-bar {
        width: 100%;
        height: 6px;
        border-radius: 3px;
        appearance: none;
        -webkit-appearance: none;
      }
      .upload-progress-bar::-webkit-progress-bar {
        background-color: #e0e0e0;
        border-radius: 3px;
      }
      .upload-progress-bar::-webkit-progress-value {
        background-color: #1a73e8;
        border-radius: 3px;
        transition: width 0.2s ease;
      }

      .trash-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: #edf2fa;
        border: none;
        border-radius: 12px;
        padding: 14px 24px;
        margin: 0 24px 16px;
        box-sizing: border-box;
      }

      .trash-banner-text {
        font-size: 14px;
        color: #3c4043;
        font-family: 'Roboto', sans-serif;
      }

      .empty-trash-btn {
        background: #EDF2FA;
        border: none;
        border-radius: 20px;
        padding: 8px 20px;
        font-size: 14px;
        font-weight: 500;
        color: #0b57d0;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 150ms;
        font-family: 'Roboto', sans-serif;
      }

      .empty-trash-btn:hover {
        background: #d3e3fd;
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
export class VaultHomeComponent implements OnInit {
  protected readonly appState = inject(AppStateService);
  protected readonly authService = inject(AuthService);
  protected readonly cryptoService = inject(CryptoService);
  protected readonly driveStore = inject(DriveStore);
  protected readonly AppStatus = AppStatus;

  readonly isUnlockModalOpen = signal(false);
  readonly currentView = signal<'drive' | 'storage' | 'trash'>('drive');

  constructor() {
    effect(() => {
      if (this.cryptoService.isVaultUnlocked()) {
        this.driveStore.reDecryptAll();
      }
    });
  }

  ngOnInit() {
    this.driveStore.loadQuota();
    this.driveStore.loadTree();
  }

  getQuotaPercent(): number {
    const q = this.driveStore.quota();
    if (!q || q.maxBytes === 0) return 0;
    return (q.usedBytes / q.maxBytes) * 100;
  }

  getQuotaFormatted(): string {
    const q = this.driveStore.quota();
    if (!q) return '0 B usados';
    return `${this.formatSize(q.usedBytes)} de ${this.formatSize(q.maxBytes)} usados`;
  }

  private formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Computes the first letter of the user's name for the avatar.
   */
  readonly userInitial = computed(() => {
    const user = this.appState.user();
    if (user?.name) return user.name.charAt(0).toUpperCase();
    if (user?.email) return user.email.charAt(0).toUpperCase();
    return 'U';
  });

  readonly isNewMenuOpen = signal(false);

  toggleNewMenu() {
    this.isNewMenuOpen.set(!this.isNewMenuOpen());
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const isClickInside = target.closest('.new-dropdown-container');
    if (!isClickInside) {
      this.isNewMenuOpen.set(false);
    }
  }

  async createNewFolder() {
    this.isNewMenuOpen.set(false);
    if (this.appState.isLocked()) return;

    const name = prompt('Nome da nova pasta:');
    if (!name) return;

    try {
      await this.driveStore.createFolder(name);
    } catch (e: any) {
      console.error(e);
      if (e?.status === 409) {
        alert('Uma pasta com este nome já existe nesta localização.');
      } else {
        alert('Erro ao criar pasta');
      }
    }
  }

  async onFileSelected(event: Event) {
    this.isNewMenuOpen.set(false);
    if (this.appState.isLocked()) return;

    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];

    try {
      await this.driveStore.uploadFile(file);
    } catch (e) {
      console.error(e);
      alert('Erro no upload');
    }

    // Reset file input
    input.value = '';
  }

  async onEmptyTrash() {
    const confirmed = confirm('Tem certeza de que deseja esvaziar a lixeira? Todos os itens serão excluídos permanentemente.');
    if (!confirmed) return;
    try {
      await this.driveStore.emptyTrash();
    } catch (e) {
      alert('Erro ao esvaziar a lixeira');
    }
  }

  onLogout(): void {
    this.authService.logout();
  }
}
