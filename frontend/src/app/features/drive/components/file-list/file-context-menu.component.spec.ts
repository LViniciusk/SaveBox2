import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { FileContextMenuComponent, FileContextMenuAction } from './file-context-menu.component';
import type { DriveFile } from '../../state/drive.store';

describe('FileContextMenuComponent', () => {
  let fixture: ComponentFixture<FileContextMenuComponent>;
  const file = {
    id: 1, isFolder: false, type: 'text', encryptedName: 'cipher', decryptedName: 'note.txt',
    sizeBytes: 1, sizeFormatted: '1 B', modifiedAt: '', owner: 'eu', storageProvider: 'local', externalStorageId: null,
  } as DriveFile;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FileContextMenuComponent],
      providers: [provideZonelessChangeDetection()],
    });
    fixture = TestBed.createComponent(FileContextMenuComponent);
    fixture.componentRef.setInput('file', file);
    fixture.componentRef.setInput('canMove', true);
    fixture.componentRef.setInput('position', { x: 10, y: 20 });
    fixture.detectChanges();
  });

  it('emits one typed action for preview and does not expose per-action outputs', () => {
    const actions: FileContextMenuAction[] = [];
    fixture.componentInstance.action.subscribe(action => actions.push(action));
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    const preview = buttons.find(button => button.textContent.includes('Preview'))!;

    preview.click();

    expect(actions).toEqual([{ type: 'preview', event: jasmine.any(Event) }]);
    expect((fixture.componentInstance as any).preview).toBeUndefined();
  });

  it('emits folder actions with the same typed output', () => {
    const folder = { ...file, isFolder: true, type: 'folder' } as DriveFile;
    fixture.componentRef.setInput('file', folder);
    fixture.componentRef.setInput('showPin', true);
    fixture.componentRef.setInput('pinLabel', 'Fixar');
    fixture.detectChanges();
    const actions: FileContextMenuAction[] = [];
    fixture.componentInstance.action.subscribe(action => actions.push(action));

    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    const rename = buttons.find(button => button.textContent.includes('Renomear'))!;
    rename.click();

    expect(actions[0].type).toBe('rename');
    expect(actions[0].event).toEqual(jasmine.any(Event));
  });
});
