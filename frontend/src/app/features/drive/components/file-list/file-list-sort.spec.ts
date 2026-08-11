import type { DriveFile } from '../../state/drive.store';
import { sortFiles } from './file-list-sort';

describe('sortFiles', () => {
  const file = (id: number, name: string, folder = false, size = id): DriveFile => ({
    id, isFolder: folder, encryptedName: name, decryptedName: name, type: folder ? 'folder' : 'unknown',
    sizeBytes: size, sizeFormatted: '', modifiedAt: '', owner: 'eu', storageProvider: 'local', externalStorageId: null,
  });

  it('sorts by name and keeps folders first when requested', () => {
    const result = sortFiles([file(1, 'zeta'), file(2, 'alpha', true)], 'name', 'asc', 'top');
    expect(result.map(item => item.id)).toEqual([2, 1]);
  });

  it('preserves the storage default ordering by size', () => {
    const result = sortFiles([file(1, 'small', false, 1), file(2, 'large', false, 2)], 'name', 'asc', 'top', true);
    expect(result.map(item => item.id)).toEqual([2, 1]);
  });

  it('sorts modified date, size and owner in both directions without mutating input', () => {
    const files = [file(1, 'b', false, 20), { ...file(2, 'a', false, 10), modifiedAt: '2026-02-01', owner: 'z' }, { ...file(3, 'c', false, 30), modifiedAt: '2026-01-01', owner: 'a' }];
    expect(sortFiles(files, 'modified', 'asc', 'mixed').map(item => item.id)).toEqual([1, 3, 2]);
    expect(sortFiles(files, 'size', 'desc', 'mixed').map(item => item.id)).toEqual([3, 1, 2]);
    expect(sortFiles(files, 'owner', 'asc', 'mixed').map(item => item.id)).toEqual([3, 1, 2]);
    expect(files.map(item => item.id)).toEqual([1, 2, 3]);
  });

  it('keeps folders grouped at the top after the selected value sort', () => {
    const files = [file(1, 'a', false), file(2, 'z', true), file(3, 'b', false), file(4, 'a', true)];
    expect(sortFiles(files, 'name', 'asc', 'top').map(item => item.id)).toEqual([4, 2, 1, 3]);
    expect(sortFiles(files, 'name', 'asc', 'mixed').map(item => item.id)).toEqual([1, 4, 3, 2]);
  });
});
