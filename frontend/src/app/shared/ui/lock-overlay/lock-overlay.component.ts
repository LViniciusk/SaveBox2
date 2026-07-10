import { Component } from '@angular/core';

/**
 * Frosted glass overlay that blocks interaction with the file list
 * when the vault is in the Locked state.
 *
 * Uses content projection (<ng-content>) so the parent can place
 * the UnlockModalComponent (or any other unlock UI) inside.
 *
 * Usage:
 * <app-lock-overlay>
 *   <app-unlock-modal />
 * </app-lock-overlay>
 */
@Component({
  selector: 'app-lock-overlay',
  template: `
    <div class="lock-overlay">
      <ng-content />
    </div>
  `,
  styles: [
    `
      .lock-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(255, 255, 255, 0.45);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        z-index: 100;
        border-radius: 16px;
        animation: overlayFadeIn 350ms cubic-bezier(0.4, 0, 0.2, 1);
      }

      @keyframes overlayFadeIn {
        from {
          opacity: 0;
          backdrop-filter: blur(0);
        }
        to {
          opacity: 1;
          backdrop-filter: blur(12px);
        }
      }
    `,
  ],
})
export class LockOverlayComponent {}
