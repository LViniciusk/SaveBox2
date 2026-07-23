import { Component, input, output, ElementRef, ViewChild, inject, AfterViewInit, OnDestroy, OnInit, signal, computed, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { VideoStreamService } from '../../services/video-stream.service';
import { DriveFile } from '../../state/drive.store';
import { FileIconComponent } from '../../../../shared/ui/file-icon/file-icon.component';

@Component({
  selector: 'app-video-player',
  standalone: true,
  imports: [CommonModule, FileIconComponent],
  template: `
    <div #playerBackdrop
         class="player-backdrop" 
         [class.seamless]="seamless()" 
         [class.is-fullscreen]="isFullscreen()"
         [class.hide-cursor]="!showControls() && isPlaying()"
         (click)="!seamless() && onClose()">
      
      @if (!seamless()) {
        <!-- Top Header Bar -->
        <div class="player-header-bar" [class.hidden]="!showControls() && isPlaying()" (click)="$event.stopPropagation()">
          <div class="header-left">
            <button class="icon-btn" (click)="onClose()" aria-label="Voltar" title="Voltar">
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
        <div class="toolbar-left" [class.hidden]="!showControls() && isPlaying()" (click)="$event.stopPropagation()">
          <button class="icon-btn" aria-label="Baixar" (click)="downloadVideo()" title="Baixar Vídeo">
            <span class="material-symbols-outlined">download</span>
          </button>
        </div>
      }

      <!-- Video Wrapper -->
      <div class="video-wrapper" 
           (mousemove)="onMouseMove($event)"
           (mouseleave)="onMouseLeave()">
        
        <video #videoElement 
               playsinline 
               class="video-node" 
               [style.visibility]="isInitialLoad() ? 'hidden' : 'visible'"
               (click)="onVideoClick($event)"
               (timeupdate)="onTimeUpdate()"
               (loadedmetadata)="onLoadedMetadata()"
               (progress)="updateBuffer()"
               (play)="isPlaying.set(true)"
               (pause)="isPlaying.set(false)"
               (ended)="isPlaying.set(false)"
               (volumechange)="onVolumeChange()"></video>

        <!-- Center Flash Play/Pause Indicator -->
        @if (centerFlashIcon()) {
          <div class="center-flash-indicator">
            <span class="material-symbols-outlined">{{ centerFlashIcon() }}</span>
          </div>
        }

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

        <!-- Minimalist Gradient Custom Controls Bar -->
        @if (!isInitialLoad() && !streamService.error()) {
          <div class="minimal-controls-bar" 
               [class.visible]="showControls() || !isPlaying()"
               [style.width.px]="videoRenderedWidth()"
               (click)="$event.stopPropagation()">
            
            <!-- Progress Bar Slider Row -->
            <div class="progress-container">
              <div class="progress-track-bg">
                <div class="buffer-bar" [style.width.%]="bufferedAmount()"></div>
                <div class="progress-bar-fill" [style.width.%]="progressPercent()"></div>
              </div>
              <div class="progress-thumb-dot" [style.left.%]="progressPercent()"></div>
              <input type="range" 
                     class="progress-slider" 
                     min="0" 
                     [max]="duration() || 100" 
                     step="0.1" 
                     [value]="currentTime()" 
                     (input)="onSeek($event)" />
            </div>

            <!-- Controls Row -->
            <div class="controls-row">
              <div class="controls-group left">
                <!-- Play / Pause -->
                <button class="control-btn" (click)="togglePlay()" [title]="isPlaying() ? 'Pausar (Espaço)' : 'Reproduzir (Espaço)'">
                  <span class="material-symbols-outlined">{{ isPlaying() ? 'pause' : 'play_arrow' }}</span>
                </button>

                <!-- Volume Container -->
                <div class="volume-group" (mouseenter)="isVolumeHovered.set(true)" (mouseleave)="isVolumeHovered.set(false)">
                  <button class="control-btn" (click)="toggleMute()" [title]="isMuted() ? 'Ativar Som (M)' : 'Mutar (M)'">
                    <span class="material-symbols-outlined">{{ getVolumeIcon() }}</span>
                  </button>
                  <div class="volume-slider-wrapper" [class.expanded]="isVolumeHovered()">
                    <input type="range" 
                           class="volume-slider" 
                           min="0" 
                           max="1" 
                           step="0.05" 
                           [value]="isMuted() ? 0 : volume()" 
                           (input)="onVolumeInput($event)" />
                  </div>
                </div>

                <!-- Time Display -->
                <div class="time-display">
                  <span class="current-time">{{ formatTime(currentTime()) }}</span>
                  <span class="time-separator">/</span>
                  <span class="total-time">{{ formatTime(duration()) }}</span>
                </div>
              </div>

              <div class="controls-group right">
                <!-- Picture in Picture -->
                <button class="control-btn" (click)="togglePiP()" title="Picture-in-Picture">
                  <span class="material-symbols-outlined">picture_in_picture_alt</span>
                </button>

                <!-- Settings / Playback Speed Menu -->
                <div class="speed-menu-container">
                  @if (isSpeedMenuOpen()) {
                    <div class="speed-dropdown">
                      @for (speed of [0.5, 0.75, 1, 1.25, 1.5, 2]; track speed) {
                        <button class="speed-option" 
                                [class.active]="playbackSpeed() === speed" 
                                (click)="setSpeed(speed)">
                          {{ speed === 1 ? 'Normal' : speed + 'x' }}
                        </button>
                      }
                    </div>
                  }
                  <button class="control-btn" (click)="isSpeedMenuOpen.set(!isSpeedMenuOpen())" title="Configurações / Velocidade">
                    <span class="material-symbols-outlined">settings</span>
                  </button>
                </div>

                <!-- Fullscreen -->
                <button class="control-btn" (click)="toggleFullscreen()" title="Tela Cheia (F)">
                  <span class="material-symbols-outlined">{{ isFullscreen() ? 'fullscreen_exit' : 'fullscreen' }}</span>
                </button>
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
        animation: fadeInBackdrop 200ms ease-out;
        display: flex;
        flex-direction: column;
      }

      .player-backdrop.hide-cursor {
        cursor: none;
      }
      
      .player-backdrop.seamless {
        background: transparent;
        animation: none;
        pointer-events: none;
      }

      .player-backdrop.is-fullscreen {
        background: #000000;
      }

      .player-backdrop.is-fullscreen .player-header-bar,
      .player-backdrop.is-fullscreen .toolbar-left {
        display: none !important;
      }

      .player-backdrop.is-fullscreen .video-wrapper {
        top: 0 !important;
        height: 100vh !important;
        width: 100vw !important;
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
        transition: opacity 300ms ease;
      }

      .player-header-bar.hidden, .toolbar-left.hidden {
        opacity: 0;
        pointer-events: none;
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
        transition: opacity 300ms ease;
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

      .video-node {
        height: 100vh;
        width: auto;
        max-width: 100%;
        max-height: 100%;
        display: block;
        outline: none;
        transition: opacity 300ms ease;
        pointer-events: auto;
        cursor: pointer;
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

      /* ===== MINIMALIST GRADIENT PLAYER CONTROLS ===== */
      .minimal-controls-bar {
        position: absolute;
        bottom: 0;
        left: 50%;
        transform: translate(-50%, 4px);
        max-width: 100%;
        padding: 28px 24px 14px 24px;
        z-index: 30;
        pointer-events: auto;
        opacity: 0;
        background: linear-gradient(to top, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.4) 60%, rgba(0, 0, 0, 0) 100%);
        transition: opacity 250ms ease, transform 250ms ease;
        display: flex;
        flex-direction: column;
        gap: 8px;
        box-sizing: border-box;
      }

      .minimal-controls-bar.visible {
        opacity: 1;
        transform: translate(-50%, 0);
      }

      /* Progress Bar Area */
      .progress-container {
        position: relative;
        width: 100%;
        height: 14px;
        display: flex;
        align-items: center;
        cursor: pointer;
      }

      .progress-track-bg {
        position: absolute;
        left: 0;
        top: 5px;
        width: 100%;
        height: 3px;
        background: rgba(255, 255, 255, 0.25);
        border-radius: 2px;
        transition: height 150ms ease, top 150ms ease;
      }

      .progress-container:hover .progress-track-bg {
        height: 5px;
        top: 4px;
      }

      .buffer-bar {
        position: absolute;
        left: 0;
        top: 0;
        height: 100%;
        background: rgba(255, 255, 255, 0.35);
        border-radius: 2px;
        transition: width 200ms linear;
      }

      .progress-bar-fill {
        position: absolute;
        left: 0;
        top: 0;
        height: 100%;
        background: #38bdf8;
        border-radius: 2px;
      }

      /* Thumb Dot */
      .progress-thumb-dot {
        position: absolute;
        top: 50%;
        transform: translate(-50%, -50%) scale(0);
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #ffffff;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
        transition: transform 150ms ease;
        z-index: 4;
        pointer-events: none;
      }

      .progress-container:hover .progress-thumb-dot,
      .progress-container:active .progress-thumb-dot {
        transform: translate(-50%, -50%) scale(1);
      }

      .progress-slider {
        position: absolute;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        opacity: 0;
        cursor: pointer;
        z-index: 5;
        margin: 0;
      }

      /* Controls Row */
      .controls-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
      }

      .controls-group {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .control-btn {
        background: transparent;
        border: none;
        color: #ffffff;
        cursor: pointer;
        width: 34px;
        height: 34px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: color 150ms ease, opacity 150ms ease;
        opacity: 0.9;
      }

      .control-btn:hover {
        opacity: 1;
        color: #38bdf8;
      }

      .control-btn .material-symbols-outlined {
        font-size: 22px;
      }

      /* Volume Group */
      .volume-group {
        display: flex;
        align-items: center;
        position: relative;
      }

      .volume-slider-wrapper {
        width: 0;
        overflow: hidden;
        transition: width 200ms ease, opacity 200ms ease;
        opacity: 0;
        display: flex;
        align-items: center;
      }

      .volume-group:hover .volume-slider-wrapper,
      .volume-slider-wrapper.expanded {
        width: 65px;
        opacity: 1;
        margin-left: 2px;
      }

      .volume-slider {
        width: 55px;
        height: 3px;
        accent-color: #38bdf8;
        cursor: pointer;
      }

      /* Time Display */
      .time-display {
        font-family: 'Inter', system-ui, -apple-system, sans-serif;
        font-size: 12px;
        font-weight: 500;
        color: #ffffff;
        display: flex;
        align-items: center;
        gap: 4px;
        margin-left: 8px;
        user-select: none;
        letter-spacing: 0.2px;
      }

      .time-separator {
        opacity: 0.6;
      }

      /* Settings / Speed Menu */
      .speed-menu-container {
        position: relative;
      }

      .speed-dropdown {
        position: absolute;
        bottom: 42px;
        right: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 6px;
        min-width: 100px;
        z-index: 40;
        background: rgba(15, 23, 42, 0.9);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      }

      .speed-option {
        background: transparent;
        border: none;
        color: #cbd5e1;
        font-family: 'Inter', sans-serif;
        font-size: 12px;
        font-weight: 500;
        padding: 6px 12px;
        border-radius: 6px;
        cursor: pointer;
        text-align: left;
        transition: background 150ms ease, color 150ms ease;
      }

      .speed-option:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #ffffff;
      }

      .speed-option.active {
        background: #0ea5e9;
        color: #ffffff;
        font-weight: 600;
      }

      /* Center Flash Play/Pause Animation */
      .center-flash-indicator {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 80px;
        height: 80px;
        border-radius: 50%;
        background: rgba(15, 23, 42, 0.4);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        border: 1px solid rgba(255, 255, 255, 0.15);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #ffffff;
        pointer-events: none;
        z-index: 20;
        animation: flashPop 500ms ease-out forwards;
      }

      .center-flash-indicator .material-symbols-outlined {
        font-size: 44px;
      }

      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }

      @keyframes fadeInBackdrop {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      @keyframes flashPop {
        0% { opacity: 0; transform: translate(-50%, -50%) scale(0.6); }
        50% { opacity: 1; transform: translate(-50%, -50%) scale(1.1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(1.3); }
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
  @ViewChild('playerBackdrop') playerBackdrop!: ElementRef<HTMLDivElement>;

  protected readonly streamService = inject(VideoStreamService);
  readonly isInitialLoad = signal(true);
  
  // Custom Controls State
  readonly isPlaying = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly bufferedAmount = signal(0);
  readonly volume = signal(1);
  readonly isMuted = signal(false);
  readonly isFullscreen = signal(false);
  readonly showControls = signal(true);
  readonly isVolumeHovered = signal(false);
  readonly playbackSpeed = signal(1);
  readonly isSpeedMenuOpen = signal(false);
  readonly centerFlashIcon = signal<string | null>(null);
  readonly videoRenderedWidth = signal<number | null>(null);

  private idleTimer: any = null;
  private flashTimeout: any = null;

  readonly progressPercent = computed(() => {
    const dur = this.duration();
    if (!dur || dur <= 0) return 0;
    return Math.min(100, Math.max(0, (this.currentTime() / dur) * 100));
  });

  ngOnInit() {}

  ngAfterViewInit() {
    this.startStream();
    if (this.videoElement?.nativeElement) {
      this.videoElement.nativeElement.addEventListener('canplay', () => {
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
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.flashTimeout) clearTimeout(this.flashTimeout);
  }

  @HostListener('window:keydown', ['$event'])
  handleKeyDown(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    switch (event.key.toLowerCase()) {
      case ' ':
      case 'k':
        event.preventDefault();
        this.togglePlay();
        this.triggerCenterFlash(this.isPlaying() ? 'play_arrow' : 'pause');
        break;
      case 'f':
        event.preventDefault();
        this.toggleFullscreen();
        break;
      case 'm':
        event.preventDefault();
        this.toggleMute();
        break;
      case 'arrowleft':
      case 'j':
        event.preventDefault();
        this.skip(-5);
        break;
      case 'arrowright':
      case 'l':
        event.preventDefault();
        this.skip(5);
        break;
      case 'arrowup':
        event.preventDefault();
        this.changeVolume(0.1);
        break;
      case 'arrowdown':
        event.preventDefault();
        this.changeVolume(-0.1);
        break;
    }
  }

  @HostListener('document:fullscreenchange')
  onFullscreenChange() {
    const isFS = !!document.fullscreenElement;
    this.isFullscreen.set(isFS);
    setTimeout(() => {
      this.updateVideoDimensions();
    }, 100);
  }

  onMouseMove(event?: MouseEvent) {
    if (event && this.videoElement?.nativeElement) {
      const rect = this.videoElement.nativeElement.getBoundingClientRect();
      const x = event.clientX;
      const y = event.clientY;
      const isInsideVideoOrControls = (
        x >= rect.left - 20 &&
        x <= rect.right + 20 &&
        y >= rect.top - 20 &&
        y <= rect.bottom + 20
      );

      if (!isInsideVideoOrControls && this.isPlaying()) {
        this.showControls.set(false);
        this.isSpeedMenuOpen.set(false);
        return;
      }
    }

    this.showControls.set(true);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.isPlaying()) {
      this.idleTimer = setTimeout(() => {
        this.showControls.set(false);
        this.isSpeedMenuOpen.set(false);
      }, 2500);
    }
  }

  onMouseLeave() {
    if (this.isPlaying()) {
      this.showControls.set(false);
      this.isSpeedMenuOpen.set(false);
    }
  }

  onVideoClick(event: MouseEvent) {
    event.stopPropagation();
    this.togglePlay();
    this.triggerCenterFlash(this.isPlaying() ? 'play_arrow' : 'pause');
  }

  triggerCenterFlash(icon: string) {
    this.centerFlashIcon.set(icon);
    if (this.flashTimeout) clearTimeout(this.flashTimeout);
    this.flashTimeout = setTimeout(() => {
      this.centerFlashIcon.set(null);
    }, 500);
  }

  @HostListener('window:resize')
  updateVideoDimensions() {
    if (this.videoElement?.nativeElement) {
      const rect = this.videoElement.nativeElement.getBoundingClientRect();
      if (rect.width > 0) {
        this.videoRenderedWidth.set(rect.width);
      }
    }
  }

  onVolumeChange() {
    if (!this.videoElement?.nativeElement) return;
    const video = this.videoElement.nativeElement;
    this.volume.set(video.volume);
    this.isMuted.set(video.muted);
  }

  onTimeUpdate() {
    if (!this.videoElement?.nativeElement) return;
    const video = this.videoElement.nativeElement;
    this.currentTime.set(video.currentTime);
    this.updateBuffer();
    if (!this.videoRenderedWidth()) {
      this.updateVideoDimensions();
    }
  }

  onLoadedMetadata() {
    if (!this.videoElement?.nativeElement) return;
    const video = this.videoElement.nativeElement;
    this.duration.set(video.duration || 0);
    this.volume.set(video.volume);
    this.isMuted.set(video.muted);
    this.updateVideoDimensions();
  }

  updateBuffer() {
    if (!this.videoElement?.nativeElement) return;
    const video = this.videoElement.nativeElement;
    if (video.buffered.length > 0) {
      const end = video.buffered.end(video.buffered.length - 1);
      const dur = video.duration || 1;
      this.bufferedAmount.set(Math.min(100, (end / dur) * 100));
    }
  }

  togglePlay() {
    if (!this.videoElement?.nativeElement) return;
    const video = this.videoElement.nativeElement;
    if (video.paused) {
      video.play().catch(e => console.warn('Play error:', e));
    } else {
      video.pause();
    }
  }

  onSeek(event: Event) {
    const input = event.target as HTMLInputElement;
    const time = parseFloat(input.value);
    if (this.videoElement?.nativeElement) {
      this.videoElement.nativeElement.currentTime = time;
      this.currentTime.set(time);
    }
  }

  skip(seconds: number) {
    if (!this.videoElement?.nativeElement) return;
    const video = this.videoElement.nativeElement;
    const newTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds));
    video.currentTime = newTime;
    this.currentTime.set(newTime);
  }

  onVolumeInput(event: Event) {
    const input = event.target as HTMLInputElement;
    const val = parseFloat(input.value);
    this.changeVolumeTo(val);
  }

  changeVolume(delta: number) {
    const newVol = Math.max(0, Math.min(1, this.volume() + delta));
    this.changeVolumeTo(newVol);
  }

  changeVolumeTo(val: number) {
    if (!this.videoElement?.nativeElement) return;
    const video = this.videoElement.nativeElement;
    video.volume = val;
    video.muted = val === 0;
    this.volume.set(val);
    this.isMuted.set(val === 0);
  }

  toggleMute() {
    if (!this.videoElement?.nativeElement) return;
    const video = this.videoElement.nativeElement;
    video.muted = !video.muted;
    this.isMuted.set(video.muted);
  }

  getVolumeIcon(): string {
    if (this.isMuted() || this.volume() === 0) return 'volume_off';
    if (this.volume() < 0.5) return 'volume_down';
    return 'volume_up';
  }

  setSpeed(speed: number) {
    if (this.videoElement?.nativeElement) {
      this.videoElement.nativeElement.playbackRate = speed;
      this.playbackSpeed.set(speed);
      this.isSpeedMenuOpen.set(false);
    }
  }

  toggleFullscreen() {
    const elem = this.playerBackdrop?.nativeElement || document.documentElement;
    if (!document.fullscreenElement) {
      elem.requestFullscreen().catch(err => console.warn('Fullscreen error:', err));
    } else {
      document.exitFullscreen().catch(err => console.warn('Exit fullscreen error:', err));
    }
  }

  togglePiP() {
    if (!this.videoElement?.nativeElement) return;
    const video = this.videoElement.nativeElement;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(e => console.warn(e));
    } else if (document.pictureInPictureEnabled) {
      video.requestPictureInPicture().catch(e => console.warn(e));
    }
  }

  formatTime(val: number): string {
    if (isNaN(val) || !isFinite(val) || val < 0) return '0:00';
    const h = Math.floor(val / 3600);
    const m = Math.floor((val % 3600) / 60);
    const s = Math.floor(val % 60);
    const sStr = s.toString().padStart(2, '0');
    if (h > 0) {
      const mStr = m.toString().padStart(2, '0');
      return `${h}:${mStr}:${sStr}`;
    }
    return `${m}:${sStr}`;
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
