import { Injectable, signal } from '@angular/core';

export interface DialogOptions {
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText: string;
  cancelText?: string;
  isDanger?: boolean;
  showInput?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class DialogService {
  readonly activeDialog = signal<{
    options: DialogOptions;
    resolve: (value: string | boolean) => void;
  } | null>(null);

  readonly dialogValue = signal('');

  prompt(title: string, defaultValue = '', placeholder = '', confirmText = 'OK'): Promise<string | null> {
    this.dialogValue.set(defaultValue);
    return new Promise((resolve) => {
      this.activeDialog.set({
        options: {
          title,
          defaultValue,
          placeholder,
          confirmText,
          cancelText: 'Cancelar',
          showInput: true
        },
        resolve: (val) => resolve(typeof val === 'string' ? val : null)
      });
    });
  }

  confirm(title: string, message: string, confirmText: string, isDanger = false): Promise<boolean> {
    this.dialogValue.set('');
    return new Promise((resolve) => {
      this.activeDialog.set({
        options: {
          title,
          message,
          confirmText,
          cancelText: 'Cancelar',
          isDanger,
          showInput: false
        },
        resolve: (val) => resolve(!!val)
      });
    });
  }
}
