import { CommonModule } from '@angular/common';
import { Component, ElementRef, OnDestroy, effect, inject, input, output, signal, ViewChild } from '@angular/core';
import { DriveFile } from '../../state/drive.store';
import { DecryptedMediaLoaderService, DecryptedMediaResource } from '../../services/decrypted-media-loader.service';

@Component({
  selector: 'app-audio-player',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="audio-player-backdrop" (click)="requestClose()">
      <section class="audio-player-card" (click)="$event.stopPropagation()" aria-label="Reprodutor de áudio">
        <header class="audio-player-header">
          <div class="audio-player-title" [title]="file().decryptedName || file().encryptedName">
            <span class="material-symbols-outlined" aria-hidden="true">audio_file</span>
            <span>{{ file().decryptedName || file().encryptedName }}</span>
          </div>
          <button type="button" class="audio-player-close" aria-label="Fechar" (click)="requestClose()">
            <span class="material-symbols-outlined">close</span>
          </button>
        </header>

        <div class="audio-player-body">
          @if (isLoading()) {
            <p class="audio-player-status">Carregando e descriptografando...</p>
          } @else if (audioUrl()) {
            <audio #audio controls preload="metadata" (error)="onMediaError($event)">
              <source [src]="audioUrl()" [attr.type]="audioMimeType()" />
              Seu navegador não suporta áudio HTML5.
            </audio>
            @if (error()) {
              <p class="audio-player-status audio-player-error">{{ error() }}</p>
              <button type="button" class="audio-player-download" (click)="downloadRequested.emit()">Baixar arquivo</button>
            }
          } @else if (error(); as message) {
            <p class="audio-player-status audio-player-error">{{ message }}</p>
            <button type="button" class="audio-player-download" (click)="downloadRequested.emit()">Baixar arquivo</button>
          }
        </div>
      </section>
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 3000; }
    :host(.embedded), :host(.embedded-audio-player) { position: static; inset: auto; z-index: auto; display: block; width: min(560px, calc(100vw - 32px)); max-width: 100%; }
    .audio-player-backdrop { width: 100%; height: 100%; display: grid; place-items: center; background: rgba(15, 23, 42, .82); }
    :host(.embedded) .audio-player-backdrop, :host(.embedded-audio-player) .audio-player-backdrop { height: auto; background: transparent; }
    .audio-player-card { width: min(560px, calc(100vw - 32px)); background: var(--surface, #fff); color: var(--text-primary, #202124); border-radius: 12px; box-shadow: 0 18px 48px rgba(0,0,0,.35); overflow: hidden; }
    .audio-player-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border-bottom: 1px solid var(--border-color, #dadce0); }
    .audio-player-title { display: flex; align-items: center; gap: 8px; min-width: 0; font-weight: 500; }
    .audio-player-title span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .audio-player-close { display: grid; place-items: center; border: 0; background: transparent; color: inherit; cursor: pointer; border-radius: 50%; padding: 6px; }
    .audio-player-close:hover { background: rgba(127, 127, 127, .15); }
    .audio-player-body { padding: 28px 20px; }
    audio { width: 100%; }
    .audio-player-status { margin: 0; text-align: center; color: var(--text-secondary, #5f6368); }
    .audio-player-error { color: #b3261e; }
    .audio-player-download { display: block; margin: 16px auto 0; padding: 8px 14px; border: 1px solid var(--border-color, #dadce0); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
    :host-context(:root[data-theme='default']) .audio-player-card { background: var(--default-workspace-surface); border: 1px solid var(--default-workspace-border); border-radius: var(--default-workspace-radius); color: var(--default-workspace-text); }
    :host-context(:root[data-theme='default']) .audio-player-header { border-color: var(--default-workspace-border); }
    :host-context(:root[data-theme='default']) .audio-player-status { color: var(--default-workspace-muted); }
  `],
})
export class AudioPlayerComponent implements OnDestroy {
  readonly file = input.required<DriveFile>();
  readonly close = output<void>();
  readonly downloadRequested = output<void>();
  readonly audioUrl = signal<string | null>(null);
  readonly audioMimeType = signal<string | null>(null);
  readonly isLoading = signal(false);
  readonly error = signal<string | null>(null);
  readonly diagnostics = signal<{ code: number; networkState: number; readyState: number; mimeType: string; canPlayType: string } | null>(null);

  @ViewChild('audio') set audioRef(ref: ElementRef<HTMLAudioElement> | undefined) {
    this.audio = ref;
    if (!ref || !this.audioUrl()) return;
    const element = ref.nativeElement;
    element.load();
    if (this.audioMimeType() && !element.canPlayType(this.audioMimeType()!)) {
      this.error.set(`Seu navegador não declara suporte para ${this.audioMimeType()}.`);
    }
  }
  private audio?: ElementRef<HTMLAudioElement>;
  private readonly mediaLoader = inject(DecryptedMediaLoaderService);
  private resource: DecryptedMediaResource | null = null;
  private loadController: AbortController | null = null;
  private loadGeneration = 0;

  constructor() {
    effect(() => {
      void this.load(this.file());
    });
  }

  ngOnDestroy(): void {
    this.loadController?.abort();
    this.clearAudioElement();
    this.releaseResource();
  }

  requestClose(): void {
    this.loadController?.abort();
    this.clearAudioElement();
    this.releaseResource();
    this.close.emit();
  }

  onMediaError(event: Event): void {
    const element = event.target as HTMLMediaElement | null;
    const mediaError = element?.error;
    const mimeType = this.audioMimeType() ?? '';
    this.diagnostics.set({
      code: mediaError?.code ?? 0,
      networkState: element?.networkState ?? 0,
      readyState: element?.readyState ?? 0,
      mimeType,
      canPlayType: mimeType && element ? element.canPlayType(mimeType) : '',
    });
    const messages: Record<number, string> = {
      1: 'A reprodução foi interrompida.',
      2: 'O áudio não pôde ser carregado pela rede.',
      3: 'O navegador não conseguiu decodificar este áudio.',
      4: 'O formato ou codec deste áudio não é suportado pelo navegador.',
    };
    this.error.set(messages[mediaError?.code ?? 0] ?? 'Não foi possível reproduzir este áudio.');
  }

  private async load(file: DriveFile): Promise<void> {
    const generation = ++this.loadGeneration;
    this.loadController?.abort();
    this.loadController = new AbortController();
    this.clearAudioElement();
    this.releaseResource();
    this.audioUrl.set(null);
    this.audioMimeType.set(null);
    this.error.set(null);
    this.diagnostics.set(null);
    this.isLoading.set(true);
    try {
      const resource = await this.mediaLoader.load(file, this.loadController.signal);
      if (generation !== this.loadGeneration) {
        resource.cleanup();
        return;
      }
      this.resource = resource;
      this.audioMimeType.set(resource.mimeType);
      this.audioUrl.set(resource.url);
    } catch {
      if (generation === this.loadGeneration && !this.loadController.signal.aborted) this.error.set('Não foi possível carregar este áudio.');
    } finally {
      if (generation === this.loadGeneration) this.isLoading.set(false);
    }
  }

  private releaseResource(): void {
    this.resource?.cleanup();
    this.resource = null;
  }

  private clearAudioElement(): void {
    const element = this.audio?.nativeElement;
    if (!element) return;
    element.pause();
    element.removeAttribute('src');
    element.querySelectorAll('source').forEach(source => source.removeAttribute('src'));
    element.load();
  }
}
