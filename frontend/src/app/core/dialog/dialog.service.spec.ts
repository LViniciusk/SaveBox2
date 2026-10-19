import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { DialogService } from './dialog.service';

describe('DialogService', () => {
  let service: DialogService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()]
    });
    service = TestBed.inject(DialogService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('prompt', () => {
    it('should set activeDialog and resolve with string when resolved with string', async () => {
      const promise = service.prompt('Enter name', 'default_name', 'placeholder_name', 'Save');
      
      const active = service.activeDialog();
      expect(active).not.toBeNull();
      expect(active?.options.title).toBe('Enter name');
      expect(active?.options.defaultValue).toBe('default_name');
      expect(active?.options.placeholder).toBe('placeholder_name');
      expect(active?.options.confirmText).toBe('Save');
      expect(active?.options.showInput).toBeTrue();
      expect(service.dialogValue()).toBe('default_name');

      // Resolve the dialog
      active?.resolve('new_name');
      
      const result = await promise;
      expect(result).toBe('new_name');
    });

    it('should resolve with null when resolved with non-string (e.g. false on cancel)', async () => {
      const promise = service.prompt('Enter name');
      
      const active = service.activeDialog();
      active?.resolve(false);
      
      const result = await promise;
      expect(result).toBeNull();
    });
  });

  describe('confirm', () => {
    it('should set activeDialog and resolve to true when confirmed', async () => {
      const promise = service.confirm('Delete?', 'Are you sure?', 'Delete', true);
      
      const active = service.activeDialog();
      expect(active).not.toBeNull();
      expect(active?.options.title).toBe('Delete?');
      expect(active?.options.message).toBe('Are you sure?');
      expect(active?.options.confirmText).toBe('Delete');
      expect(active?.options.isDanger).toBeTrue();
      expect(active?.options.showInput).toBeFalse();
      expect(service.dialogValue()).toBe('');

      active?.resolve(true);
      
      const result = await promise;
      expect(result).toBeTrue();
    });

    it('should resolve to false when cancelled (resolved with false or null)', async () => {
      const promise = service.confirm('Cancel?', 'Sure?', 'Yes');
      
      const active = service.activeDialog();
      active?.resolve(false);
      
      const result = await promise;
      expect(result).toBeFalse();
    });
  });
});
