import { Injectable } from '@angular/core';
import type { FolderUploadSourceFile } from '../upload/upload.models';

export interface DroppedItems {
  files: readonly File[];
  folders: readonly FolderUploadSourceFile[];
}

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(success: (file: File) => void, error?: (error: unknown) => void): void;
  createReader?(): { readEntries(success: (entries: FileSystemEntryLike[]) => void, error?: (error: unknown) => void): void };
}

interface DataTransferItemLike {
  kind: string;
  getAsFile(): File | null;
  webkitGetAsEntry?(): FileSystemEntryLike | null;
}

interface DropReadState {
  readonly files: File[];
  readonly folders: FolderUploadSourceFile[];
  readonly folderPaths: Set<string>;
  readonly filePaths: Set<string>;
  usedEntryApi: boolean;
}

const MAX_FOLDERS = 1000;
const MAX_DEPTH = 128;

@Injectable({ providedIn: 'root' })
export class DataTransferReaderService {
  async read(dataTransfer: DataTransfer): Promise<DroppedItems> {
    const items = Array.from((dataTransfer.items ?? []) as unknown as DataTransferItemLike[])
      .filter(item => item.kind === 'file');
    if (!items.length) return { files: Array.from(dataTransfer.files ?? []), folders: [] };

    const state: DropReadState = {
      files: [],
      folders: [],
      folderPaths: new Set<string>(),
      filePaths: new Set<string>(),
      usedEntryApi: false,
    };

    for (const item of items) await this.readItem(item, state);
    return this.finalizeRead(dataTransfer, state);
  }

  private async readItem(item: DataTransferItemLike, state: DropReadState): Promise<void> {
    const entry = item.webkitGetAsEntry?.() ?? null;
    if (!entry) {
      const file = item.getAsFile();
      if (file) state.files.push(file);
      return;
    }

    state.usedEntryApi = true;
    if (entry.isDirectory) {
      await this.readDirectory(entry, entry.name, state.folders, state.folderPaths, state.filePaths);
      return;
    }

    if (entry.isFile) state.files.push(await this.readFile(entry));
  }

  private finalizeRead(dataTransfer: DataTransfer, state: DropReadState): DroppedItems {
    if (!state.folders.length && dataTransfer.files.length) {
      return { files: Array.from(dataTransfer.files), folders: [] };
    }
    if (!state.usedEntryApi && !state.files.length) {
      throw new Error('Não foi possível ler o item arrastado');
    }
    return { files: state.files, folders: state.folders };
  }

  private async readDirectory(
    entry: FileSystemEntryLike,
    path: string,
    folders: FolderUploadSourceFile[],
    folderPaths: Set<string>,
    filePaths: Set<string>
  ): Promise<void> {
    this.validatePath(path, false);
    folderPaths.add(path);
    if (folderPaths.size > MAX_FOLDERS) throw new Error('A seleção excede o limite de pastas');
    if (!entry.createReader) throw new Error('O navegador não suporta leitura de diretórios');

    const reader = entry.createReader();
    while (true) {
      const entries = await this.readEntries(reader);
      if (!entries.length) return;
      for (const child of entries) {
        const childPath = `${path}/${child.name}`;
        if (child.isDirectory) {
          await this.readDirectory(child, childPath, folders, folderPaths, filePaths);
        } else if (child.isFile) {
          const file = await this.readFile(child);
          this.validatePath(childPath, true, file.name);
          if (filePaths.has(childPath)) throw new Error('Caminho de arquivo arrastado duplicado');
          filePaths.add(childPath);
          folders.push({ file, relativePath: childPath });
        }
      }
    }
  }

  private readFile(entry: FileSystemEntryLike): Promise<File> {
    if (!entry.file) return Promise.reject(new Error('Não foi possível ler o arquivo arrastado'));
    return new Promise((resolve, reject) => entry.file!(resolve, reject));
  }

  private readEntries(reader: { readEntries(success: (entries: FileSystemEntryLike[]) => void, error?: (error: unknown) => void): void }): Promise<FileSystemEntryLike[]> {
    return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  }

  private validatePath(path: string, filePath: boolean, fileName?: string): void {
    if (!path || path.includes('\0') || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)) {
      throw new Error('Caminho arrastado inválido');
    }
    const segments = path.split(/[\\/]/);
    if (segments.some(segment => !segment || segment === '.' || segment === '..') || segments.length > MAX_DEPTH) {
      throw new Error('Caminho arrastado inválido');
    }
    if (filePath && segments.at(-1) !== fileName) throw new Error('Caminho arrastado inválido');
  }
}
