import { Component, input, output, inject, OnDestroy, OnInit, signal, computed, ViewChild, ElementRef, HostListener, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ShareService } from '../drive/services/share.service';
import { KasumiCryptoService } from '../../core/crypto/kasumi-crypto.service';
import { VideoStreamService } from '../drive/services/video-stream.service';
import { DriveFile } from '../drive/state/drive.store';
import { VideoPlayerComponent } from '../drive/components/video-player/video-player.component';
import { FileIconComponent } from '../../shared/ui/file-icon/file-icon.component';
import { firstValueFrom } from 'rxjs';
@Component({
  selector: 'app-public-media-player',
  standalone: true,
  imports: [CommonModule, VideoPlayerComponent, FileIconComponent],
  template: `
    <div class="player-backdrop" (click)="onClose()">
      
      <!-- Top Header Bar -->
      @if (!error()) {
        <div class="player-header-bar" (click)="$event.stopPropagation()">
          <div class="header-left">
            <span class="material-symbols-outlined header-icon">{{ isVideo() ? 'movie' : 'image' }}</span>
            <span class="file-title" [title]="filename()">{{ filename() }}</span>
          </div>
          
          <div class="header-right">
            <span class="file-size-badge">{{ getFormattedSize() }}</span>
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
          @if (isImage()) {
            <div class="divider"></div>
            <button class="icon-btn" (click)="zoomOut()" [disabled]="currentZoom() <= 0.25 || !isImage()" title="Diminuir Zoom">
              <span class="material-symbols-outlined">remove</span>
            </button>
            <button class="icon-btn" aria-label="Zoom" (click)="resetZoom()" title="Resetar Zoom" [disabled]="!isImage()" [class.active-zoom]="currentZoom() !== 1">
              <span class="material-symbols-outlined">search</span>
            </button>
            <button class="icon-btn" (click)="zoomIn()" [disabled]="currentZoom() >= 3 || !isImage()" title="Aumentar Zoom">
              <span class="material-symbols-outlined">add</span>
            </button>
          }
        </div>
      }

      <!-- Main Content Area -->
      <div class="media-clip-container">
        @if (isLoading()) {
          <div class="loading-overlay">
            <div class="spinner"></div>
            <div class="loading-text">Carregando e descriptografando...</div>
          </div>
        } @else if (error()) {
          <div class="error-overlay">
            <span class="material-symbols-outlined error-icon">error</span>
            <div class="error-text">{{ error() }}</div>
          </div>
        } @else if (isVideo()) {
          <div class="video-preview-container" (click)="$event.stopPropagation()">
            @if (!isVideoReady()) {
              @if (thumbnailUrl()) {
                <img [src]="thumbnailUrl()" 
                     (error)="onThumbnailError()" 
                     class="video-thumbnail" 
                     alt="Miniatura do video" />
              } @else {
                <div class="no-thumbnail">
                  <span class="material-symbols-outlined">movie</span>
                </div>
              }
            }

            @if (!isPlayingVideo()) {
              <button class="play-overlay-btn" (click)="startVideoStreaming()">
                <span class="material-symbols-outlined">play_arrow</span>
              </button>
            } @else {
              <app-video-player 
                class="seamless-video"
                [file]="publicDriveFile()" 
                [seamless]="true"
                [isPublicShare]="true"
                (close)="onClose()" 
                (download)="downloadFile()"
                [isDownloading]="isDownloading()"
                [downloadProgress]="downloadProgress()"
                (videoReady)="isVideoReady.set(true)">
              </app-video-player>
            }
          </div>
        } @else if (isImage() && mediaUrl()) {
          <!-- Photo Viewer with Drag & Zoom -->
          <div class="image-wrapper" 
               (wheel)="onWheel($event)"
               (mousedown)="onMouseDown($event)"
               (mousemove)="onMouseMove($event)"
               (mouseup)="onMouseUp()"
               (mouseleave)="onMouseUp()">
            <img [src]="mediaUrl()" 
                 class="image-node" 
                 [class.dragging]="isDragging"
                 alt="Imagem descriptografada" 
                 [style.transform]="'translate(' + translateX() + 'px, ' + translateY() + 'px) scale(' + currentZoom() + ')'" 
                 draggable="false"
                 (click)="$event.stopPropagation()" />
          </div>
        } @else if (!isLoading() && !error()) {
          <!-- No Preview Available -->
          <div class="no-preview-wrapper">
            <div class="share-card-dark" (click)="$event.stopPropagation()">
              <div class="brand-header">
                <span class="brand-title">Nenhuma visualização disponível</span>
              </div>
              <div class="file-details-container">
                <div class="file-icon-wrapper">
                  <app-file-icon [fileType]="fileType()" [locked]="false" class="file-large-icon"></app-file-icon>
                </div>
                <h1 class="file-name" [title]="filename()">{{ filename() }}</h1>
                <p class="file-size">Tamanho: {{ getFormattedSize() }}</p>
                
                <div class="actions-container">
                  @if (isDownloading()) {
                    <div class="download-progress-container">
                      <div class="spinner-small"></div>
                      <span>{{ downloadProgress() }}% concluído...</span>
                    </div>
                  } @else {
                    <button class="download-btn" (click)="downloadFile()">
                      <span class="material-symbols-outlined btn-icon">download</span>
                      Baixar Arquivo
                    </button>
                  }
                </div>
              </div>
            </div>
          </div>
        }
      </div>
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
        display: flex;
        flex-direction: column;
        overflow: hidden;
        user-select: none;
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
        color: #f8fafc;
      }

      .header-icon {
        font-size: 24px;
        color: #0ea5e9;
        display: flex;
        align-items: center;
        justify-content: center;
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

      .header-right {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .file-size-badge {
        font-family: 'Inter', sans-serif;
        font-size: 13px;
        font-weight: 600;
        color: #f8fafc;
        background: rgba(255, 255, 255, 0.1);
        padding: 6px 12px;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.05);
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

      .icon-btn:hover:not([disabled]) {
        background: rgba(255, 255, 255, 0.1);
        color: #f8fafc;
      }

      .icon-btn[disabled] {
        opacity: 0.3;
        cursor: not-allowed;
      }

      .icon-btn.active-zoom {
        color: #0ea5e9;
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

      .loading-overlay, .error-overlay {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 16px;
        color: #94a3b8;
      }

      .error-icon {
        font-size: 48px;
        color: #ef4444;
      }

      .spinner {
        width: 44px;
        height: 44px;
        border: 3px solid rgba(255, 255, 255, 0.1);
        border-top-color: #0ea5e9;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
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

      .video-preview-container {
        position: relative;
        width: 100%;
        height: calc(100% - 20px);
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .seamless-video {
        position: absolute;
        top: 0; left: 0;
        width: 100%;
        height: 100%;
        display: block;
        z-index: 5;
      }

      .video-thumbnail {
        position: absolute;
        height: 100%;
        width: auto;
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        display: block;
        transition: opacity 150ms ease-out;
        z-index: 2;
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

      .download-progress-container {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 12px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 8px;
        color: #94a3b8;
        font-size: 14px;
        width: 100%;
        box-sizing: border-box;
      }

      .spinner-small {
        width: 18px;
        height: 18px;
        border: 2px solid rgba(255, 255, 255, 0.1);
        border-top-color: #3b82f6;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
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
        background: rgba(15, 23, 42, 0.75);
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
        background: rgba(15, 23, 42, 0.95);
        transform: translate(-50%, -50%) scale(1.1);
      }

      .video-node {
        height: 100%;
        width: auto;
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        outline: none;
        background: transparent;
      }

      .video-buffering-overlay {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        pointer-events: none;
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
        cursor: grab;
      }

      .image-wrapper:active {
        cursor: grabbing;
      }

      .image-node {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        display: block;
        transition: transform 150ms ease-out;
        will-change: transform;
      }

      .image-node.dragging {
        transition: none;
      }
    `
  ]
})
export class PublicMediaPlayerComponent implements OnInit, OnDestroy {
  readonly shareId = input.required<string>();
  readonly fdk = input.required<Uint8Array>();
  readonly filename = input.required<string>();
  readonly sizeBytes = input.required<number>();
  readonly isVideo = input.required<boolean>();
  readonly isImage = input.required<boolean>();
  readonly storageProvider = input<string>('local');
  readonly close = output<void>();

  @ViewChild('videoElement') videoElementRef?: ElementRef<HTMLVideoElement>;

  private readonly shareService = inject(ShareService);
  private readonly kasumi = inject(KasumiCryptoService);
  readonly videoStreamService = inject(VideoStreamService);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly isLoading = signal(true);
  readonly error = signal<string | null>(null);
  readonly thumbnailUrl = signal<string | null>(null);
  readonly isPlayingVideo = signal(false);

  readonly fileType = computed(() => {
    const name = this.filename().toLowerCase();
    if (this.isVideo()) return 'video';
    if (this.isImage()) return 'image';
    if (name.endsWith('.pdf')) return 'pdf';
    if (/\.(doc|docx)$/.test(name)) return 'doc';
    if (/\.(xls|xlsx|csv)$/.test(name)) return 'spreadsheet';
    if (/\.(mp3|wav|ogg)$/.test(name)) return 'audio';
    if (/\.(zip|rar|7z|tar|gz)$/.test(name)) return 'zip';
    if (/\.(txt|md|rtf|json)$/.test(name)) return 'txt';
    return 'default';
  });
  readonly isVideoReady = signal(false);
  readonly mediaUrl = signal<string | null>(null);
  readonly currentZoom = signal(1);
  readonly translateX = signal(0);
  readonly translateY = signal(0);
  readonly isDownloading = signal(false);
  readonly downloadProgress = signal<number | null>(null);

  private abortController: AbortController | null = null;
  readonly publicDriveFile = signal<DriveFile>({
    id: 0,
    isFolder: false,
    encryptedName: '',
    decryptedName: '',
    type: 'video',
    sizeBytes: 0,
    sizeFormatted: '',
    modifiedAt: new Date().toISOString(),
    owner: 'Nanika',
  });

  isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private decryptedBlob: Blob | null = null;

  ngOnInit() {
    if (this.isVideo()) {
      this.publicDriveFile.set({
        id: 0,
        isFolder: false,
        encryptedName: this.filename(),
        decryptedName: this.filename(),
        type: 'video',
        sizeBytes: this.sizeBytes(),
        sizeFormatted: this.getFormattedSize(),
        modifiedAt: new Date().toISOString(),
        owner: 'Nanika',
        shareUuid: this.shareId(),
        shareFdk: this.fdk(),
        storageProvider: this.storageProvider()
      });
      this.loadHeaderThumbnail();
    } else if (this.isImage()) {
      this.loadImage();
    } else {
      this.isLoading.set(false);
    }
  }

  async loadHeaderThumbnail() {
    this.isLoading.set(true);
    this.error.set(null);

    const tryFetchSize = async (sizeBytes: number): Promise<boolean> => {
      try {
        const headerBlob = await import('rxjs').then(m => m.firstValueFrom(
          this.shareService.downloadSharedFileRange(this.shareId(), 0, sizeBytes - 1)
        ));
        const res = await this.kasumi.extractMetadata(headerBlob, this.fdk());
        if (res.metadata) {
          try {
            const parsed = JSON.parse(res.metadata);
            if (parsed.thumb) {
              this.thumbnailUrl.set(parsed.thumb);
              return true;
            }
          } catch (e) {
            if (typeof res.metadata === 'string' && res.metadata.startsWith('data:image')) {
              this.thumbnailUrl.set(res.metadata);
              return true;
            }
          }
        }
        return true;
      } catch (e: any) {
        if (e?.message?.includes('too small') && sizeBytes < 2 * 1024 * 1024) {
          return await tryFetchSize(2 * 1024 * 1024);
        }
        console.warn('[PublicMediaPlayer] Erro ao extrair miniatura do cabecalho Kasumi', e);
        return false;
      }
    };

    await tryFetchSize(512 * 1024);
    this.isLoading.set(false);
  }

  protected onThumbnailError() {
    console.warn('[PublicMediaPlayer] Erro ao renderizar elemento <img> da miniatura.');
    this.thumbnailUrl.set(null);
  }

  protected async startVideoStreaming() {
    this.isPlayingVideo.set(true);
  }

  ngOnDestroy() {
    this.videoStreamService.destroyStream();
    if (this.mediaUrl()) {
      URL.revokeObjectURL(this.mediaUrl()!);
    }
  }

  protected async loadImage() {
    this.isLoading.set(true);
    this.error.set(null);

    try {
      const encryptedBlob = await this.shareService.downloadSharedFileInRanges(
        this.shareId(),
        this.sizeBytes() || this.publicDriveFile().sizeBytes
      );
      const rawDecrypted = await this.kasumi.decryptFile(encryptedBlob, this.fdk());
      const mimeType = this.getMimeType(this.filename());
      this.decryptedBlob = new Blob([rawDecrypted], { type: mimeType });

      if (this.mediaUrl()) {
        URL.revokeObjectURL(this.mediaUrl()!);
      }

      const url = URL.createObjectURL(this.decryptedBlob);
      this.mediaUrl.set(url);
      this.isLoading.set(false);
    } catch (err: any) {
      console.error('[PublicMediaPlayer] Erro ao carregar imagem', err);
      const msg = err?.error?.error || 'Falha ao descarregar ou descriptografar a imagem.';
      this.error.set(msg);
      this.isLoading.set(false);
    }
  }

  protected async downloadFile() {
    console.log('[PublicMediaPlayer] Iniciando download...', {
      shareId: this.shareId(),
      sizeBytes: this.sizeBytes(),
      publicDriveFileSize: this.publicDriveFile().sizeBytes,
      hasDecryptedBlob: !!this.decryptedBlob
    });

    if (this.decryptedBlob) {
      console.log('[PublicMediaPlayer] Usando blob em memoria ja descriptografado.');
      const url = URL.createObjectURL(this.decryptedBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = this.filename();
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return;
    }

    this.isDownloading.set(true);
    this.downloadProgress.set(0);
    
    try {
      const total = this.sizeBytes() || this.publicDriveFile().sizeBytes;
      const encryptedBlob = await this.shareService.downloadSharedFileInRanges(
        this.shareId(),
        total,
        (loaded, size) => {
          this.downloadProgress.set(Math.min(99, Math.round((100 * loaded) / size)));
          this.cdr.detectChanges();
        }
      );

      this.downloadProgress.set(null);
      const rawDecrypted = await this.kasumi.decryptFile(encryptedBlob, this.fdk());
      const url = URL.createObjectURL(rawDecrypted);
      const a = document.createElement('a');
      a.href = url;
      a.download = this.filename();
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('[PublicMediaPlayer] Erro no download', e);
    } finally {
      this.isDownloading.set(false);
      this.downloadProgress.set(null);
      this.cdr.detectChanges();
    }
  }

  protected onClose() {
    this.close.emit();
  }

  protected zoomIn() {
    this.currentZoom.update(z => Math.min(3, z + 0.25));
  }

  protected zoomOut() {
    this.currentZoom.update(z => Math.max(0.25, z - 0.25));
  }

  protected resetZoom() {
    this.currentZoom.set(1);
    this.translateX.set(0);
    this.translateY.set(0);
  }

  protected onWheel(event: WheelEvent) {
    if (this.isVideo()) return;
    if (event.deltaY < 0) {
      this.zoomIn();
    } else if (event.deltaY > 0) {
      this.zoomOut();
    }
  }

  protected onMouseDown(event: MouseEvent) {
    if (this.currentZoom() > 1) {
      this.isDragging = true;
      this.dragStartX = event.clientX - this.translateX();
      this.dragStartY = event.clientY - this.translateY();
    }
  }

  protected onMouseMove(event: MouseEvent) {
    if (this.isDragging && this.currentZoom() > 1) {
      this.translateX.set(event.clientX - this.dragStartX);
      this.translateY.set(event.clientY - this.dragStartY);
    }
  }

  protected onMouseUp() {
    this.isDragging = false;
  }

  getMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    switch (ext) {
      case 'mp4': return 'video/mp4';
      case 'webm': return 'video/webm';
      case 'ogv': case 'ogg': return 'video/ogg';
      case 'mov': return 'video/quicktime';
      case 'mkv': return 'video/x-matroska';
      case 'jpg': case 'jpeg': return 'image/jpeg';
      case 'png': return 'image/png';
      case 'gif': return 'image/gif';
      case 'webp': return 'image/webp';
      case 'svg': return 'image/svg+xml';
      case 'bmp': return 'image/bmp';
      default: return 'application/octet-stream';
    }
  }

  getFormattedSize(): string {
    const bytes = this.sizeBytes();
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  @HostListener('window:keydown', ['$event'])
  protected onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      this.onClose();
    }
  }
}
