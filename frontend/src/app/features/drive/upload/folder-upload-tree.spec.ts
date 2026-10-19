import { buildFolderUploadTree, parseDirectoryFiles } from './folder-upload-tree';

function file(name: string, path: string): File {
  const result = new File(['content'], name);
  Object.defineProperty(result, 'webkitRelativePath', { configurable: true, value: path });
  return result;
}

describe('folder-upload-tree', () => {
  it('preserves the selected root and deduplicates shared folders', () => {
    const parsed = parseDirectoryFiles([file('a.txt', 'Projeto/a.txt'), file('b.txt', 'Projeto/docs/b.txt')]);
    const tree = buildFolderUploadTree(parsed, (() => { let i = 0; return () => `ref-${++i}`; })());

    expect(tree.nodes.map(node => node.name)).toEqual(['Projeto', 'docs']);
    expect(tree.nodes[1].parentClientRef).toBe(tree.nodes[0].clientRef);
    expect(tree.files.map(item => item.folderClientRef)).toEqual([tree.nodes[0].clientRef, tree.nodes[1].clientRef]);
  });

  it('accepts slash variants and rejects unsafe or inconsistent paths', () => {
    expect(parseDirectoryFiles([file('a.txt', 'Projeto\\docs\\a.txt')])[0].segments).toEqual(['Projeto', 'docs', 'a.txt']);
    for (const path of ['/Projeto/a.txt', 'C:\\Projeto\\a.txt', 'Projeto/../a.txt', 'Projeto//a.txt', 'Projeto/b.txt']) {
      expect(() => parseDirectoryFiles([file('a.txt', path)])).toThrow();
    }
  });

  it('rejects duplicate paths and preserves multiple roots', () => {
    expect(() => parseDirectoryFiles([file('a.txt', 'Projeto/a.txt'), file('a.txt', 'Projeto/a.txt')])).toThrow();
    const tree = buildFolderUploadTree(parseDirectoryFiles([file('a.txt', 'A/a.txt'), file('b.txt', 'B/b.txt')]), () => crypto.randomUUID());
    expect(tree.nodes.map(node => node.name)).toEqual(['A', 'B']);
  });
});
