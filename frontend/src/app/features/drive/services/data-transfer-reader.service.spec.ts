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

function batchedEntry(name: string, batches: any[][]): any {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let reads = 0;
      return { readEntries: (resolve: (items: any[]) => void) => resolve(batches[reads++] ?? []) };
    },
  };
}

function nestedEntry(nestedDirectoryCount: number): any {
  let child: any = fileEntry('leaf.txt');
  for (let index = nestedDirectoryCount - 1; index >= 0; index--) child = entry(`dir${index}`, [child]);
  return entry('root', [child]);
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

  it('ignores non-file items, including a non-file-only drop', async () => {
    const getAsFile = jasmine.createSpy('getAsFile').and.returnValue(file('ignored.txt'));
    const webkitGetAsEntry = jasmine.createSpy('webkitGetAsEntry').and.returnValue(fileEntry('ignored-entry.txt'));
    const nonFile = { kind: 'string', getAsFile, webkitGetAsEntry };

    expect(await service.read(transfer([nonFile]))).toEqual({ files: [], folders: [] });
    expect(await service.read(transfer([nonFile], [file('selected.txt')])).then(result => result.files.map(item => item.name))).toEqual(['selected.txt']);
    expect(getAsFile).not.toHaveBeenCalled();
    expect(webkitGetAsEntry).not.toHaveBeenCalled();
  });

  it('uses a null Entry as the direct-file fallback', async () => {
    const result = await service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => file('direct.txt') },
    ]));

    expect(result.files.map(item => item.name)).toEqual(['direct.txt']);
    expect(result.folders).toEqual([]);
  });

  it('uses FileList when an item is unreadable and no direct file was recovered', async () => {
    const result = await service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => null },
    ], [file('fallback.txt')]));

    expect(result.files.map(item => item.name)).toEqual(['fallback.txt']);
    expect(result.folders).toEqual([]);
  });

  it('keeps a valid loose file when another item is unreadable and FileList is empty', async () => {
    const result = await service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => null },
      { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => file('direct.txt') },
    ]));

    expect(result.files.map(item => item.name)).toEqual(['direct.txt']);
    expect(result.folders).toEqual([]);
  });

  it('prefers the complete FileList after native file entries', async () => {
    const result = await service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => fileEntry('entry.txt'), getAsFile: () => null },
    ], [file('entry.txt'), file('richer.txt')]));

    expect(result.files.map(item => item.name)).toEqual(['entry.txt', 'richer.txt']);
    expect(result.folders).toEqual([]);
  });

  it('keeps structured directory results ahead of the FileList fallback', async () => {
    const root = entry('Projeto', [fileEntry('a.txt')]);
    const result = await service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => null },
    ], [file('flattened.txt')]));

    expect(result.files).toEqual([]);
    expect(result.folders.map(item => item.relativePath)).toEqual(['Projeto/a.txt']);
  });

  it('keeps mixed loose and structured results in their own collections', async () => {
    const root = entry('Projeto', [fileEntry('folder.txt')]);
    const result = await service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => file('loose.txt') },
      { kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => null },
    ], [file('flattened.txt')]));

    expect(result.files.map(item => item.name)).toEqual(['loose.txt']);
    expect(result.folders.map(item => item.relativePath)).toEqual(['Projeto/folder.txt']);
  });

  it('falls back to FileList for an empty directory only when it exists', async () => {
    const item = { kind: 'file', webkitGetAsEntry: () => entry('empty'), getAsFile: () => null };

    expect(await service.read(transfer([item], [file('fallback.txt')]))).toEqual({
      files: [jasmine.any(File)],
      folders: [],
    });
    expect(await service.read(transfer([item]))).toEqual({ files: [], folders: [] });
  });

  it('does not treat an opaque Entry as a readable file or directory', async () => {
    const opaque = { name: 'opaque', isFile: false, isDirectory: false };

    expect(await service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => opaque, getAsFile: () => file('ignored.txt') },
    ]))).toEqual({ files: [], folders: [] });
  });

  it('falls back to FileList when an opaque Entry produced no structured files', async () => {
    const opaque = { name: 'opaque', isFile: false, isDirectory: false };
    const result = await service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => opaque, getAsFile: () => file('ignored-direct.txt') },
    ], [file('selected.txt')]));

    expect(result.files.map(item => item.name)).toEqual(['selected.txt']);
    expect(result.folders).toEqual([]);
  });

  it('preserves ordering across multiple non-empty readEntries batches', async () => {
    const root = batchedEntry('Projeto', [[fileEntry('a.txt')], [fileEntry('b.txt')], []]);
    const result = await service.read(transfer([{ kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => null }]));

    expect(result.folders.map(item => item.relativePath)).toEqual(['Projeto/a.txt', 'Projeto/b.txt']);
  });

  it('rejects a directory without createReader', async () => {
    const missingReader = { name: 'root', isFile: false, isDirectory: true };

    await expectAsync(service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => missingReader, getAsFile: () => null },
    ]))).toBeRejectedWithError('O navegador não suporta leitura de diretórios');
  });

  it('rejects a file entry without a file callback', async () => {
    const missingFileCallback = { name: 'broken.txt', isFile: true, isDirectory: false };

    await expectAsync(service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => missingFileCallback, getAsFile: () => null },
    ]))).toBeRejectedWithError('Não foi possível ler o arquivo arrastado');
  });

  it('propagates Entry and direct-file callback failures', async () => {
    const entryFailure = new Error('entry lookup failed');
    const fileFailure = new Error('direct file lookup failed');
    const entryThrowingItem = { kind: 'file', webkitGetAsEntry: () => { throw entryFailure; }, getAsFile: () => null };
    const fileThrowingItem = { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => { throw fileFailure; } };

    await expectAsync(service.read(transfer([entryThrowingItem]))).toBeRejectedWith(entryFailure);
    await expectAsync(service.read(transfer([fileThrowingItem]))).toBeRejectedWith(fileFailure);
  });

  it('rejects unsafe paths without normalizing them', async () => {
    const unsafeRoots = ['', '\0', '/root', '\\root', 'C:\\root', 'C:/root', '.', '..', 'root//child'];
    for (const name of unsafeRoots) {
      const unsafe = entry(name, [fileEntry('a.txt')]);
      await expectAsync(service.read(transfer([
        { kind: 'file', webkitGetAsEntry: () => unsafe, getAsFile: () => null },
      ]))).toBeRejectedWithError('Caminho arrastado inválido');
    }

    const unsafeChild = entry('root', [fileEntry('.')]);
    const mismatchedFile = {
      name: 'path-name.txt',
      isFile: true,
      isDirectory: false,
      file: (resolve: (value: File) => void) => resolve(file('actual-name.txt')),
    };
    await expectAsync(service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => unsafeChild, getAsFile: () => null },
    ]))).toBeRejectedWithError('Caminho arrastado inválido');
    await expectAsync(service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => entry('root', [mismatchedFile]), getAsFile: () => null },
    ]))).toBeRejectedWithError('Caminho arrastado inválido');
  });

  it('accepts MAX_DEPTH and rejects one segment beyond it', async () => {
    const exact = await service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => nestedEntry(126), getAsFile: () => null },
    ]));
    expect(exact.folders).toHaveSize(1);

    await expectAsync(service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => nestedEntry(127), getAsFile: () => null },
    ]))).toBeRejectedWithError('Caminho arrastado inválido');
  });

  it('accepts MAX_FOLDERS and rejects one folder beyond it', async () => {
    const exact = entry('root', Array.from({ length: 999 }, (_, index) => entry(`folder${index}`)));
    const over = entry('root', Array.from({ length: 1000 }, (_, index) => entry(`folder${index}`)));

    const result = await service.read(transfer([{ kind: 'file', webkitGetAsEntry: () => exact, getAsFile: () => null }]));
    expect(result.folders).toEqual([]);
    await expectAsync(service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => over, getAsFile: () => null },
    ]))).toBeRejectedWithError('A seleção excede o limite de pastas');
  });

  it('rejects duplicate directory paths', async () => {
    const root = entry('Projeto', [fileEntry('a.txt')]);
    await expectAsync(service.read(transfer([
      { kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => null },
      { kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => null },
    ]))).toBeRejectedWithError('Caminho de arquivo arrastado duplicado');
  });
});
