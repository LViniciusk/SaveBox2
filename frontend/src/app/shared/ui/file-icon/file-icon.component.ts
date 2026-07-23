import { Component, input, computed } from '@angular/core';

/**
 * Renders the appropriate Material Symbols icon based on file type.
 * When locked, all files show a lock icon in muted gray.
 */
@Component({
  selector: 'app-file-icon',
  template: `<span class="material-symbols-outlined file-icon" [class]="iconClass()" [class.filled]="locked()">{{ iconName() }}</span>`,
  styles: [
    `
      .file-icon {
        font-size: 24px;
        user-select: none;
        transition: color 250ms cubic-bezier(0.4, 0, 0.2, 1);
      }

      .file-icon.filled {
        font-variation-settings: 'FILL' 1;
      }

      .file-icon.folder {
        color: #5f6368;
        font-variation-settings: 'FILL' 1;
      }
      .file-icon.pdf {
        color: #ea4335;
      }
      .file-icon.image {
        color: #ea4335;
      }
      .file-icon.doc {
        color: #4285f4;
      }
      .file-icon.spreadsheet {
        color: #34a853;
      }
      .file-icon.video {
        color: #ea4335;
      }
      .file-icon.audio {
        color: #ff6d00;
      }
      .file-icon.locked {
        color: #9aa0a6;
      }
      .file-icon.default {
        color: #5f6368;
      }
    `,
  ],
})
export class FileIconComponent {
  readonly fileType = input.required<string>();
  readonly locked = input(false);

  readonly iconName = computed(() => {
    if (this.locked()) return 'lock';

    const typeMap: Record<string, string> = {
      folder: 'folder',
      pdf: 'picture_as_pdf',
      image: 'image',
      doc: 'description',
      spreadsheet: 'table_chart',
      video: 'movie',
      audio: 'audio_file',
    };

    return typeMap[this.fileType()] ?? 'insert_drive_file';
  });

  readonly iconClass = computed(() => {
    if (this.locked()) return 'locked';
    return this.fileType();
  });
}
