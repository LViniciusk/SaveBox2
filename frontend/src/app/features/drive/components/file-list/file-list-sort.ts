import type { DriveFile } from '../../state/drive.store';

export type FileSortColumn = 'name' | 'modified' | 'size' | 'owner';

export function sortFiles(
  files: readonly DriveFile[],
  column: FileSortColumn,
  direction: 'asc' | 'desc',
  foldersMode: 'top' | 'mixed',
  storageMode = false,
): DriveFile[] {
  if (storageMode && column === 'name' && direction === 'asc') {
    return [...files].sort((a, b) => b.sizeBytes - a.sizeBytes);
  }

  const sorted = [...files].sort((a, b) => {
    const valueA = sortValue(a, column);
    const valueB = sortValue(b, column);
    if (valueA < valueB) return direction === 'asc' ? -1 : 1;
    if (valueA > valueB) return direction === 'asc' ? 1 : -1;
    return 0;
  });

  if (foldersMode === 'top') {
    sorted.sort((a, b) => a.isFolder === b.isFolder ? 0 : a.isFolder ? -1 : 1);
  }
  return sorted;
}

function sortValue(file: DriveFile, column: FileSortColumn): string | number {
  if (column === 'size') return file.sizeBytes;
  if (column === 'owner') return file.owner;
  if (column === 'modified') return file.modifiedAt;
  return (file.decryptedName || file.encryptedName).toLowerCase();
}
