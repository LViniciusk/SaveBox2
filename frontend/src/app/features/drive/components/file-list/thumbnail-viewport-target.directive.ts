import { Directive, ElementRef, Input, inject } from '@angular/core';
import { DriveFile } from '../../state/drive.store';

@Directive({
  selector: '[appThumbnailViewport]',
  standalone: true,
})
export class ThumbnailViewportTargetDirective {
  @Input() appThumbnailViewportTarget: DriveFile | null = null;
  readonly element = inject(ElementRef<HTMLElement>).nativeElement;
}
