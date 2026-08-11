import { Component, input } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { By } from '@angular/platform-browser';
import { DriveDropZoneDirective } from './drive-drop-zone.directive';
import { DataTransferReaderService } from '../services/data-transfer-reader.service';

@Component({
  standalone: true,
  imports: [DriveDropZoneDirective],
  template: '<div appDriveDropZone [dropZoneEnabled]="enabled()" [dropZoneLocked]="locked()"></div>',
})
class HostComponent {
  readonly enabled = input(true);
  readonly locked = input(false);
}

function dataTransfer(types: string[] = ['Files']): DataTransfer {
  return { types, items: [{ kind: 'file', getAsFile: () => new File(['x'], 'x.txt') }], files: [] } as unknown as DataTransfer;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('DriveDropZoneDirective', () => {
  let fixture: ComponentFixture<HostComponent>;
  let reader: jasmine.SpyObj<DataTransferReaderService>;
  let directive: DriveDropZoneDirective;

  beforeEach(async () => {
    reader = jasmine.createSpyObj('DataTransferReaderService', ['read']);
    reader.read.and.resolveTo({ files: [new File(['x'], 'x.txt')], folders: [] });
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [provideZonelessChangeDetection(), { provide: DataTransferReaderService, useValue: reader }],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    directive = fixture.debugElement.query(By.directive(DriveDropZoneDirective)).injector.get(DriveDropZoneDirective);
  });

  it('activates only for external file drags and clears after drop', async () => {
    const zone = fixture.nativeElement.firstElementChild as HTMLElement;
    directive.onDragEnter({ dataTransfer: dataTransfer(), preventDefault: () => undefined } as unknown as DragEvent);
    fixture.detectChanges();
    expect(zone.classList.contains('drop-zone-active')).toBeTrue();
    directive.onDragOver({ dataTransfer: dataTransfer(), preventDefault: () => undefined } as unknown as DragEvent);
    await directive.onDrop({ dataTransfer: dataTransfer(), preventDefault: () => undefined } as unknown as DragEvent);
    fixture.detectChanges();
    await Promise.resolve();
    expect(reader.read).toHaveBeenCalled();
    expect(zone.classList.contains('drop-zone-active')).toBeFalse();
  });

  it('ignores internal Drive drags and locked zones', () => {
    const zone = fixture.nativeElement.firstElementChild as HTMLElement;
    directive.onDragEnter({ dataTransfer: dataTransfer(['text/plain']), preventDefault: () => undefined } as unknown as DragEvent);
    expect(zone.classList.contains('drop-zone-active')).toBeFalse();
    fixture.componentRef.setInput('locked', true);
    fixture.detectChanges();
    directive.onDragEnter({ dataTransfer: dataTransfer(), preventDefault: () => undefined } as unknown as DragEvent);
    expect(zone.classList.contains('drop-zone-active')).toBeFalse();
  });

  it('does not activate when disabled', () => {
    fixture.componentRef.setInput('enabled', false);
    fixture.detectChanges();
    const zone = fixture.nativeElement.firstElementChild as HTMLElement;
    directive.onDragEnter({ dataTransfer: dataTransfer(), preventDefault: () => undefined } as unknown as DragEvent);
    expect(zone.classList.contains('drop-zone-active')).toBeFalse();
  });

  it('signals the start before reading and clears the overlay after a read error', async () => {
    const started = jasmine.createSpy('started');
    const failed = jasmine.createSpy('failed');
    directive.dropStarted.subscribe(started);
    directive.dropError.subscribe(failed);
    reader.read.and.rejectWith(new Error('read failed'));

    directive.onDragEnter({ dataTransfer: dataTransfer(), preventDefault: () => undefined } as unknown as DragEvent);
    fixture.detectChanges();
    await directive.onDrop({ dataTransfer: dataTransfer(), preventDefault: () => undefined } as unknown as DragEvent);
    fixture.detectChanges();

    expect(started).toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(jasmine.any(Error));
    expect(fixture.nativeElement.firstElementChild.classList.contains('drop-zone-active')).toBeFalse();
  });

  it('does not overlap external reads and still prevents the busy drop', async () => {
    const first = deferred<{ files: File[]; folders: [] }>();
    const second = deferred<{ files: File[]; folders: [] }>();
    const started = jasmine.createSpy('started');
    const dropped = jasmine.createSpy('dropped');
    const preventFirst = jasmine.createSpy('preventFirst');
    const preventSecond = jasmine.createSpy('preventSecond');
    directive.dropStarted.subscribe(started);
    directive.dropped.subscribe(dropped);
    reader.read.and.returnValues(first.promise, second.promise);

    const firstDrop = directive.onDrop({ dataTransfer: dataTransfer(), preventDefault: preventFirst } as unknown as DragEvent);
    const secondDrop = directive.onDrop({ dataTransfer: dataTransfer(), preventDefault: preventSecond } as unknown as DragEvent);

    expect(preventFirst).toHaveBeenCalledOnceWith();
    expect(preventSecond).toHaveBeenCalledOnceWith();
    expect(reader.read).toHaveBeenCalledOnceWith(jasmine.anything());
    expect(started).toHaveBeenCalledTimes(1);

    first.resolve({ files: [new File(['a'], 'a.txt')], folders: [] });
    await firstDrop;
    await secondDrop;

    expect(dropped).toHaveBeenCalledOnceWith(jasmine.objectContaining({ files: jasmine.any(Array), folders: [] }));
  });

  it('accepts a new external read after the previous read succeeds', async () => {
    const first = deferred<{ files: File[]; folders: [] }>();
    const second = deferred<{ files: File[]; folders: [] }>();
    const dropped = jasmine.createSpy('dropped');
    directive.dropped.subscribe(dropped);
    reader.read.and.returnValues(first.promise, second.promise);

    const firstDrop = directive.onDrop({ dataTransfer: dataTransfer(), preventDefault: () => undefined } as unknown as DragEvent);
    first.resolve({ files: [new File(['a'], 'a.txt')], folders: [] });
    await firstDrop;

    const secondDrop = directive.onDrop({ dataTransfer: dataTransfer(), preventDefault: () => undefined } as unknown as DragEvent);
    second.resolve({ files: [new File(['b'], 'b.txt')], folders: [] });
    await secondDrop;

    expect(reader.read).toHaveBeenCalledTimes(2);
    expect(dropped).toHaveBeenCalledTimes(2);
  });

  it('accepts a new external read after the previous read errors', async () => {
    const first = deferred<{ files: File[]; folders: [] }>();
    const second = deferred<{ files: File[]; folders: [] }>();
    const failed = jasmine.createSpy('failed');
    const dropped = jasmine.createSpy('dropped');
    directive.dropError.subscribe(failed);
    directive.dropped.subscribe(dropped);
    reader.read.and.returnValues(first.promise, second.promise);

    const firstDrop = directive.onDrop({ dataTransfer: dataTransfer(), preventDefault: () => undefined } as unknown as DragEvent);
    first.reject(new Error('read failed'));
    await firstDrop;

    const secondDrop = directive.onDrop({ dataTransfer: dataTransfer(), preventDefault: () => undefined } as unknown as DragEvent);
    second.resolve({ files: [new File(['b'], 'b.txt')], folders: [] });
    await secondDrop;

    expect(failed).toHaveBeenCalledOnceWith(jasmine.any(Error));
    expect(dropped).toHaveBeenCalledOnceWith(jasmine.objectContaining({ files: jasmine.any(Array), folders: [] }));
    expect(reader.read).toHaveBeenCalledTimes(2);
  });
});
