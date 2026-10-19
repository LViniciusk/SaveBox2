import { Injectable } from '@angular/core';
import { FolderUploadSourceFile } from '../upload/upload.models';

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

const MAX_FOLDERS = 1000;
const MAX_DEPTH = 128;

@Injectable({ providedIn: 'root' })
export class DataTransferReaderService {
  async read(dataTransfer: DataTransfer): Promise<DroppedItems> {
    const items = Array.from((dataTransfer.items ?? []) as unknown as DataTransferItemLike[])
      .filter(item => item.kind === 'file');
    if (!items.length) return { files: Array.from(dataTransfer.files ?? []), folders: [] };

    const files: File[] = [];
    const folders: FolderUploadSourceFile[] = [];
    const folderPaths = new Set<string>();
    const filePaths = new Set<string>();
    let usedEntryApi = false;
    let unreadableItem = false;

    for (const item of items) {
      const entry = item.webkitGetAsEntry?.() ?? null;
      if (entry) {
        usedEntryApi = true;
        if (entry.isDirectory) {
          await this.readDirectory(entry, entry.name, folders, folderPaths, filePaths);
        } else if (entry.isFile) {
          const file = await this.readFile(entry);
          files.push(file);
        }
        continue;
      }

      const file = item.getAsFile();
      if (file) files.push(file);
      else unreadableItem = true;
    }

    if (!usedEntryApi && !files.length && dataTransfer.files.length) {
      return { files: Array.from(dataTransfer.files), folders: [] };
    }
    if (!usedEntryApi && !files.length && unreadableItem) throw new Error('Não foi possível ler o item arrastado');
    if (!folders.length && dataTransfer.files?.length) {
      return { files: Array.from(dataTransfer.files), folders: [] };
    }
    return { files, folders };
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
