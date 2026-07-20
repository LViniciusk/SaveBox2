import { Component, input, output, ElementRef, ViewChild, inject, AfterViewInit, OnDestroy, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VideoStreamService } from '../../services/video-stream.service';
import { DriveFile } from '../../state/drive.store';
import { FileIconComponent } from '../../../../shared/ui/file-icon/file-icon.component';

@Component({
  selector: 'app-video-player',
  standalone: true,
  imports: [CommonModule, FileIconComponent],
  template: `
    <div class="player-backdrop" [class.seamless]="seamless()" (click)="!seamless() && onClose()">
      
      @if (!seamless()) {
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
          </div>
        </div>
      }

      @if (!seamless()) {
        <!-- Secondary Toolbar (Left) -->
        <div class="toolbar-left" (click)="$event.stopPropagation()">
          <button class="icon-btn" aria-label="Baixar" (click)="downloadVideo()">
            <span class="material-symbols-outlined">download</span>
          </button>
        </div>
      }

      <!-- Video Wrapper -->
      <div class="video-wrapper">
        <video #videoElement controls playsinline class="video-node" 
               [style.visibility]="isInitialLoad() ? 'hidden' : 'visible'"
               (click)="$event.stopPropagation()"></video>

        <!-- Loading Overlay -->
        @if (isInitialLoad()) {
          <div class="loading-overlay">
            <div class="spinner"></div>
            <div class="loading-text">Carregando player...</div>
          </div>
        }

        <!-- Error Alert Overlay -->
        @if (streamService.error()) {
          <div class="error-overlay">
            <span class="material-symbols-outlined error-icon">error</span>
            <div class="error-text">{{ streamService.error() }}</div>
            <button class="retry-btn" (click)="retryPlayback()">Tentar Novamente</button>
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
        animation: fadeInBackdrop 200ms ease-out;
        display: flex;
        flex-direction: column;
      }
      
      .player-backdrop.seamless {
        background: transparent;
        animation: none;
        pointer-events: none;
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

      .video-wrapper {
        position: absolute;
        top: 135px;
        left: 0;
        width: 100vw;
        height: calc(100vh - 155px);
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        z-index: 1;
        pointer-events: none;
      }

      .video-node, .loading-overlay, .error-overlay, .toolbar-left {
        pointer-events: auto;
      }

      .video-node {
        height: 100vh;
        width: auto;
        max-width: 100%;
        max-height: 100%;
        display: block;
        outline: none;
        transition: opacity 300ms ease;
      }

      .loading-overlay, .error-overlay {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: transparent;
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
        margin-bottom: 16px;
        text-align: center;
        max-width: 80%;
      }

      .retry-btn {
        background: #3b82f6;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 4px;
        font-weight: 500;
        cursor: pointer;
        transition: background 200ms ease;
      }

      .retry-btn:hover {
        background: #2563eb;
      }

      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }

      @keyframes fadeInBackdrop {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      @keyframes scaleInContainer {
        from { opacity: 0; transform: scale(0.95); }
        to { opacity: 1; transform: scale(1); }
      }
    `,
  ],
})
export class VideoPlayerComponent implements OnInit, OnDestroy, AfterViewInit {
  file = input.required<DriveFile>();
  seamless = input<boolean>(false);
  close = output<void>();
  videoReady = output<void>();

  @ViewChild('videoElement') videoElement!: ElementRef<HTMLVideoElement>;

  protected readonly streamService = inject(VideoStreamService);
  readonly isInitialLoad = signal(true);

  ngOnInit() {}

  ngAfterViewInit() {
    this.startStream();
    if (this.videoElement?.nativeElement) {
      this.videoElement.nativeElement.addEventListener('canplay', () => {
        // Wait for at least 5 seconds of buffer (or end of video) before starting playback to avoid early stalls
        const checkBuffer = setInterval(() => {
          const video = this.videoElement.nativeElement;
          if (video.buffered.length > 0) {
            const bufferedEnd = video.buffered.end(video.buffered.length - 1);
            if (bufferedEnd >= 5 || video.duration <= 5) {
              clearInterval(checkBuffer);
              this.isInitialLoad.set(false);
              this.videoReady.emit();
              video.play().catch(e => console.warn('Autoplay prevented by browser', e));
            }
          }
        }, 500);
      }, { once: true });
    }
  }

  ngOnDestroy() {
    this.streamService.destroyStream();
  }

  private startStream() {
    if (this.videoElement) {
      this.streamService.initializeStream(
        this.videoElement.nativeElement,
        this.file()
      );
    }
  }

  retryPlayback() {
    this.startStream();
  }

  downloadVideo() {
    alert('A funcionalidade de baixar vídeos pelo player será adicionada em breve!');
  }

  onClose() {
    this.close.emit();
  }
}
