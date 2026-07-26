import { Directive, HostBinding, HostListener, OnDestroy, inject, input, output, signal } from '@angular/core';
import { DataTransferReaderService, DroppedItems } from '../services/data-transfer-reader.service';

@Directive({ selector: '[appDriveDropZone]', standalone: true })
export class DriveDropZoneDirective implements OnDestroy {
  private readonly reader = inject(DataTransferReaderService);
  readonly enabled = input(true, { alias: 'dropZoneEnabled' });
  readonly locked = input(false, { alias: 'dropZoneLocked' });
  readonly dropStarted = output<void>();
  readonly dropped = output<DroppedItems>();
  readonly dropError = output<unknown>();
  readonly isActive = signal(false);
  private dragDepth = 0;

  @HostBinding('class.drop-zone-active')
  get dropZoneActive(): boolean {
    return this.isActive();
  }

  @HostListener('dragenter', ['$event'])
  onDragEnter(event: DragEvent): void {
    if (!this.canHandle(event.dataTransfer)) return;
    event.preventDefault();
    this.dragDepth++;
    this.isActive.set(true);
  }

  @HostListener('dragover', ['$event'])
  onDragOver(event: DragEvent): void {
    if (!this.canHandle(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  @HostListener('dragleave', ['$event'])
  onDragLeave(event: DragEvent): void {
    if (!this.isExternal(event.dataTransfer)) return;
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) this.isActive.set(false);
  }

  @HostListener('drop', ['$event'])
  async onDrop(event: DragEvent): Promise<void> {
    if (!this.isExternal(event.dataTransfer)) return;
    event.preventDefault();
    this.reset();
    if (!this.enabled() || this.locked() || !event.dataTransfer) return;
    this.dropStarted.emit();
    try {
      this.dropped.emit(await this.reader.read(event.dataTransfer));
    } catch (error) {
      this.dropError.emit(error);
    }
  }

  ngOnDestroy(): void {
    this.reset();
  }

  private reset(): void {
    this.dragDepth = 0;
    this.isActive.set(false);
  }

  private canHandle(dataTransfer: DataTransfer | null): boolean {
    return this.enabled() && !this.locked() && this.isExternal(dataTransfer);
  }

  private isExternal(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;
    const types = Array.from(dataTransfer.types ?? []);
    return types.includes('Files') || (types.length === 0 && dataTransfer.items.length > 0);
  }
}
