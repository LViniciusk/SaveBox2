import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DEFAULT_THEME, THEME_STORAGE_KEY } from './theme.types';
import { ThemeService } from './theme.service';

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    delete document.documentElement.dataset['theme'];
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), ThemeService] });
  });

  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    delete document.documentElement.dataset['theme'];
  });

  it('starts with gdrive and applies it to the document', () => {
    const service = TestBed.inject(ThemeService);

    expect(service.theme()).toBe(DEFAULT_THEME);
    expect(document.documentElement.dataset['theme']).toBe('gdrive');
  });

  it('restores a valid persisted theme', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'default');

    const service = TestBed.inject(ThemeService);

    expect(service.theme()).toBe('default');
    expect(document.documentElement.dataset['theme']).toBe('default');
  });

  it('falls back to gdrive for an invalid persisted value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'unknown');

    const service = TestBed.inject(ThemeService);

    expect(service.theme()).toBe('gdrive');
    expect(document.documentElement.dataset['theme']).toBe('gdrive');
  });

  it('updates the signal, document and localStorage together', () => {
    const service = TestBed.inject(ThemeService);

    service.setTheme('default');

    expect(service.theme()).toBe('default');
    expect(document.documentElement.dataset['theme']).toBe('default');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('default');
  });
});
