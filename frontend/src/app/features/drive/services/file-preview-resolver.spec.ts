import { DriveFile } from '../state/drive.store';
import { previewMimeType, resolveFilePreviewKind } from './file-preview-resolver';

describe('file preview resolver', () => {
  const file = (values: Partial<DriveFile>): DriveFile => ({
    id: 1, isFolder: false, encryptedName: 'cipher', decryptedName: null, type: 'unknown',
    sizeBytes: 1, sizeFormatted: '1 B', modifiedAt: '', owner: '', storageProvider: 'local', externalStorageId: null, ...values,
  });

  it('prioritizes MIME information and supports audio extensions', () => {
    expect(resolveFilePreviewKind(file({ type: 'unknown', decryptedName: 'song.m4a' }))).toBe('audio');
    expect(resolveFilePreviewKind(file({ type: 'unknown', decryptedName: 'clip.webm', mimeType: 'audio/webm' }))).toBe('audio');
    expect(resolveFilePreviewKind(file({ type: 'unknown', decryptedName: 'clip.webm', mimeType: 'video/webm' }))).toBe('video');
    expect(previewMimeType(file({ type: 'audio', decryptedName: 'song.m4a' }))).toBe('audio/mp4');
  });

  it('does not reveal an unsupported type as a preview', () => {
    expect(resolveFilePreviewKind(file({ decryptedName: 'archive.zip' }))).toBe('unsupported');
  });
});
