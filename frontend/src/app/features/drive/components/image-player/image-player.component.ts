import { Component, input, output, inject, OnDestroy, signal, effect, untracked, HostListener, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DriveStore, DriveFile } from '../../state/drive.store';
import { DriveService } from '../../services/drive.service';
import { ShareService } from '../../services/share.service';
import { KasumiCryptoService } from '../../../../core/crypto/kasumi-crypto.service';
import { CryptoService } from '../../../../core/crypto/crypto.service';
import { FileIconComponent } from '../../../../shared/ui/file-icon/file-icon.component';
import { VideoPlayerComponent } from '../video-player/video-player.component';
import { HttpClient, HttpEvent, HttpEventType } from '@angular/common/http';
import { environment } from '../../../../../environments/environment';
import { Observable, firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-image-player',
  standalone: true,
  imports: [CommonModule, FileIconComponent, VideoPlayerComponent],
  template: `
    <div class="player-backdrop" (click)="onClose()">
      
      <!-- Top Header Bar -->
      <div class="player-header-bar" (click)="$event.stopPropagation()">
        <div class="header-left">
          <button class="icon-btn" (click)="onClose()" aria-label="Voltar">
            <span class="material-symbols-outlined">arrow_back</span>
          </button>
          <app-file-icon [fileType]="file().type" [locked]="false" class="header-icon"></app-file-icon>
          <span class="file-title">{{ file().decryptedName || file().encryptedName }}</span>
        </div>
        
        <div class="header-right">
          <button class="share-btn">
            <span class="material-symbols-outlined">group</span> Compartilhar
          </button>
          @if (playlist().length > 1) {
            <div class="nav-controls">
              <button class="icon-btn" (click)="prevImage($event)" [disabled]="currentIndex() === 0 || isVideoPlaying() || isVideoLoading()">
                <span class="material-symbols-outlined">arrow_back</span>
              </button>
              <button class="icon-btn" (click)="nextImage($event)" [disabled]="currentIndex() === playlist().length - 1 || isVideoPlaying() || isVideoLoading()">
                <span class="material-symbols-outlined">arrow_forward</span>
              </button>
            </div>
          }
        </div>
      </div>

      <!-- Secondary Toolbar (Left) -->
      <div class="toolbar-left" (click)="$event.stopPropagation()">
        <button class="icon-btn progress-btn" aria-label="Baixar" (click)="downloadFile()" title="Baixar Arquivo" [disabled]="isDownloading()">
          @if (isDownloading()) {
            <span class="material-symbols-outlined spinning">sync</span>
            @if (downloadProgress() !== null) {
              <span class="progress-text">{{ downloadProgress() }}%</span>
            }
          } @else {
            <span class="material-symbols-outlined">download</span>
          }
        </button>
        <div class="divider"></div>
        <button class="icon-btn" (click)="zoomOut()" [disabled]="currentZoom() <= 0.25 || file().type !== 'image'" title="Diminuir Zoom">
          <span class="material-symbols-outlined">remove</span>
        </button>
        <button class="icon-btn" aria-label="Zoom" (click)="resetZoom()" title="Resetar Zoom" [disabled]="file().type !== 'image'" [class.active-zoom]="currentZoom() !== 1">
          <span class="material-symbols-outlined">search</span>
        </button>
        <button class="icon-btn" (click)="zoomIn()" [disabled]="currentZoom() >= 3 || file().type !== 'image'" title="Aumentar Zoom">
          <span class="material-symbols-outlined">add</span>
        </button>
      </div>

      <!-- Main Content Area -->
      <div class="media-clip-container">
        <div class="image-wrapper" 
             (wheel)="onWheel($event)"
             (mousedown)="onMouseDown($event)"
             (mousemove)="onMouseMove($event)"
             (mouseup)="onMouseUp()"
             (mouseleave)="onMouseUp()">
        @if (file().type === 'video') {
          <div class="video-preview-container">
            @if (!isVideoPlaying()) {
              @if (thumbnailData()) {
                <img [src]="thumbnailData()" 
                     class="video-thumbnail" 
                     [class.dragging]="isDragging"
                     alt="Video thumbnail" 
                     [style.transform]="'translate(' + translateX() + 'px, ' + translateY() + 'px) scale(' + currentZoom() + ')'" 
                     draggable="false"
                     (click)="onVideoClick($event)" />
              } @else {
                <div class="no-thumbnail" (click)="onVideoClick($event)">
                  <span class="material-symbols-outlined">movie</span>
                </div>
              }
            }

            @if (!isVideoPlaying() && !isVideoLoading()) {
              <button class="play-overlay-btn" (click)="$event.stopPropagation(); playVideo.emit(file())">
                <span class="material-symbols-outlined">play_arrow</span>
              </button>
            } @else {
              <app-video-player 
                class="seamless-video"
                [file]="file()" 
                [seamless]="true" 
                [isDownloading]="isDownloading()"
                [downloadProgress]="downloadProgress()"
                (download)="downloadFile()"
                (close)="closeVideo.emit()" 
                (videoReady)="videoReady.emit()" />
            }
          </div>
        } @else {
          @if (file().type === 'image' && imageUrl()) {
            <img [src]="imageUrl()" 
                 class="image-node" 
                 [class.dragging]="isDragging"
                 alt="Imagem descriptografada" 
                 [style.transform]="'translate(' + translateX() + 'px, ' + translateY() + 'px) scale(' + currentZoom() + ')'" 
                 draggable="false"
                 (click)="$event.stopPropagation()" />
          } @else if (file().type !== 'image' && !isLoading()) {
            <!-- No Preview Available -->
            <div class="no-preview-wrapper">
              <div class="share-card-dark" (click)="$event.stopPropagation()">
                <div class="brand-header">
                  <span class="brand-title">Nenhuma visualização disponível</span>
                </div>
                <div class="file-details-container">
                  <div class="file-icon-wrapper">
                    <app-file-icon [fileType]="file().type" [locked]="false" class="file-large-icon"></app-file-icon>
                  </div>
                  <h1 class="file-name" [title]="file().decryptedName || file().encryptedName">{{ file().decryptedName || file().encryptedName }}</h1>
                  <p class="file-size">Tamanho: {{ file().sizeFormatted }}</p>
                  
                  <div class="actions-container">
                    <button class="download-btn" (click)="downloadFile()">
                      <span class="material-symbols-outlined btn-icon">download</span>
                      Baixar Arquivo
                    </button>
                  </div>
                </div>
              </div>
            </div>
          }
        }
        </div>
      </div>

      <!-- Loading Overlay -->
      @if (isLoading()) {
        <div class="loading-overlay">
          <div class="spinner"></div>
          <div class="loading-text">Carregando e descriptografando...</div>
        </div>
      }

      <!-- Error Alert Overlay -->
      @if (error()) {
        <div class="error-overlay">
          <span class="material-symbols-outlined error-icon">error</span>
          <div class="error-text">{{ error() }}</div>
          <button class="retry-btn" (click)="loadImage(file())">Tentar Novamente</button>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .player-backdrop {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(15, 23, 42, 0.95);
        z-index: 3000;
        animation: fadeInBackdrop 200ms ease-out;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      .player-header-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 24px;
        background: transparent;
        width: 100%;
        box-sizing: border-box;
        z-index: 20;
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .header-icon {
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .header-right {
        display: flex;
        align-items: center;
        gap: 16px;
      }

      .file-title {
        color: #f8fafc;
        font-family: 'Outfit', 'Inter', sans-serif;
        font-size: 16px;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 400px;
      }

      .icon-btn {
        background: transparent;
        border: none;
        color: #cbd5e1;
        cursor: pointer;
        padding: 8px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 200ms, color 200ms;
      }
      .icon-btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.1);
        color: #f8fafc;
      }
      .icon-btn:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
      
      .active-zoom {
        color: #0ea5e9;
      }

      .share-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        background: #0ea5e9;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 20px;
        font-family: 'Outfit', sans-serif;
        font-weight: 500;
        font-size: 14px;
        cursor: pointer;
        transition: background 200ms;
      }
      .share-btn:hover {
        background: #0284c7;
      }
      .share-btn .material-symbols-outlined {
        font-size: 18px;
      }

      .nav-controls {
        display: flex;
        align-items: center;
        gap: 4px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 24px;
        padding: 2px 4px;
      }

      .toolbar-left {
        position: absolute;
        top: 72px;
        left: 24px;
        display: flex;
        align-items: center;
        gap: 4px;
        background: rgba(15, 23, 42, 0.7);
        padding: 4px 8px;
        border-radius: 8px;
        z-index: 20;
        backdrop-filter: blur(4px);
        border: 1px solid rgba(255, 255, 255, 0.1);
      }

      .divider {
        width: 1px;
        height: 20px;
        background: rgba(255, 255, 255, 0.2);
        margin: 0 4px;
      }

      .media-clip-container {
        position: absolute;
        top: 135px;
        left: 0;
        width: 100%;
        height: calc(100vh - 135px);
        overflow: hidden;
        z-index: 1;
      }
      .image-wrapper {
        position: relative;
        top: 0;
        left: 0;
        width: 100%;
        height: calc(100% - 20px);
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: visible;
      }

      .image-node {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        display: block;
        transition: transform 150ms ease-out;
      }


      .image-node.dragging, .video-thumbnail.dragging {
        transition: none;
        cursor: grabbing;
      }

      .video-preview-container {
        position: relative;
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .spinning {
        animation: spin 1s linear infinite;
      }

      .progress-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        padding-right: 12px;
        border-radius: 20px;
      }

      .progress-text {
        font-family: 'Inter', sans-serif;
        font-size: 13px;
        font-weight: 500;
        color: #f8fafc;
      }

      .seamless-video {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        display: block;
        z-index: 5;
      }
      .video-thumbnail {
        height: 100vh;
        width: auto;
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        display: block;
        transition: opacity 150ms ease-out;
      }

      .no-preview-wrapper {
        position: relative;
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 24px;
      }

      .share-card-dark {
        background: #4C494C;
        border-radius: 14px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
        width: 100%;
        max-width: 460px;
        padding: 32px;
        box-sizing: border-box;
      }
      .brand-header {
        text-align: center;
        margin-bottom: 28px;
      }
      .brand-title {
        font-size: 18px;
        font-weight: 600;
        color: #f8fafc;
        letter-spacing: -0.025em;
      }
      .file-details-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
      }
      .file-icon-wrapper {
        width: 80px;
        height: 80px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.1);
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 20px;
      }
      .file-large-icon {
        font-size: 40px;
      }
      .file-name {
        font-size: 18px;
        font-weight: 600;
        color: #f8fafc;
        margin: 0 0 6px;
        word-break: break-all;
        max-width: 100%;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .file-size {
        font-size: 14px;
        color: #94a3b8;
        margin: 0 0 28px;
      }
      .actions-container {
        width: 100%;
      }
      .download-btn {
        width: 100%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        background: #2563eb;
        color: white;
        border: none;
        padding: 12px 24px;
        border-radius: 8px;
        font-weight: 500;
        cursor: pointer;
        font-size: 15px;
        transition: background 0.2s;
      }
      .download-btn:hover {
        background: #1d4ed8;
      }

      .no-thumbnail {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        color: #475569;
      }
      .no-thumbnail .material-symbols-outlined {
        font-size: 80px;
      }
      .play-overlay-btn {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(15, 23, 42, 0.7);
        border: 2px solid rgba(255, 255, 255, 0.2);
        color: #f8fafc;
        width: 80px;
        height: 80px;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 200ms, background 200ms;
        z-index: 10;
      }
      .play-overlay-btn .material-symbols-outlined {
        font-size: 48px;
        margin-left: 4px;
      }
      .play-overlay-btn:hover {
        background: rgba(15, 23, 42, 0.9);
        transform: translate(-50%, -50%) scale(1.1);
      }

      .loading-overlay, .error-overlay {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(15, 23, 42, 0.8);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: #f1f5f9;
        z-index: 10;
        font-family: 'Inter', sans-serif;
      }

      .spinner {
        width: 48px;
        height: 48px;
        border: 4px solid rgba(255, 255, 255, 0.13);
        border-top-color: #3b82f6;
        border-radius: 50%;
        animation: spin 800ms linear infinite;
        margin-bottom: 16px;
      }

      .loading-text {
        font-size: 14px;
        font-weight: 400;
        color: #cbd5e1;
      }

      .error-icon {
        font-size: 48px;
        color: #ef4444;
        margin-bottom: 16px;
      }

      .error-text {
        font-size: 14px;
        color: #fca5a5;
        margin-bottom: 16px;
        text-align: center;
        padding: 0 32px;
      }

      .retry-btn {
        background: #ef4444;
        border: none;
        color: #ffffff;
        padding: 10px 20px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: background 200ms;
      }

      .retry-btn:hover {
        background: #dc2626;
      }

      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }

      @keyframes fadeInBackdrop {
        from { opacity: 0; }
        to { opacity: 1; }
      }
    `,
  ],
})
export class ImagePlayerComponent implements OnDestroy {
  readonly file = input.required<DriveFile>();
  readonly playlist = input<DriveFile[]>([]);
  readonly isVideoPlaying = input<boolean>(false);
  readonly isVideoLoading = input<boolean>(false);
  readonly fileChange = output<DriveFile>();
  readonly playVideo = output<DriveFile>();
  readonly close = output<void>();
  readonly closeVideo = output<void>();
  readonly videoReady = output<void>();

  private readonly driveStore = inject(DriveStore);
  private readonly driveService = inject(DriveService);
  private readonly shareService = inject(ShareService);
  private readonly cryptoService = inject(CryptoService);
  private readonly kasumi = inject(KasumiCryptoService);
  private readonly http = inject(HttpClient);

  readonly isDownloading = computed(() => this.driveStore.isDownloading());
  readonly downloadProgress = computed(() => this.driveStore.downloadProgress() > 0 ? this.driveStore.downloadProgress() : null);

  readonly isLoading = signal(true);
  readonly error = signal<string | null>(null);
  readonly imageUrl = signal<string | null>(null);
  readonly currentZoom = signal(1);
  readonly translateX = signal(0);
  readonly translateY = signal(0);

  isDragging = false;
  private hasDragged = false;
  private dragStartX = 0;
  private dragStartY = 0;

  readonly currentIndex = computed(() => {
    return this.playlist().findIndex(f => f.id === this.file().id);
  });

  readonly thumbnailData = computed(() => {
    const current = this.file();
    if (current.type === 'video') {
      return this.driveStore.thumbnails()[current.id] || null;
    }
    return null;
  });

  private imageCache = new Map<number, string>();
  private fetchInFlight = new Set<number>();
  private abortController: AbortController | null = null;
  private prefetchAbortController = new AbortController();

  constructor() {
    effect(() => {
      const current = this.file();
      if (current) {
        untracked(() => {
          this.currentZoom.set(1);
          this.translateX.set(0);
          this.translateY.set(0);
          this.isDragging = false;
          if (current.type === 'image') {
            this.loadImage(current);
          } else if (current.type === 'video') {
            this.isLoading.set(false);
            this.error.set(null);
            this.imageUrl.set(null);
            this.driveStore.loadThumbnail(current);
            this.triggerPrefetch();
          } else {
            this.isLoading.set(false);
          }
        });
      }
    });
  }

  ngOnDestroy() {
    this.imageCache.forEach(url => URL.revokeObjectURL(url));
    this.imageCache.clear();

    if (this.abortController) {
      this.abortController.abort();
    }
    this.prefetchAbortController.abort();
  }

  async loadImage(currentFile = this.file()) {
    if (this.abortController) {
      this.abortController.abort();
    }

    this.imageUrl.set(null);
    this.isLoading.set(true);
    this.error.set(null);
    this.abortController = new AbortController();

    if (this.imageCache.has(currentFile.id)) {
      this.imageUrl.set(this.imageCache.get(currentFile.id)!);
      this.isLoading.set(false);
      this.triggerPrefetch();
      return;
    }

    const currentSignal = this.abortController.signal;

    try {
      const url = await this.downloadAndDecrypt(currentFile, currentSignal);
      if (currentSignal.aborted) return;

      this.imageCache.set(currentFile.id, url);
      this.imageUrl.set(url);
      this.isLoading.set(false);

      this.triggerPrefetch();
    } catch (e: any) {
      if (!currentSignal.aborted && e?.message !== 'Aborted' && e?.name !== 'AbortError') {
        console.error('[ImagePlayer] Falha ao carregar imagem', e);
        this.error.set(e?.message || 'Falha ao descriptografar imagem.');
        this.isLoading.set(false);
      }
    }
  }

  private triggerPrefetch() {
    const pl = this.playlist();
    const idx = this.currentIndex();
    if (idx === -1) return;

    const indicesToPrefetch: number[] = [];
    for (let offset = 1; offset <= 6; offset++) {
      indicesToPrefetch.push(idx - offset);
      indicesToPrefetch.push(idx + offset);
    }

    for (const i of indicesToPrefetch) {
      if (i >= 0 && i < pl.length) {
        const file = pl[i];
        if (!this.imageCache.has(file.id) && !this.fetchInFlight.has(file.id)) {
          this.prefetchFile(file);
        }
      }
    }

    const keepRadius = 7;
    for (const [id, url] of this.imageCache.entries()) {
      const fileIdx = pl.findIndex(f => f.id === id);
      if (fileIdx === -1 || Math.abs(fileIdx - idx) > keepRadius) {
        URL.revokeObjectURL(url);
        this.imageCache.delete(id);
      }
    }
  }

  private async prefetchFile(file: DriveFile) {
    if (file.type !== 'image') return;
    this.fetchInFlight.add(file.id);
    try {
      const url = await this.downloadAndDecrypt(file, this.prefetchAbortController.signal);
      if (!this.prefetchAbortController.signal.aborted) {
        this.imageCache.set(file.id, url);
      }
    } catch (e) {
      // Ignorar erros no prefetch
    } finally {
      this.fetchInFlight.delete(file.id);
    }
  }

  private async downloadAndDecrypt(file: DriveFile, signal: AbortSignal): Promise<string> {
    let encryptedBlob: Blob;
    let fdk: Uint8Array;

    if (file.shareUuid && file.shareFdk) {
      encryptedBlob = await firstValueFrom(this.shareService.downloadSharedFile(file.shareUuid));
      fdk = file.shareFdk;
    } else {
      if (!file.encryptedFdk) throw new Error('Chave de criptografia nao encontrada (FDK)');

      const fdkBase64 = await this.cryptoService.decryptName(file.encryptedFdk);
      const fdkString = atob(fdkBase64);
      fdk = new Uint8Array(fdkString.length);
      for (let i = 0; i < fdkString.length; i++) {
        fdk[i] = fdkString.charCodeAt(i);
      }

      if (file.storageProvider === 'google_drive') {
        const meta = await firstValueFrom(this.driveService.downloadExternalMetadata(file.id));
        const gdriveUrl = `https://www.googleapis.com/drive/v3/files/${meta.external_file_id}?alt=media`;
        const extReq$ = this.driveService.downloadExternalFileRange(gdriveUrl, meta.access_token, 0, file.sizeBytes - 1);
        encryptedBlob = await firstValueFrom(extReq$);
      } else {
        encryptedBlob = await firstValueFrom(this.driveService.downloadFile(file.id));
      }
    }

    if (signal.aborted) throw new Error('Aborted');

    const decryptedBlob = await this.kasumi.decryptFile(encryptedBlob, fdk);

    if (signal.aborted) throw new Error('Aborted');

    return URL.createObjectURL(decryptedBlob);
  }

  onClose() {
    if (this.isVideoPlaying() || this.isVideoLoading()) {
      this.closeVideo.emit();
    } else {
      this.close.emit();
    }
  }

  resetZoom() {
    this.currentZoom.set(1);
    this.translateX.set(0);
    this.translateY.set(0);
  }

  zoomIn() {
    this.currentZoom.update(z => Math.min(z + 0.25, 3));
  }

  zoomOut() {
    this.currentZoom.update(z => {
      const newZoom = Math.max(z - 0.25, 0.25);
      if (newZoom <= 1) {
        this.translateX.set(0);
        this.translateY.set(0);
      }
      return newZoom;
    });
  }

  onWheel(event: WheelEvent) {
    if (this.file().type === 'video') return;
    if (event.deltaY < 0) {
      this.zoomIn();
    } else if (event.deltaY > 0) {
      this.zoomOut();
    }
  }

  onMouseDown(event: MouseEvent) {
    if (this.currentZoom() > 1) {
      this.isDragging = true;
      this.hasDragged = false;
      this.dragStartX = event.clientX - this.translateX();
      this.dragStartY = event.clientY - this.translateY();
    }
  }

  onMouseMove(event: MouseEvent) {
    if (this.isDragging && this.currentZoom() > 1) {
      this.hasDragged = true;
      this.translateX.set(event.clientX - this.dragStartX);
      this.translateY.set(event.clientY - this.dragStartY);
    }
  }

  onMouseUp() {
    this.isDragging = false;
  }

  onVideoClick(event: MouseEvent) {
    event.stopPropagation();
    if (this.hasDragged) {
      this.hasDragged = false;
      return;
    }

    const target = event.target as HTMLElement;
    if (target.tagName === 'IMG') {
      const img = target as HTMLImageElement;
      const rect = img.getBoundingClientRect();
      const naturalW = img.naturalWidth;
      const naturalH = img.naturalHeight;
      const clientW = img.clientWidth;
      const clientH = img.clientHeight;

      if (naturalW && naturalH) {
        const scale = Math.min(clientW / naturalW, clientH / naturalH);
        const renderedW = naturalW * scale;
        const renderedH = naturalH * scale;

        const emptyX = (clientW - renderedW) / 2;
        const emptyY = (clientH - renderedH) / 2;

        const clickX = event.clientX - rect.left;
        const clickY = event.clientY - rect.top;

        if (clickX < emptyX - 5 || clickX > clientW - emptyX + 5 ||
          clickY < emptyY - 5 || clickY > clientH - emptyY + 5) {
          this.onClose();
          return;
        }
      }
    } else if (target.classList.contains('no-thumbnail')) {
      // Allow clicking the empty video box
    } else if (target.closest('.play-overlay-btn')) {
      // Let the button handle it, or handle it here
    }

    this.playVideo.emit(this.file());
  }

  async downloadFile() {
    if (this.isDownloading()) return;

    const file = this.file();
    try {
      if (this.imageUrl()) {
        const a = document.createElement('a');
        a.href = this.imageUrl()!;
        a.download = file.decryptedName || 'download';
        a.click();
        return;
      }

      await this.driveStore.downloadFile(file);
    } catch (e) {
      console.error('[ImagePlayer] Erro no download do arquivo:', e);
    }
  }

  prevImage(event?: Event) {
    event?.stopPropagation();
    if (this.isVideoPlaying() || this.isVideoLoading()) return;
    const idx = this.currentIndex();
    if (idx > 0) {
      this.fileChange.emit(this.playlist()[idx - 1]);
    }
  }

  nextImage(event?: Event) {
    event?.stopPropagation();
    if (this.isVideoPlaying() || this.isVideoLoading()) return;
    const idx = this.currentIndex();
    if (idx >= 0 && idx < this.playlist().length - 1) {
      this.fileChange.emit(this.playlist()[idx + 1]);
    }
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent) {
    // Avoid intercepting keys if the user is interacting with a native input or video
    const targetName = (event.target as HTMLElement)?.tagName?.toLowerCase();
    if (targetName === 'input' || targetName === 'textarea' || targetName === 'video') {
      if (event.key === 'Escape') this.close.emit();
      return;
    }

    switch (event.key) {
      case 'Escape':
        this.onClose();
        break;
      case 'ArrowLeft':
        if (!this.isVideoPlaying() && !this.isVideoLoading()) this.prevImage();
        break;
      case 'ArrowRight':
        if (!this.isVideoPlaying() && !this.isVideoLoading()) this.nextImage();
        break;
      case 'ArrowUp':
      case 'ArrowDown':
        // Block default scrolling when player is open
        event.preventDefault();
        break;
    }
  }
}
