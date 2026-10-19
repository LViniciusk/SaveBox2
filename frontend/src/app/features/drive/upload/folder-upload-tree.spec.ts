import { buildFolderUploadTree, parseDirectoryFiles, parseDirectorySources } from './folder-upload-tree';
import type { FolderUploadSourceFile } from './upload.models';

function file(name: string, path: string): File {
  const result = new File(['content'], name);
  Object.defineProperty(result, 'webkitRelativePath', { configurable: true, value: path });
  return result;
}

function source(name: string, relativePath: string): FolderUploadSourceFile {
  return { file: new File(['content'], name), relativePath };
}

function pathWithSegments(segmentCount: number, filename = 'a.txt'): string {
  return [...Array.from({ length: segmentCount - 1 }, (_, index) => `folder-${index}`), filename].join('/');
}

function expectInvalidPath(path: string, filename = 'a.txt'): void {
  expect(() => parseDirectoryFiles([file(filename, path)])).toThrowError('Caminho de pasta inválido');
}

describe('folder-upload-tree', () => {
  it('preserves the selected root and deduplicates shared folders', () => {
    const parsed = parseDirectoryFiles([file('a.txt', 'Projeto/a.txt'), file('b.txt', 'Projeto/docs/b.txt')]);
    const tree = buildFolderUploadTree(parsed, (() => { let i = 0; return () => `ref-${++i}`; })());

    expect(tree.nodes.map(node => node.name)).toEqual(['Projeto', 'docs']);
    expect(tree.nodes[1].parentClientRef).toBe(tree.nodes[0].clientRef);
    expect(tree.files.map(item => item.folderClientRef)).toEqual([tree.nodes[0].clientRef, tree.nodes[1].clientRef]);
  });

  it('returns an empty result for an empty file selection', () => {
    expect(parseDirectoryFiles([])).toEqual([]);
  });

  it('maps webkitRelativePath while preserving array order and File references', () => {
    const first = file('a.txt', 'Projeto/a.txt');
    const second = file('b.txt', 'Projeto/docs/b.txt');
    const parsed = parseDirectoryFiles([first, second]);

    expect(parsed.map(item => item.segments)).toEqual([
      ['Projeto', 'a.txt'],
      ['Projeto', 'docs', 'b.txt'],
    ]);
    expect(parsed[0].file).toBe(first);
    expect(parsed[1].file).toBe(second);
  });

  it('accepts explicit source paths and preserves their File references', () => {
    const first = source('a.txt', 'Projeto\\docs\\a.txt');
    const second = source('b.txt', 'Outro/b.txt');
    const parsed = parseDirectorySources([first, second]);

    expect(parsed.map(item => item.segments)).toEqual([
      ['Projeto', 'docs', 'a.txt'],
      ['Outro', 'b.txt'],
    ]);
    expect(parsed[0].file).toBe(first.file);
    expect(parsed[1].file).toBe(second.file);
  });

  it('rejects an empty path with the parser error', () => {
    expectInvalidPath('');
  });

  it('rejects a leading forward slash', () => {
    expectInvalidPath('/Projeto/a.txt');
  });

  it('rejects a leading backslash', () => {
    expectInvalidPath('\\Projeto\\a.txt');
  });

  it('rejects a Windows drive absolute path with backslashes', () => {
    expectInvalidPath('C:\\Projeto\\a.txt');
  });

  it('rejects a Windows drive absolute path with forward slashes', () => {
    expectInvalidPath('C:/Projeto/a.txt');
  });

  it('rejects a lowercase Windows drive absolute path', () => {
    expectInvalidPath('c:\\Projeto\\a.txt');
  });

  it('rejects a NUL in its own path segment', () => {
    expectInvalidPath('Projeto/\0/a.txt');
  });

  it('rejects a NUL inside a filename segment', () => {
    expectInvalidPath('Projeto/a\0.txt');
  });

  it('rejects an empty segment created by repeated forward slashes', () => {
    expectInvalidPath('Projeto//a.txt');
  });

  it('rejects an empty segment created by repeated backslashes', () => {
    expectInvalidPath(String.raw`Projeto\\a.txt`);
  });

  it('rejects an empty segment created by mixed separators', () => {
    expectInvalidPath(String.raw`Projeto/\\a.txt`);
  });

  it('rejects a current-directory segment', () => {
    expectInvalidPath('Projeto/./a.txt');
  });

  it('rejects a parent-directory segment', () => {
    expectInvalidPath('Projeto/../a.txt');
  });

  it('rejects a trailing separator', () => {
    expectInvalidPath('Projeto/a.txt/');
  });

  it('rejects a filename and path basename mismatch', () => {
    expectInvalidPath('Projeto/b.txt', 'a.txt');
  });

  it('rejects a missing webkitRelativePath from the File wrapper', () => {
    const selected = new File(['content'], 'a.txt');
    expect(() => parseDirectoryFiles([selected])).toThrowError('Caminho de pasta inválido');
  });

  it('accepts exactly the 128-segment depth boundary', () => {
    const parsed = parseDirectoryFiles([file('a.txt', pathWithSegments(128))]);
    expect(parsed[0].segments).toHaveSize(128);
  });

  it('rejects one segment beyond the 128-segment depth boundary', () => {
    expectInvalidPath(pathWithSegments(129));
  });

  it('rejects an exact duplicate path with the duplicate error', () => {
    expect(() => parseDirectoryFiles([
      file('a.txt', 'Projeto/a.txt'),
      file('a.txt', 'Projeto/a.txt'),
    ])).toThrowError('Caminho de arquivo duplicado');
  });

  it('rejects duplicate paths after slash normalization', () => {
    expect(() => parseDirectorySources([
      source('a.txt', 'Projeto/a.txt'),
      source('a.txt', 'Projeto\\a.txt'),
    ])).toThrowError('Caminho de arquivo duplicado');
  });

  it('keeps duplicate ownership case-sensitive as the existing contract', () => {
    const parsed = parseDirectoryFiles([
      file('a.txt', 'Projeto/a.txt'),
      file('a.txt', 'projeto/a.txt'),
    ]);
    expect(parsed).toHaveSize(2);
  });

  it('validates an invalid path before classifying a later duplicate', () => {
    expect(() => parseDirectorySources([
      source('a.txt', 'Projeto/../a.txt'),
      source('a.txt', 'Projeto/a.txt'),
    ])).toThrowError('Caminho de pasta inválido');
  });

  it('does not mutate the source array or source records', () => {
    const first = source('a.txt', 'Projeto/a.txt');
    const second = source('b.txt', 'Projeto/b.txt');
    const sources = Object.freeze([first, second]) as readonly FolderUploadSourceFile[];
    const before = sources.map(item => ({ file: item.file, relativePath: item.relativePath }));

    parseDirectorySources(sources);

    expect(sources[0]).toEqual(before[0]);
    expect(sources[1]).toEqual(before[1]);
    expect(sources[0].file).toBe(first.file);
    expect(sources[1].file).toBe(second.file);
  });

  it('keeps the duplicate Set local to each parser invocation', () => {
    const first = parseDirectoryFiles([file('a.txt', 'Projeto/a.txt')]);
    const second = parseDirectoryFiles([file('a.txt', 'Projeto/a.txt')]);

    expect(first[0].segments).toEqual(['Projeto', 'a.txt']);
    expect(second[0].segments).toEqual(['Projeto', 'a.txt']);
  });

  it('rejects duplicate paths and preserves multiple roots', () => {
    expect(() => parseDirectoryFiles([file('a.txt', 'Projeto/a.txt'), file('a.txt', 'Projeto/a.txt')])).toThrow();
    const tree = buildFolderUploadTree(parseDirectoryFiles([file('a.txt', 'A/a.txt'), file('b.txt', 'B/b.txt')]), () => crypto.randomUUID());
    expect(tree.nodes.map(node => node.name)).toEqual(['A', 'B']);
  });

  it('deduplicates the same folder node across multiple files', () => {
    const tree = buildFolderUploadTree(parseDirectoryFiles([
      file('a.txt', 'Projeto/a.txt'),
      file('b.txt', 'Projeto/b.txt'),
    ]), (() => { let i = 0; return () => `ref-${++i}`; })());

    expect(tree.nodes).toHaveSize(1);
    expect(tree.files.map(item => item.folderClientRef)).toEqual([
      tree.nodes[0].clientRef,
      tree.nodes[0].clientRef,
    ]);
  });

  it('accepts exactly 1000 unique folder nodes', () => {
    const files = Array.from({ length: 1000 }, (_, index) => file(`file-${index}.txt`, `folder-${index}/file-${index}.txt`));
    const tree = buildFolderUploadTree(parseDirectoryFiles(files), () => crypto.randomUUID());

    expect(tree.nodes).toHaveSize(1000);
  });

  it('rejects the 1001st unique folder node with the folder limit error', () => {
    const files = Array.from({ length: 1001 }, (_, index) => file(`file-${index}.txt`, `folder-${index}/file-${index}.txt`));

    expect(() => buildFolderUploadTree(parseDirectoryFiles(files), () => crypto.randomUUID()))
      .toThrowError('A seleção excede o limite de pastas');
  });
});
