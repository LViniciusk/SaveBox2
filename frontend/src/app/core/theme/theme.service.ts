import { Injectable, signal } from '@angular/core';
import { DEFAULT_THEME, THEME_STORAGE_KEY, Theme } from './theme.types';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly themeSignal = signal<Theme>(this.readTheme());

  readonly theme = this.themeSignal.asReadonly();

  constructor() {
    this.applyTheme(this.theme());
  }

  setTheme(theme: Theme): void {
    this.themeSignal.set(theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    this.applyTheme(theme);
  }

  private readTheme(): Theme {
    const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    return storedTheme === 'default' || storedTheme === 'gdrive' ? storedTheme : DEFAULT_THEME;
  }

  private applyTheme(theme: Theme): void {
    document.documentElement.dataset['theme'] = theme;
  }
}
