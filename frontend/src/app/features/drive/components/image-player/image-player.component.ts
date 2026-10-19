import { Component, input, output, inject, OnDestroy, signal, effect, untracked, HostListener, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DriveStore, DriveFile } from '../../state/drive.store';
import { FileIconComponent } from '../../../../shared/ui/file-icon/file-icon.component';
import { VideoPlayerComponent } from '../video-player/video-player.component';
import { AudioPlayerComponent } from '../audio-player/audio-player.component';
import { DecryptedMediaLoaderService } from '../../services/decrypted-media-loader.service';
import type { DecryptedMediaResource } from '../../services/decrypted-media-loader.service';
import { resolveFilePreviewKind } from '../../services/file-preview-resolver';
import { ShareModalComponent } from '../share-modal/share-modal.component';
import { getPublicShareAvailability } from '../../policies/public-share-policy';

const MAX_PREFETCH_SOURCE_BYTES = 32 * 1024 * 1024;

interface CachedImage {
  readonly url: string;
  readonly sourceBytes: number;
  readonly cleanup: () => void;
}

interface PrefetchReservation {
  readonly generation: number;
  readonly sourceBytes: number;
}

@Component({
  selector: 'app-image-player',
  standalone: true,
  imports: [CommonModule, FileIconComponent, VideoPlayerComponent, AudioPlayerComponent, ShareModalComponent],
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
          @if (shareAvailability().allowed) {
            <button class="share-btn" (click)="openShare($event)">
              <span class="material-symbols-outlined">group</span> Compartilhar
            </button>
          } @else {
            <button class="share-btn" disabled aria-disabled="true" title="Compartilhamento público indisponível para Google Drive">
              <span class="material-symbols-outlined">group_off</span> Compartilhamento indisponível
            </button>
          }
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
        <button class="icon-btn" (click)="zoomOut()" [disabled]="currentZoom() <= 0.25 || previewKind() !== 'image'" title="Diminuir Zoom">
          <span class="material-symbols-outlined">remove</span>
        </button>
        <button class="icon-btn" aria-label="Zoom" (click)="resetZoom()" title="Resetar Zoom" [disabled]="previewKind() !== 'image'" [class.active-zoom]="currentZoom() !== 1">
          <span class="material-symbols-outlined">search</span>
        </button>
        <button class="icon-btn" (click)="zoomIn()" [disabled]="currentZoom() >= 3 || previewKind() !== 'image'" title="Aumentar Zoom">
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
        @if (previewKind() === 'video') {
          <div class="video-preview-container">
            @if (!isVideoReady()) {
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
                (close)="closeVideo.emit(); isVideoReady.set(false)" 
                (videoReady)="isVideoReady.set(true); videoReady.emit()" />
            }
          </div>
        } @else {
          @if (previewKind() === 'image' && imageUrl()) {
            <img [src]="imageUrl()" 
                 class="image-node" 
                 [class.dragging]="isDragging"
                 alt="Imagem descriptografada" 
                 [style.transform]="'translate(' + translateX() + 'px, ' + translateY() + 'px) scale(' + currentZoom() + ')'" 
                 draggable="false"
                 (click)="$event.stopPropagation()" />
          } @else if (previewKind() === 'audio') {
            <div class="audio-preview-container" (click)="$event.stopPropagation()">
              <app-audio-player
                class="embedded-audio-player"
                [file]="file()"
                (close)="onClose()"
                (downloadRequested)="downloadFile()" />
            </div>
          } @else if (previewKind() === 'unsupported' && !isLoading()) {
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

      @if (isShareOpen() && shareAvailability().allowed) {
        <div class="player-share-modal" (click)="$event.stopPropagation()">
          <app-share-modal [file]="file()" (close)="isShareOpen.set(false)" />
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
        font-weight: 500;
        font-size: 14px;
        font-family: 'Outfit', sans-serif;
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
      .audio-preview-container {
        width: min(560px, calc(100vw - 48px));
        max-width: 100%;
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
  private readonly mediaLoader = inject(DecryptedMediaLoaderService);

  readonly isDownloading = computed(() => this.driveStore.isDownloading());
  readonly downloadProgress = computed(() => this.driveStore.downloadProgress() > 0 ? this.driveStore.downloadProgress() : null);

  readonly isLoading = signal(true);
  readonly error = signal<string | null>(null);
  readonly imageUrl = signal<string | null>(null);
  readonly previewKind = computed(() => resolveFilePreviewKind(this.file()));
  readonly currentZoom = signal(1);
  readonly translateX = signal(0);
  readonly translateY = signal(0);
  readonly isVideoReady = signal(false);
  readonly isShareOpen = signal(false);
  readonly shareAvailability = computed(() => getPublicShareAvailability(this.file()));

  isDragging = false;
  private hasDragged = false;
  private dragStartX = 0;
  private dragStartY = 0;

  readonly currentIndex = computed(() => {
    return this.playlist().findIndex(f => f.id === this.file().id);
  });

  readonly thumbnailData = computed(() => {
    const current = this.file();
    if (this.previewKind() === 'video') {
      return this.driveStore.thumbnails()[current.id] || null;
    }
    return null;
  });

  private readonly imageCache = new Map<number, CachedImage>();
  private readonly prefetchInFlight = new Map<number, PrefetchReservation>();
  private abortController: AbortController | null = null;
  private prefetchAbortController: AbortController | null = null;
  private prefetchGeneration = 0;

  constructor() {
    effect(() => {
      if (!this.isVideoPlaying()) {
        untracked(() => {
          this.isVideoReady.set(false);
        });
      }
    });

    effect(() => {
      const current = this.file();
      if (current) {
        untracked(() => {
          this.currentZoom.set(1);
          this.translateX.set(0);
          this.translateY.set(0);
          this.isVideoReady.set(false);
          this.isDragging = false;
          this.cancelForegroundLoad();
          this.cancelPrefetchSession();
          const kind = resolveFilePreviewKind(current);
          this.pruneImageCache(kind === 'image' ? current : null);
          this.imageUrl.set(null);
          if (kind === 'image') {
            this.loadImage(current);
          } else if (kind === 'video') {
            this.isLoading.set(false);
            this.error.set(null);
            this.driveStore.loadThumbnail(current);
          } else {
            this.isLoading.set(false);
          }
        });
      }
    });
  }

  ngOnDestroy() {
    this.cancelForegroundLoad();
    this.cancelPrefetchSession();
    this.clearImageCache();
  }

  protected async loadImage(currentFile = this.file()) {
    this.cancelForegroundLoad();

    this.imageUrl.set(null);
    this.isLoading.set(true);
    this.error.set(null);
    const controller = new AbortController();
    this.abortController = controller;
    const currentSignal = controller.signal;

    try {
      const cached = this.imageCache.get(currentFile.id);
      if (cached) {
        this.imageUrl.set(cached.url);
        this.isLoading.set(false);
        this.prefetchAdjacentImages();
        return;
      }

      const resource = await this.downloadAndDecrypt(currentFile, currentSignal);
      if (currentSignal.aborted || this.file().id !== currentFile.id) {
        resource.cleanup();
        return;
      }

      this.storeCachedImage(currentFile, resource);
      this.imageUrl.set(resource.url);
      this.isLoading.set(false);

      this.prefetchAdjacentImages();
    } catch (e: any) {
      if (!currentSignal.aborted && e?.message !== 'Aborted' && e?.name !== 'AbortError') {
        console.error('[ImagePlayer] Falha ao carregar imagem', e);
        this.error.set(e?.message || 'Falha ao descriptografar imagem.');
        this.isLoading.set(false);
      }
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  private prefetchAdjacentImages() {
    const pl = this.playlist();
    const idx = this.currentIndex();
    if (idx === -1 || resolveFilePreviewKind(this.file()) !== 'image') return;

    this.pruneImageCache(this.file());
    const { generation, signal } = this.beginPrefetchSession();
    let reservedBytes = this.speculativeSourceBytes(generation);
    for (const candidateIndex of [idx - 1, idx + 1]) {
      if (candidateIndex < 0 || candidateIndex >= pl.length) continue;
      const file = pl[candidateIndex];
      if (
        resolveFilePreviewKind(file) !== 'image' ||
        this.imageCache.has(file.id) ||
        this.prefetchInFlight.has(file.id)
      ) continue;

      const sourceBytes = file.sizeBytes;
      if (
        sourceBytes <= 0 ||
        sourceBytes > MAX_PREFETCH_SOURCE_BYTES ||
        reservedBytes + sourceBytes > MAX_PREFETCH_SOURCE_BYTES
      ) continue;

      reservedBytes += sourceBytes;
      this.prefetchInFlight.set(file.id, { generation, sourceBytes });
      void this.prefetchFile(file, generation, signal);
    }
  }

  private async prefetchFile(file: DriveFile, generation: number, signal: AbortSignal) {
    try {
      const resource = await this.downloadAndDecrypt(file, signal);
      if (
        signal.aborted ||
        generation !== this.prefetchGeneration ||
        resolveFilePreviewKind(this.file()) !== 'image'
      ) {
        resource.cleanup();
        return;
      }
      this.prefetchInFlight.delete(file.id);
      this.storeCachedImage(file, resource);
    } catch (e) {
      // Ignorar erros no prefetch
    } finally {
      const reservation = this.prefetchInFlight.get(file.id);
      if (reservation?.generation === generation) this.prefetchInFlight.delete(file.id);
    }
  }

  private async downloadAndDecrypt(file: DriveFile, signal: AbortSignal): Promise<DecryptedMediaResource> {
    return this.mediaLoader.load(file, signal);
  }

  private beginPrefetchSession(): { generation: number; signal: AbortSignal } {
    this.cancelPrefetchSession();
    const controller = new AbortController();
    this.prefetchAbortController = controller;
    return { generation: this.prefetchGeneration, signal: controller.signal };
  }

  private cancelForegroundLoad(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private cancelPrefetchSession(): void {
    const oldGeneration = this.prefetchGeneration;
    this.prefetchAbortController?.abort();
    this.prefetchAbortController = null;
    this.prefetchGeneration++;
    for (const [id, reservation] of this.prefetchInFlight.entries()) {
      if (reservation.generation === oldGeneration) this.prefetchInFlight.delete(id);
    }
  }

  private storeCachedImage(file: DriveFile, resource: DecryptedMediaResource): void {
    this.imageCache.get(file.id)?.cleanup();
    this.imageCache.set(file.id, {
      url: resource.url,
      sourceBytes: file.sizeBytes,
      cleanup: resource.cleanup,
    });
  }

  private pruneImageCache(current: DriveFile | null): void {
    if (!current) {
      this.clearImageCache();
      return;
    }
    const playlist = this.playlist();
    const idx = playlist.findIndex(file => file.id === current.id);
    const neighborIds: number[] = [];
    if (idx > 0) neighborIds.push(playlist[idx - 1].id);
    if (idx >= 0 && idx < playlist.length - 1) neighborIds.push(playlist[idx + 1].id);

    const keep = new Set<number>([current.id]);
    let retainedSpeculativeBytes = 0;
    for (const id of neighborIds) {
      const cached = this.imageCache.get(id);
      if (
        !cached ||
        !Number.isFinite(cached.sourceBytes) ||
        cached.sourceBytes <= 0 ||
        cached.sourceBytes > MAX_PREFETCH_SOURCE_BYTES ||
        retainedSpeculativeBytes + cached.sourceBytes > MAX_PREFETCH_SOURCE_BYTES
      ) continue;

      keep.add(id);
      retainedSpeculativeBytes += cached.sourceBytes;
    }

    for (const [id, cached] of this.imageCache.entries()) {
      if (!keep.has(id)) {
        cached.cleanup();
        this.imageCache.delete(id);
      }
    }
  }

  private clearImageCache(): void {
    for (const cached of this.imageCache.values()) cached.cleanup();
    this.imageCache.clear();
  }

  private speculativeSourceBytes(generation: number): number {
    const currentId = this.file().id;
    let bytes = 0;
    for (const [id, cached] of this.imageCache.entries()) {
      if (id !== currentId) bytes += cached.sourceBytes;
    }
    for (const reservation of this.prefetchInFlight.values()) {
      if (reservation.generation === generation) bytes += reservation.sourceBytes;
    }
    return bytes;
  }

  protected onClose() {
    this.cancelForegroundLoad();
    this.cancelPrefetchSession();
    this.clearImageCache();
    if (this.isVideoPlaying() || this.isVideoLoading()) {
      this.closeVideo.emit();
    } else {
      this.close.emit();
    }
  }

  protected resetZoom() {
    this.currentZoom.set(1);
    this.translateX.set(0);
    this.translateY.set(0);
  }

  protected zoomIn() {
    this.currentZoom.update(z => Math.min(z + 0.25, 3));
  }

  protected zoomOut() {
    this.currentZoom.update(z => {
      const newZoom = Math.max(z - 0.25, 0.25);
      if (newZoom <= 1) {
        this.translateX.set(0);
        this.translateY.set(0);
      }
      return newZoom;
    });
  }

  protected onWheel(event: WheelEvent) {
    if (this.previewKind() !== 'image') return;
    if (event.deltaY < 0) {
      this.zoomIn();
    } else if (event.deltaY > 0) {
      this.zoomOut();
    }
  }

  protected onMouseDown(event: MouseEvent) {
    if (this.currentZoom() > 1) {
      this.isDragging = true;
      this.hasDragged = false;
      this.dragStartX = event.clientX - this.translateX();
      this.dragStartY = event.clientY - this.translateY();
    }
  }

  protected onMouseMove(event: MouseEvent) {
    if (this.isDragging && this.currentZoom() > 1) {
      this.hasDragged = true;
      this.translateX.set(event.clientX - this.dragStartX);
      this.translateY.set(event.clientY - this.dragStartY);
    }
  }

  protected onMouseUp() {
    this.isDragging = false;
  }

  protected onVideoClick(event: MouseEvent) {
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

  protected async downloadFile() {
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

  protected openShare(event: Event): void {
    event.stopPropagation();
    if (this.shareAvailability().allowed) this.isShareOpen.set(true);
  }

  protected prevImage(event?: Event) {
    event?.stopPropagation();
    if (this.isVideoPlaying() || this.isVideoLoading()) return;
    const idx = this.currentIndex();
    if (idx > 0) {
      this.fileChange.emit(this.playlist()[idx - 1]);
    }
  }

  protected nextImage(event?: Event) {
    event?.stopPropagation();
    if (this.isVideoPlaying() || this.isVideoLoading()) return;
    const idx = this.currentIndex();
    if (idx >= 0 && idx < this.playlist().length - 1) {
      this.fileChange.emit(this.playlist()[idx + 1]);
    }
  }

  @HostListener('window:keydown', ['$event'])
  protected onKeyDown(event: KeyboardEvent) {
    // Avoid intercepting keys if the user is interacting with a native input or video
    const targetName = (event.target as HTMLElement)?.tagName?.toLowerCase();
    if (targetName === 'input' || targetName === 'textarea' || targetName === 'video') {
      if (event.key === 'Escape') {
        if (this.isVideoPlaying() || this.isVideoLoading()) {
          this.closeVideo.emit();
          this.isVideoReady.set(false);
        } else {
          this.close.emit();
        }
      }
      return;
    }

    switch (event.key) {
      case 'Escape':
        if (this.isVideoPlaying() || this.isVideoLoading()) {
          this.closeVideo.emit();
          this.isVideoReady.set(false);
        } else {
          this.onClose();
        }
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
