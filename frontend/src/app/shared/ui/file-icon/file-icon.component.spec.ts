import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { FileIconComponent } from './file-icon.component';

describe('FileIconComponent', () => {
  let component: FileIconComponent;
  let fixture: any;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FileIconComponent],
      providers: [provideZonelessChangeDetection()]
    });

    fixture = TestBed.createComponent(FileIconComponent);
    component = fixture.componentInstance;
  });

  it('should return "lock" icon and "locked" class when locked is true', () => {
    fixture.componentRef.setInput('fileType', 'image');
    fixture.componentRef.setInput('locked', true);

    expect(component.iconName()).toBe('lock');
    expect(component.iconClass()).toBe('locked');
  });

  describe('when unlocked', () => {
    it('should return correct icon and class for folder', () => {
      fixture.componentRef.setInput('fileType', 'folder');
      fixture.componentRef.setInput('locked', false);
      expect(component.iconName()).toBe('folder');
      expect(component.iconClass()).toBe('folder');
    });

    it('should return correct icon for pdf', () => {
      fixture.componentRef.setInput('fileType', 'pdf');
      fixture.componentRef.setInput('locked', false);
      expect(component.iconName()).toBe('picture_as_pdf');
    });

    it('should return correct icon for image', () => {
      fixture.componentRef.setInput('fileType', 'image');
      fixture.componentRef.setInput('locked', false);
      expect(component.iconName()).toBe('image');
    });

    it('should return correct icon for doc', () => {
      fixture.componentRef.setInput('fileType', 'doc');
      fixture.componentRef.setInput('locked', false);
      expect(component.iconName()).toBe('description');
    });

    it('should return correct icon for spreadsheet', () => {
      fixture.componentRef.setInput('fileType', 'spreadsheet');
      fixture.componentRef.setInput('locked', false);
      expect(component.iconName()).toBe('table_chart');
    });

    it('should return correct icon for video', () => {
      fixture.componentRef.setInput('fileType', 'video');
      fixture.componentRef.setInput('locked', false);
      expect(component.iconName()).toBe('movie');
    });

    it('should return correct icon for audio', () => {
      fixture.componentRef.setInput('fileType', 'audio');
      fixture.componentRef.setInput('locked', false);
      expect(component.iconName()).toBe('audio_file');
    });

    it('should return default icon for unknown type', () => {
      fixture.componentRef.setInput('fileType', 'unknown_type');
      fixture.componentRef.setInput('locked', false);
      expect(component.iconName()).toBe('insert_drive_file');
      expect(component.iconClass()).toBe('unknown_type');
    });
  });
});
