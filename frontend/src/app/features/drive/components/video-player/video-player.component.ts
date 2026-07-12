import { Component, input, output, ElementRef, ViewChild, inject, AfterViewInit, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VideoStreamService } from '../../services/video-stream.service';
import { DriveFile } from '../../state/drive.store';

@Component({
  selector: 'app-video-player',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="player-backdrop" (click)="onClose()">
      <div class="player-container" (click)="$event.stopPropagation()">
        
        <!-- Header / Title -->
        <div class="player-header">
          <span class="file-title">{{ file().decryptedName || file().encryptedName }}</span>
          <button class="close-btn" (click)="onClose()" aria-label="Fechar player">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>

        <!-- Video Display Container -->
        <div class="video-wrapper">
          <video #videoElement controls autoplay playsinline class="video-node"></video>



          <!-- Error Alert Overlay -->
          @if (streamService.error()) {
            <div class="error-overlay">
              <span class="material-symbols-outlined error-icon">error</span>
              <div class="error-text">{{ streamService.error() }}</div>
              <button class="retry-btn" (click)="retryPlayback()">Tentar Novamente</button>
            </div>
          }
        </div>

        <!-- Footer Warning for High Bitrate -->
        @if (streamService.originalBitrateWarning()) {
          <div class="bitrate-warning">
            <span class="material-symbols-outlined warning-icon">warning</span>
            <span class="warning-text">
              Qualidade Original Direta (O carregamento depende da sua conexao atual)
            </span>
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
        background: rgba(15, 23, 42, 0.85);
        backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 3000;
        animation: fadeInBackdrop 200ms ease-out;
      }

      .player-container {
        background: #1e293b;
        border-radius: 16px;
        box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.4);
        width: 90%;
        max-width: 960px;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.1);
        display: flex;
        flex-direction: column;
        animation: scaleInContainer 250ms cubic-bezier(0.34, 1.56, 0.64, 1);
      }

      .player-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px 24px;
        background: #0f172a;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }

      .file-title {
        color: #f8fafc;
        font-family: 'Outfit', 'Inter', sans-serif;
        font-size: 16px;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 80%;
      }

      .close-btn {
        background: transparent;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        padding: 4px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 200ms, color 200ms;
      }

      .close-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #f1f5f9;
      }

      .video-wrapper {
        position: relative;
        background: #000000;
        aspect-ratio: 16 / 9;
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .video-node {
        width: 100%;
        height: 100%;
        display: block;
        outline: none;
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

      .bitrate-warning {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 24px;
        background: #78350f;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
      }

      .warning-icon {
        color: #fbbf24;
        font-size: 20px;
      }

      .warning-text {
        color: #fef3c7;
        font-family: 'Inter', sans-serif;
        font-size: 13px;
        font-weight: 400;
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
export class VideoPlayerComponent implements AfterViewInit, OnDestroy {
  readonly file = input.required<DriveFile>();
  readonly close = output<void>();

  @ViewChild('videoElement') videoElement!: ElementRef<HTMLVideoElement>;

  protected readonly streamService = inject(VideoStreamService);

  ngAfterViewInit() {
    this.startStream();
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

  onClose() {
    this.close.emit();
  }
}
