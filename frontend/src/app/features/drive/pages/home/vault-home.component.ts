import { Component, inject, signal, OnInit, effect, HostListener, ElementRef, ViewChild } from '@angular/core';
import { DialogService } from '../../../../core/dialog/dialog.service';
import { AppStateService, AppStatus } from '../../../../core/state/app-state.service';
import { AuthService } from '../../../../core/auth/auth.service';
import { CryptoService } from '../../../../core/crypto/crypto.service';
import { DriveStore, DriveFile } from '../../state/drive.store';
import { UnlockModalComponent } from '../../components/unlock-modal/unlock-modal.component';
import { VideoPlayerComponent } from '../../components/video-player/video-player.component';
import { ImagePlayerComponent } from '../../components/image-player/image-player.component';
import { ShareModalComponent } from '../../components/share-modal/share-modal.component';
import { GDriveShellComponent } from '../../layouts/gdrive-shell/gdrive-shell.component';
import { DefaultShellComponent } from '../../layouts/default-shell/default-shell.component';
import { ThemeService } from '../../../../core/theme/theme.service';
import { DriveView } from '../../state/drive.types';
import { CommonModule } from '@angular/common';
import { PinnedFoldersStore } from '../../state/pinned-folders.store';
import { DroppedItems } from '../../services/data-transfer-reader.service';

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
  providers: [PinnedFoldersStore],
  imports: [GDriveShellComponent, DefaultShellComponent, UnlockModalComponent, VideoPlayerComponent, ImagePlayerComponent, ShareModalComponent, CommonModule],
  template: `
    @if (themeService.theme() === 'default') {
      <app-default-shell
        [currentView]="currentView()"
        [currentFolderId]="driveStore.currentFolderId()"
        [currentPath]="driveStore.currentPath()"
        [canGoBack]="driveStore.canGoBack()"
        [canGoForward]="driveStore.canGoForward()"
        [canGoUp]="driveStore.canGoUp()"
        [locked]="appState.isLocked()"
        [quota]="driveStore.quota()"
        (viewChange)="onViewChange($event)"
        (createFolderRequested)="createNewFolder()"
        (uploadFileRequested)="openFilePicker()"
        (uploadFolderRequested)="openFolderPicker()"
        (unlockRequested)="isUnlockModalOpen.set(true)"
        (lockRequested)="lockDrive()"
        (backRequested)="driveStore.goBack()"
        (forwardRequested)="driveStore.goForward()"
        (upRequested)="driveStore.navigateUp()"
        (addressNavigate)="onAddressNavigate($event)"
        (dropStarted)="onDropStarted()"
        (externalDrop)="onDropped($event)"
        (dropError)="onDropError($event)"
        (videoSelected)="activeVideoFile.set($event)"
        (imageSelected)="onImageSelected($event)"
        (shareRequested)="onShareRequested($event)"
        (pinnedFolderNavigate)="onPinnedFolderNavigate($event)"
        (emptyTrashRequested)="onEmptyTrash()">
        <ng-container *ngTemplateOutlet="shellContent"></ng-container>
      </app-default-shell>
    } @else {
      <app-gdrive-shell
        [currentView]="currentView()"
        [currentFolderId]="driveStore.currentFolderId()"
        [locked]="appState.isLocked()"
        [quota]="driveStore.quota()"
        (viewChange)="onViewChange($event)"
        (createFolderRequested)="createNewFolder()"
        (uploadFileRequested)="openFilePicker()"
        (uploadFolderRequested)="openFolderPicker()"
        (unlockRequested)="isUnlockModalOpen.set(true)"
        (dropStarted)="onDropStarted()"
        (externalDrop)="onDropped($event)"
        (dropError)="onDropError($event)"
        (videoSelected)="activeVideoFile.set($event)"
        (imageSelected)="onImageSelected($event)"
        (shareRequested)="onShareRequested($event)"
        (pinnedFolderNavigate)="onPinnedFolderNavigate($event)"
        (emptyTrashRequested)="onEmptyTrash()">
        <ng-container *ngTemplateOutlet="shellContent"></ng-container>
      </app-gdrive-shell>
    }

    <ng-template #shellContent>
      <input type="file" #fileInput multiple style="display: none" (change)="onFilesSelected($event)" />
      <input type="file" #folderInput multiple webkitdirectory directory style="display: none" (change)="onFolderSelected($event)" />
      
                <!-- Unlock Modal (visible when unlocked requested) -->
                @if (isUnlockModalOpen()) {
                  <app-unlock-modal (modalClosed)="isUnlockModalOpen.set(false)" />
                }
      
                <!-- Dialog (Prompt / Confirm) -->
                @if (dialogService.activeDialog(); as dialog) {
                  <div class="dialog-backdrop" (click)="onDialogCancel(dialog)">
                    <div class="dialog-card" [class.danger-card]="dialog.options.isDanger" (click)="$event.stopPropagation()">
                      <h3 class="dialog-title">{{ dialog.options.title }}</h3>
                      
                      @if (dialog.options.message) {
                        <p class="dialog-message">{{ dialog.options.message }}</p>
                      }
                      
                      @if (dialog.options.showInput) {
                        <div class="dialog-input-wrapper">
                          <input 
                            #dialogInput
                            type="text" 
                            class="dialog-input"
                            [value]="dialogService.dialogValue()" 
                            (input)="dialogService.dialogValue.set(dialogInput.value)"
                            (keydown.enter)="onDialogConfirm(dialog)"
                            (keydown.escape)="onDialogCancel(dialog)"
                            [placeholder]="dialog.options.placeholder || ''"
                            autofocus
                          />
                        </div>
                      }
                      
                      <div class="dialog-actions">
                        <button class="dialog-btn cancel-btn" (click)="onDialogCancel(dialog)">
                          {{ dialog.options.cancelText || 'Cancelar' }}
                        </button>
                        <button 
                          [class]="dialog.options.isDanger ? 'dialog-btn confirm-pill-btn' : 'dialog-btn confirm-btn'" 
                          (click)="onDialogConfirm(dialog)">
                          {{ dialog.options.confirmText }}
                        </button>
                      </div>
                    </div>
                  </div>
                }
      
                <!-- Image Player Modal -->
                @if (activeImageFile()) {
                  <app-image-player [file]="activeImageFile()!" [playlist]="activeImagePlaylist()" [isVideoPlaying]="isVideoReady()" [isVideoLoading]="!!activeVideoFile() && !isVideoReady()" (fileChange)="activeImageFile.set($event)" (close)="activeImageFile.set(null); activeVideoFile.set(null); isVideoReady.set(false)" (closeVideo)="activeVideoFile.set(null); isVideoReady.set(false)" (playVideo)="activeVideoFile.set($event)" (videoReady)="isVideoReady.set(true)" />
                }
      
                <!-- Video Player Modal -->
                @if (activeVideoFile() && !activeImageFile()) {
                  <app-video-player [file]="activeVideoFile()!" (close)="activeVideoFile.set(null); isVideoReady.set(false)" (videoReady)="isVideoReady.set(true)" />
                }
      
                <!-- Share Modal -->
                @if (shareFile()) {
                  <app-share-modal [file]="shareFile()!" (close)="shareFile.set(null)" />
                }
    </ng-template>
  `,
  styles: [
    `
      /* === HOST === */
      :host {
        display: block;
        height: 100vh;
        overflow: hidden;
      }



      /* === CUSTOM DIALOGS === */
      .dialog-backdrop {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(15, 23, 42, 0.32);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 3000;
        animation: dialogFadeIn 150ms ease-out forwards;
      }

      .dialog-card {
        background: #ffffff;
        border-radius: 28px;
        padding: 24px;
        width: 360px;
        max-width: 90%;
        box-shadow: 0 12px 32px 4px rgba(0,0,0,0.1), 0 4px 20px 0 rgba(0,0,0,0.08);
        display: flex;
        flex-direction: column;
        gap: 16px;
        animation: dialogScaleIn 200ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
      }

      .dialog-card.danger-card {
        width: 440px;
      }

      .dialog-title {
        font-size: 22px;
        font-weight: 400;
        color: #1f1f1f;
        margin: 0;
        line-height: 28px;
        font-family: 'Roboto', 'Google Sans', sans-serif;
      }

      .dialog-message {
        font-size: 14px;
        line-height: 20px;
        color: #444746;
        margin: 0;
        font-family: 'Roboto', sans-serif;
      }

      .dialog-input-wrapper {
        width: 100%;
        margin-top: 8px;
        margin-bottom: 8px;
      }

      .dialog-input {
        width: 100%;
        height: 56px;
        padding: 0 16px;
        border: 2px solid #0b57d0;
        border-radius: 4px;
        font-size: 16px;
        color: #1f1f1f;
        outline: none;
        box-sizing: border-box;
        font-family: 'Roboto', sans-serif;
      }

      .dialog-actions {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 8px;
        margin-top: 12px;
      }

      .dialog-btn {
        background: transparent;
        border: none;
        font-size: 14px;
        font-weight: 500;
        padding: 10px 16px;
        cursor: pointer;
        border-radius: 100px;
        font-family: 'Roboto', 'Google Sans', sans-serif;
        transition: background-color 150ms;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .cancel-btn {
        color: #0b57d0;
      }

      .cancel-btn:hover {
        background-color: rgba(11, 87, 208, 0.08);
      }

      .confirm-btn {
        color: #0b57d0;
      }

      .confirm-btn:hover {
        background-color: rgba(11, 87, 208, 0.08);
      }

      .confirm-pill-btn {
        background-color: #b3261e;
        color: #ffffff;
        padding: 10px 24px;
      }

      .confirm-pill-btn:hover {
        background-color: #8c1d18;
      }

      @keyframes dialogFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      @keyframes dialogScaleIn {
        from { transform: scale(0.95); opacity: 0; }
        to { transform: scale(1); opacity: 1; }
      }
    `,
  ],
})
export class VaultHomeComponent implements OnInit {
  private dropTargetFolderId: number | null | undefined;
  @ViewChild('fileInput') private fileInput?: ElementRef<HTMLInputElement>;
  @ViewChild('folderInput') private folderInput?: ElementRef<HTMLInputElement>;
  protected readonly appState = inject(AppStateService);
  protected readonly authService = inject(AuthService);
  protected readonly cryptoService = inject(CryptoService);
  protected readonly driveStore = inject(DriveStore);
  protected readonly themeService = inject(ThemeService);
  protected readonly pinnedFoldersStore = inject(PinnedFoldersStore);
  readonly dialogService = inject(DialogService);
  readonly AppStatus = AppStatus;

  readonly isUnlockModalOpen = signal(false);
  readonly currentView = signal<DriveView>('drive');
  readonly isVideoReady = signal(false);

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
    void this.pinnedFoldersStore.load();
  }

  openFilePicker(): void {
    this.fileInput?.nativeElement.click();
  }

  openFolderPicker(): void {
    this.folderInput?.nativeElement.click();
  }

  onViewChange(view: DriveView): void {
    this.currentView.set(view);
    if (view === 'drive') this.driveStore.navigateTo(null);
    if (view === 'trash') this.driveStore.loadTrash();
  }

  onPinnedFolderNavigate(folderId: number): void {
    if (this.appState.isLocked() || !this.pinnedFoldersStore.pinnedFolders().some(folder => folder.id === folderId && folder.available)) return;
    this.currentView.set('drive');
    this.driveStore.navigateTo(folderId);
  }

  onAddressNavigate(value: string): void {
    if (this.appState.isLocked()) return;

    const parts = value
      .split(/[>/\\]/)
      .map(part => part.trim())
      .filter(Boolean)
      .filter(part => !['este computador', 'nanika', 'meu drive'].includes(part.toLowerCase()));

    let parentId: number | null = null;
    for (const part of parts) {
      const folder = this.driveStore.files().find(file =>
        file.isFolder && (file.parentId ?? null) === parentId && file.decryptedName?.toLowerCase() === part.toLowerCase()
      );
      if (!folder) return;
      parentId = folder.id;
    }

    this.currentView.set('drive');
    this.driveStore.navigateTo(parentId);
  }

  lockDrive(): void {
    this.cryptoService.lockVault();
    this.driveStore.clearDecryptedNames();
    this.driveStore.navigateTo(null);
    this.appState.lock();
  }

  readonly activeVideoFile = signal<DriveFile | null>(null);
  readonly activeImageFile = signal<DriveFile | null>(null);
  readonly activeImagePlaylist = signal<DriveFile[]>([]);
  readonly shareFile = signal<DriveFile | null>(null);

  onShareRequested(file: DriveFile) {
    this.shareFile.set(file);
  }

  onImageSelected(payload: { file: DriveFile, playlist: DriveFile[] }) {
    this.activeImagePlaylist.set(payload.playlist);
    this.activeImageFile.set(payload.file);
  }

  @HostListener('document:contextmenu', ['$event'])
  onDocumentContextMenu(event: MouseEvent) {
    event.preventDefault();
  }

  async createNewFolder() {
    if (this.appState.isLocked()) return;

    const name = await this.dialogService.prompt('Nova pasta', '', 'Nome da pasta', 'Criar');
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

  async onFilesSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';

    if (this.appState.isLocked() || files.length === 0) return;

    try {
      const folderId = this.driveStore.currentFolderId();
      if (files.length === 1) {
        await this.driveStore.uploadFile(files[0], folderId);
      } else {
        await this.driveStore.uploadFiles(files, folderId);
      }
    } catch (e) {
      console.error(e);
      alert('Erro no upload');
    }
  }

  async onFolderSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (this.appState.isLocked() || files.length === 0) return;

    try {
      const rootParentId = this.driveStore.currentFolderId();
      await this.driveStore.uploadFolder(files, rootParentId);
    } catch (error) {
      console.error(error);
      alert('Erro no upload da pasta');
    }
  }

  async onDropped(drop: DroppedItems): Promise<void> {
    const folderId = this.dropTargetFolderId;
    this.dropTargetFolderId = undefined;
    if (folderId === undefined || this.appState.isLocked() || this.currentView() !== 'drive') return;
    if (drop.files.length > 0) {
      try {
        if (drop.files.length === 1) await this.driveStore.uploadFile(drop.files[0], folderId);
        else await this.driveStore.uploadFiles(drop.files, folderId, 'drop-files');
      } catch (error) {
        console.error(error);
        alert('Erro no upload dos arquivos arrastados');
      }
    }
    if (drop.folders.length > 0 && !this.appState.isLocked()) {
      try {
        await this.driveStore.uploadFolderSources(drop.folders, folderId, 'drop-folders');
      } catch (error) {
        console.error(error);
        alert('Erro no upload das pastas arrastadas');
      }
    }
  }

  onDropStarted(): void {
    this.dropTargetFolderId = this.appState.isLocked() || this.currentView() !== 'drive'
      ? undefined
      : this.driveStore.currentFolderId();
  }

  onDropError(error: unknown): void {
    console.error('Erro ao ler itens arrastados', error);
    alert('Não foi possível ler os itens arrastados');
  }

  async onEmptyTrash() {
    const confirmed = await this.dialogService.confirm(
      'Excluir permanentemente?',
      'Todos os itens na lixeira serão excluídos permanentemente. Não é possível desfazer essa ação.',
      'Excluir permanentemente',
      true
    );
    if (!confirmed) return;
    try {
      await this.driveStore.emptyTrash();
    } catch (e) {
      alert('Erro ao esvaziar a lixeira');
    }
  }

  onDialogConfirm(dialog: any) {
    if (dialog.options.showInput) {
      dialog.resolve(this.dialogService.dialogValue());
    } else {
      dialog.resolve(true);
    }
    this.dialogService.activeDialog.set(null);
  }

  onDialogCancel(dialog: any) {
    dialog.resolve(dialog.options.showInput ? null : false);
    this.dialogService.activeDialog.set(null);
  }

  onLogout(): void {
    this.authService.logout();
  }
}
