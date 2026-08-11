import { Component, computed, input, output, signal } from '@angular/core';
import { DriveFile } from '../../state/drive.store';
import { StorageTarget } from '../../state/drive.types';
import { formatBytes } from '../../../../shared/utils/format-bytes';

@Component({
  selector: 'app-storage-target-picker',
  standalone: true,
  template: `
    <div class="backdrop" (click)="cancelled.emit()">
      <section class="picker" role="dialog" aria-modal="true" aria-labelledby="move-title" (click)="$event.stopPropagation()">
        <h2 id="move-title">Mover para...</h2>
        <p><strong>{{ file().decryptedName || file().encryptedName }}</strong> · {{ file().sizeFormatted }}</p>
        <p class="route">{{ sourceLabel() }} → {{ selected()?.label || 'Escolha um destino' }}</p>
        @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
        @if (loadingTargets()) { <p aria-live="polite">Atualizando destinos...</p> }
        <div class="targets" role="radiogroup" aria-label="Armazenamento de destino">
          @for (target of targets(); track target.key) {
            <button role="radio" [attr.aria-checked]="selected()?.key === target.key" [class.selected]="selected()?.key === target.key"
                    [disabled]="busy() || loadingTargets() || disabled(target)" (click)="selected.set(target)">
              <span class="material-symbols-outlined">{{ target.provider === 'local' ? 'hard_drive' : 'cloud' }}</span>
              <span>{{ target.label }}</span>
              <small>{{ reason(target) }}</small>
            </button>
          }
        </div>
        <p class="notice">O ciphertext será transferido em partes. O arquivo original permanece disponível até a validação do destino.</p>
        <footer><button [disabled]="busy()" (click)="cancelled.emit()">Cancelar</button><button class="primary" [disabled]="busy() || loadingTargets() || !selected()" (click)="confirm()">{{ busy() ? 'Movendo...' : 'Mover' }}</button></footer>
      </section>
    </div>
  `,
  styles: [`
    .backdrop { position: fixed; inset: 0; z-index: 2000; display: grid; place-items: center; padding: 20px; background: #0008; }
    .picker { width: min(520px, 100%); max-height: 80vh; overflow: auto; padding: 18px; border: 1px solid var(--default-context-border); border-radius: 8px; background: var(--default-context-bg); color: var(--default-context-text); box-shadow: 0 20px 50px #000a; }
    h2 { margin: 0 0 10px; font-size: 18px; } p { color: var(--default-muted); font-size: 13px; } .route { color: var(--default-text); }
    .targets { display: grid; gap: 6px; margin: 14px 0; }
    .targets button { display: grid; grid-template-columns: 28px minmax(0,1fr); gap: 2px 8px; align-items: center; padding: 9px; border: 1px solid var(--default-border); border-radius: 4px; background: transparent; color: inherit; text-align: left; }
    .targets button:not(:disabled):hover, .targets button.selected { background: var(--default-hover); border-color: var(--default-accent); }
    .targets button:disabled { opacity: .5; } .targets small { grid-column: 2; color: var(--default-muted); }
    .notice { padding: 8px; background: var(--default-surface); border-radius: 4px; }
    .error { color: var(--default-danger, #c42b1c); }
    footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; } footer button { padding: 7px 14px; border: 1px solid var(--default-border-strong); border-radius: 4px; background: var(--default-surface); color: inherit; } footer .primary { background: var(--default-accent); color: white; }
  `],
})
export class StorageTargetPickerComponent {
  readonly formatSize = formatBytes;
  readonly file = input.required<DriveFile>();
  readonly targets = input.required<readonly StorageTarget[]>();
  readonly confirmed = output<StorageTarget>();
  readonly cancelled = output<void>();
  readonly busy = input(false);
  readonly loadingTargets = input(false);
  readonly error = input<string | null>(null);
  readonly selected = signal<StorageTarget | null>(null);
  readonly sourceLabel = computed(() => this.file().storageProvider === 'local'
    ? 'Local'
    : this.targets().find(target => target.externalStorageId === this.file().externalStorageId)?.label ?? 'Google Drive');

  disabled(target: StorageTarget): boolean {
    return target.status !== 'ready' || this.isCurrent(target) ||
      (target.availableBytes !== null && target.availableBytes < this.requiredBytes());
  }

  reason(target: StorageTarget): string {
    if (this.isCurrent(target)) return 'Armazenamento atual';
    if (target.status !== 'ready') return target.status === 'unlinking' ? 'Desvinculando' : 'Indisponível';
    if (target.availableBytes !== null && target.availableBytes < this.requiredBytes()) return 'Espaço insuficiente';
    return target.availableBytes === null ? 'Espaço disponível desconhecido' : `${this.formatSize(target.availableBytes)} disponíveis`;
  }

  confirm(): void { const target = this.selected(); if (!this.busy() && !this.loadingTargets() && target && !this.disabled(target)) this.confirmed.emit(target); }

  private isCurrent(target: StorageTarget): boolean {
    return target.provider === this.file().storageProvider && target.externalStorageId === this.file().externalStorageId;
  }

  private requiredBytes(): number { return this.file().sizeBytes + (this.file().proxySizeBytes ?? 0); }

}
