import { Component } from '@angular/core';

@Component({
  selector: 'app-default-locked-preview',
  standalone: true,
  template: '<span class="material-symbols-outlined default-locked-preview__icon" aria-hidden="true">lock</span>',
  host: {
    class: 'default-locked-preview',
    'aria-hidden': 'true',
  },
  styles: [`
    :host {
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      display: grid;
      place-items: center;
      border: 1px solid var(--default-grid-preview-border, #555);
      background: var(--default-grid-preview-bg, #141414);
      overflow: hidden;
    }

    .default-locked-preview__icon {
      color: var(--default-workspace-muted, #9aa0a6);
      font-size: var(--default-lock-size, 32px);
      line-height: 1;
      pointer-events: none;
    }
  `],
})
export class DefaultLockedPreviewComponent {}
