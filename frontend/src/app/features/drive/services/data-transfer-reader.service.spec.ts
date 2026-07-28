import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { DataTransferReaderService } from './data-transfer-reader.service';

function file(name: string): File {
  return new File(['data'], name);
}

function entry(name: string, children: any[] = []): any {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let reads = 0;
      return { readEntries: (resolve: (items: any[]) => void) => resolve(reads++ === 0 ? children : []) };
    },
  };
}

function fileEntry(name: string): any {
  return { name, isFile: true, isDirectory: false, file: (resolve: (value: File) => void) => resolve(file(name)) };
}

function transfer(items: any[], files: File[] = []): DataTransfer {
  return { items, files } as unknown as DataTransfer;
}

describe('DataTransferReaderService', () => {
  let service: DataTransferReaderService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), DataTransferReaderService] });
    service = TestBed.inject(DataTransferReaderService);
  });

  it('reads loose files and preserves their order', async () => {
    const result = await service.read(transfer([
      { kind: 'file', getAsFile: () => file('a.txt') },
      { kind: 'file', getAsFile: () => file('b.txt') },
    ]));
    expect(result.files.map(item => item.name)).toEqual(['a.txt', 'b.txt']);
    expect(result.folders).toEqual([]);
  });

  it('reads multiple native file entries without treating them as folders', async () => {
    const result = await service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => fileEntry('a.txt'), getAsFile: () => null },
      { kind: 'file', webkitGetAsEntry: () => fileEntry('b.txt'), getAsFile: () => null },
    ]));
    expect(result.files.map(item => item.name)).toEqual(['a.txt', 'b.txt']);
    expect(result.folders).toEqual([]);
  });

  it('keeps every selected file when the browser exposes only the dragged entry', async () => {
    const selected = [file('a.txt'), file('b.txt'), file('c.txt'), file('d.txt'), file('e.txt')];
    const result = await service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => fileEntry('a.txt'), getAsFile: () => null },
    ], selected));
    expect(result.files.map(item => item.name)).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']);
  });

  it('reads nested directories through multiple readEntries batches', async () => {
    const root = entry('Projeto', [fileEntry('a.txt'), entry('docs', [fileEntry('b.txt')])]);
    const result = await service.read(transfer([{ kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => null }]));
    expect(result.files).toEqual([]);
    expect(result.folders.map(item => item.relativePath)).toEqual(['Projeto/a.txt', 'Projeto/docs/b.txt']);
  });

  it('supports mixed drops without flattening directory files', async () => {
    const root = entry('Projeto', [fileEntry('a.txt')]);
    const result = await service.read(transfer([
      { kind: 'file', getAsFile: () => file('loose.txt') },
      { kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => null },
    ]));
    expect(result.files.map(item => item.name)).toEqual(['loose.txt']);
    expect(result.folders[0].relativePath).toBe('Projeto/a.txt');
  });

  it('ignores an unreadable placeholder after a valid entry was read', async () => {
    const root = entry('Projeto', [fileEntry('a.txt')]);
    const result = await service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => null },
      { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => null },
    ]));
    expect(result.folders.map(item => item.relativePath)).toEqual(['Projeto/a.txt']);
  });

  it('uses the files fallback when the entry API is unavailable', async () => {
    const result = await service.read(transfer([], [file('fallback.txt')]));
    expect(result.files.map(item => item.name)).toEqual(['fallback.txt']);
  });

  it('rejects unsafe or overly deep paths', async () => {
    const unsafe = entry('..', [fileEntry('a.txt')]);
    await expectAsync(service.read(transfer([{ kind: 'file', webkitGetAsEntry: () => unsafe, getAsFile: () => null }]))).toBeRejectedWithError('Caminho arrastado inválido');

    let deep: any = fileEntry('a.txt');
    for (let index = 0; index < 128; index++) deep = entry(`p${index}`, [deep]);
    await expectAsync(service.read(transfer([{ kind: 'file', webkitGetAsEntry: () => entry('root', [deep]), getAsFile: () => null }]))).toBeRejectedWithError('Caminho arrastado inválido');
  });

  it('does not create files for an empty directory', async () => {
    const result = await service.read(transfer([{ kind: 'file', webkitGetAsEntry: () => entry('empty'), getAsFile: () => null }]));
    expect(result.files).toEqual([]);
    expect(result.folders).toEqual([]);
  });

  it('reports unsupported items and reader failures', async () => {
    await expectAsync(service.read(transfer([{ kind: 'file', getAsFile: () => null }]))).toBeRejectedWithError('Não foi possível ler o item arrastado');
    const failedFile = { name: 'broken.txt', isFile: true, isDirectory: false, file: (_resolve: unknown, reject: (error: Error) => void) => reject(new Error('file failed')) };
    await expectAsync(service.read(transfer([{ kind: 'file', webkitGetAsEntry: () => entry('root', [failedFile]), getAsFile: () => null }]))).toBeRejectedWithError('file failed');
    const failedReader = { name: 'root', isFile: false, isDirectory: true, createReader: () => ({ readEntries: (_resolve: unknown, reject: (error: Error) => void) => reject(new Error('reader failed')) }) };
    await expectAsync(service.read(transfer([{ kind: 'file', webkitGetAsEntry: () => failedReader, getAsFile: () => null }]))).toBeRejectedWithError('reader failed');
  });

  it('rejects duplicate directory paths', async () => {
    const root = entry('Projeto', [fileEntry('a.txt')]);
    await expectAsync(service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => null },
      { kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => null },
    ]))).toBeRejectedWithError('Caminho de arquivo arrastado duplicado');
  });
});
