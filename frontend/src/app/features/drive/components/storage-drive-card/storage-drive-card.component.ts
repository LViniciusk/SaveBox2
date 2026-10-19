import { Component, input, output, signal } from '@angular/core';
import { StorageTarget } from '../../state/drive.types';
import { formatBytes } from '../../../../shared/utils/format-bytes';

@Component({
  selector: 'app-storage-drive-card',
  standalone: true,
  template: `
    <button class="drive-card" [disabled]="target().status !== 'ready'" (click)="opened.emit(target())">
      @if (showPicture()) {
        <img [src]="target().accountPicture" alt="" referrerpolicy="no-referrer" decoding="async" loading="lazy" (error)="onPictureError()" />
      } @else {
        <span class="material-symbols-outlined drive-icon">{{ target().provider === 'local' ? 'hard_drive' : 'cloud' }}</span>
      }
      <span class="drive-details">
        <span class="drive-name">{{ target().label }}</span>
        <span class="capacity"><span [style.width.%]="usedPercent()"></span></span>
        <span class="capacity-label">{{ capacityLabel() }}</span>
        @if (target().provider === 'google_drive') {
          <span class="nanika-usage">Nanika: {{ formatSize(target().nanikaUsedBytes) }}</span>
        }
        @if (target().status !== 'ready') { <span class="unavailable">{{ target().status === 'unlinking' ? 'Desvinculando' : 'Indisponível' }}</span> }
      </span>
    </button>
  `,
  styles: [`
    :host { min-width: 0; }
    .drive-card { width: 100%; min-width: 280px; max-width: 360px; min-height: 92px; display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--default-text); text-align: left; }
    .drive-card:not(:disabled):hover, .drive-card:not(:disabled):focus-visible { background: var(--default-hover); border-color: var(--default-border-strong); outline: 1px solid var(--default-accent); }
    .drive-card:disabled { opacity: .62; }
    .drive-icon { flex: 0 0 52px; font-size: 52px; color: var(--default-muted); }
    img { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; }
    .drive-details { flex: 1; min-width: 0; display: grid; gap: 4px; }
    .drive-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
    .capacity { height: 14px; border: 1px solid var(--default-border-strong); background: var(--default-surface); overflow: hidden; }
    .capacity > span { display: block; height: 100%; background: var(--default-accent); }
    .capacity-label, .nanika-usage, .unavailable { color: var(--default-muted); font-size: 12px; }
    .unavailable { color: var(--danger-color, #ef5350); }
  `],
})
export class StorageDriveCardComponent {
  readonly formatSize = formatBytes;
  readonly target = input.required<StorageTarget>();
  readonly opened = output<StorageTarget>();
  private readonly failedPictureUrl = signal<string | null>(null);

  showPicture(): boolean {
    const picture = this.target().accountPicture?.trim();
    return !!picture && picture !== this.failedPictureUrl();
  }

  onPictureError(): void {
    this.failedPictureUrl.set(this.target().accountPicture?.trim() ?? null);
  }

  usedPercent(): number {
    const max = this.target().maxBytes;
    const used = this.target().usedBytes;
    return max && used !== null ? Math.min((used / max) * 100, 100) : 0;
  }

  capacityLabel(): string {
    const target = this.target();
    if (target.availableBytes === null || target.maxBytes === null) return 'Espaço disponível desconhecido';
    return `${this.formatSize(target.availableBytes)} livre(s) de ${this.formatSize(target.maxBytes)}`;
  }

}
