import { Component, input, output } from '@angular/core';
import type { FileSortColumn } from './file-list-sort';

@Component({
  selector: 'app-file-sort-menu',
  standalone: true,
  template: `
    <div class="sort-menu-dropdown" [style.position]="'fixed'" [style.top.px]="position()?.y" [style.left.px]="position()?.x" [style.z-index]="9999" (click)="$event.stopPropagation()">
      <div class="sort-section-title">Ordenar por</div>
      @for (option of columns; track option.value) {
        <button class="menu-item" (click)="columnChange.emit(option.value)">
          <span class="material-symbols-outlined check-icon">{{ column() === option.value ? 'check' : '' }}</span>{{ option.label }}
        </button>
      }
      <div class="sort-divider"></div>
      <div class="sort-section-title">Ordem</div>
      <button class="menu-item" (click)="directionChange.emit('asc')"><span class="material-symbols-outlined check-icon">{{ direction() === 'asc' ? 'check' : '' }}</span>{{ directionLabel('asc') }}</button>
      <button class="menu-item" (click)="directionChange.emit('desc')"><span class="material-symbols-outlined check-icon">{{ direction() === 'desc' ? 'check' : '' }}</span>{{ directionLabel('desc') }}</button>
      <div class="sort-divider"></div>
      <div class="sort-section-title">Pastas</div>
      <button class="menu-item" (click)="foldersModeChange.emit('top')"><span class="material-symbols-outlined check-icon">{{ foldersMode() === 'top' ? 'check' : '' }}</span>No topo</button>
      <button class="menu-item" (click)="foldersModeChange.emit('mixed')"><span class="material-symbols-outlined check-icon">{{ foldersMode() === 'mixed' ? 'check' : '' }}</span>Misturado com arquivos</button>
    </div>
  `,
  styles: [`
    .sort-menu-dropdown { background: white; border: 1px solid #dadce0; border-radius: 4px; box-shadow: 0 4px 6px rgba(0,0,0,.1); padding: 8px 0; min-width: 200px; display: flex; flex-direction: column; }
    .menu-item { background: transparent; border: none; padding: 10px 16px; text-align: left; font-size: 14px; color: #3c4043; cursor: pointer; display: flex; align-items: center; gap: 12px; width: 100%; }
    .menu-item:hover { background: #f1f3f4; color: #202124; }
    .check-icon { font-size: 18px; width: 24px; display: flex; align-items: center; justify-content: center; margin-right: 8px; }
    .sort-section-title { padding: 4px 40px; font-size: 12px; color: #5f6368; font-weight: 500; }
    .sort-divider { height: 1px; background: #e8eaed; margin: 8px 0; }
  `]
})
export class FileSortMenuComponent {
  readonly position = input<{ x: number; y: number } | null>(null);
  readonly column = input<FileSortColumn>('name');
  readonly direction = input<'asc' | 'desc'>('asc');
  readonly foldersMode = input<'top' | 'mixed'>('top');

  readonly columnChange = output<FileSortColumn>();
  readonly directionChange = output<'asc' | 'desc'>();
  readonly foldersModeChange = output<'top' | 'mixed'>();

  readonly columns: readonly { value: FileSortColumn; label: string }[] = [
    { value: 'name', label: 'Nome' },
    { value: 'modified', label: 'Data de modificação' },
    { value: 'size', label: 'Tamanho' },
  ];

  directionLabel(direction: 'asc' | 'desc'): string {
    if (this.column() === 'name') return direction === 'asc' ? 'A a Z' : 'Z a A';
    if (this.column() === 'size') return direction === 'asc' ? 'Menor pro maior' : 'Maior pro menor';
    return direction === 'asc' ? 'Mais antigo pro mais recente' : 'Mais recente pro mais antigo';
  }
}
