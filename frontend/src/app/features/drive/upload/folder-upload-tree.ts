import { FolderUploadFile, FolderUploadNode, FolderUploadSourceFile, FolderUploadTree } from './upload.models';

export const FOLDER_BATCH_LIMIT = 1000;
export const FOLDER_TREE_DEPTH_LIMIT = 128;

export interface FolderUploadLimits {
  maxFolders?: number;
  maxDepth?: number;
}

export function parseDirectoryFiles(files: readonly File[], limits: FolderUploadLimits = {}): FolderUploadFile[] {
  return parseDirectorySources(files.map(file => ({
    file,
    relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '',
  })), limits);
}

export function parseDirectorySources(sources: readonly FolderUploadSourceFile[], limits: FolderUploadLimits = {}): FolderUploadFile[] {
  const maxDepth = limits.maxDepth ?? FOLDER_TREE_DEPTH_LIMIT;
  const paths = new Set<string>();
  return sources.map(source => {
    const { file, relativePath } = source;
    if (!relativePath || relativePath.startsWith('/') || relativePath.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(relativePath) || relativePath.includes('\0')) {
      throw new Error('Caminho de pasta inválido');
    }
    const segments = relativePath.split(/[\\/]/);
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Caminho de pasta inválido');
    if (segments.at(-1) !== file.name || segments.length > maxDepth) throw new Error('Caminho de pasta inválido');
    const normalized = segments.join('/');
    if (paths.has(normalized)) throw new Error('Caminho de arquivo duplicado');
    paths.add(normalized);
    return { file, segments };
  });
}

export function buildFolderUploadTree(
  files: readonly FolderUploadFile[],
  referenceFactory: () => string = () => crypto.randomUUID()
): FolderUploadTree {
  const nodes: FolderUploadNode[] = [];
  const byParentAndName = new Map<string, FolderUploadNode>();
  const resultFiles: FolderUploadTree['files'] = [];

  for (const item of files) {
    let parentClientRef: string | null = null;
    for (const name of item.segments.slice(0, -1)) {
      const key = `${parentClientRef ?? 'root'}\n${name}`;
      let node = byParentAndName.get(key);
      if (!node) {
        node = { clientRef: referenceFactory(), parentClientRef, name };
        byParentAndName.set(key, node);
        nodes.push(node);
        if (nodes.length > FOLDER_BATCH_LIMIT) throw new Error('A seleção excede o limite de pastas');
      }
      parentClientRef = node.clientRef;
    }
    resultFiles.push({ file: item.file, folderClientRef: parentClientRef });
  }

  return { nodes, files: resultFiles };
}
