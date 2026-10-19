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

  describe('characterization matrix', () => {
    it('preserves MIME precedence and case-insensitive recognized prefixes', () => {
      const cases: Array<[string, Partial<DriveFile>, string]> = [
        ['image MIME wins over type and extension', { mimeType: 'image/png', type: 'video', decryptedName: 'song.mp3' }, 'image'],
        ['video MIME wins over type and extension', { mimeType: 'VIDEO/custom', type: 'audio', decryptedName: 'photo.jpg' }, 'video'],
        ['audio MIME wins over type and extension', { mimeType: 'AuDiO/custom', type: 'image', decryptedName: 'clip.mp4' }, 'audio'],
      ];

      cases.forEach(([, values, expected]) => {
        expect(resolveFilePreviewKind(file(values))).toBe(expected as 'image' | 'video' | 'audio');
      });
    });

    it('falls through unknown and malformed MIME values without broadening recognition', () => {
      expect(resolveFilePreviewKind(file({ mimeType: 'application/pdf', decryptedName: 'photo.jpg' }))).toBe('image');
      expect(resolveFilePreviewKind(file({ mimeType: 'text/plain', type: 'video' }))).toBe('video');
      expect(resolveFilePreviewKind(file({ mimeType: 'image', decryptedName: 'archive.zip' }))).toBe('unsupported');
      expect(resolveFilePreviewKind(file({ mimeType: 'image; charset=utf-8', decryptedName: 'archive.zip' }))).toBe('unsupported');
    });

    it('recognizes valid MIME values with parameters by their prefix', () => {
      const cases = [
        ['image/png; charset=utf-8', 'image'],
        ['video/webm; codecs=vp9', 'video'],
        ['audio/ogg; codecs=opus', 'audio'],
      ] as const;

      cases.forEach(([mimeType, expected]) => {
        expect(resolveFilePreviewKind(file({ mimeType, type: 'unknown', decryptedName: 'archive.bin' })))
          .withContext(mimeType)
          .toBe(expected);
      });
    });

    it('preserves exact and case-sensitive file.type precedence', () => {
      const recognized: Array<['image' | 'video' | 'audio', string]> = [
        ['image', 'video.mp4'],
        ['video', 'song.mp3'],
        ['audio', 'photo.jpg'],
      ];
      recognized.forEach(([type, decryptedName]) => {
        expect(resolveFilePreviewKind(file({ type, decryptedName }))).toBe(type);
      });

      ['IMAGE', 'VIDEO', 'AUDIO'].forEach((type) => {
        expect(resolveFilePreviewKind(file({ type, decryptedName: 'archive.zip' }))).toBe('unsupported');
      });
    });

    it('recognizes every supported image, video and audio extension', () => {
      const extensions: Array<[string[], 'image' | 'video' | 'audio']> = [
        [['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'], 'image'],
        [['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v'], 'video'],
        [['mp3', 'wav', 'ogg', 'oga', 'opus', 'aac', 'flac', 'm4a'], 'audio'],
      ];

      extensions.forEach(([values, expected]) => {
        values.forEach((extension) => {
          expect(resolveFilePreviewKind(file({ decryptedName: `asset.${extension}` }))).toBe(expected);
        });
      });
    });

    it('preserves extension extraction edge cases and name fallback semantics', () => {
      expect(resolveFilePreviewKind(file({ decryptedName: 'photo.FINAL.JPG' }))).toBe('image');
      expect(resolveFilePreviewKind(file({ decryptedName: 'movie.v2.MP4' }))).toBe('video');
      expect(resolveFilePreviewKind(file({ decryptedName: 'track' }))).toBe('unsupported');
      expect(resolveFilePreviewKind(file({ decryptedName: 'file.' }))).toBe('unsupported');
      expect(resolveFilePreviewKind(file({ decryptedName: '.jpg' }))).toBe('image');
      expect(resolveFilePreviewKind(file({ decryptedName: 'unknown.bin' }))).toBe('unsupported');
      expect(resolveFilePreviewKind(file({ decryptedName: 'archive.zip', encryptedName: 'photo.jpg' }))).toBe('unsupported');
      expect(resolveFilePreviewKind(file({ decryptedName: null, encryptedName: 'photo.jpg' }))).toBe('image');
      expect(resolveFilePreviewKind(file({ decryptedName: '', encryptedName: 'photo.jpg' }))).toBe('image');
    });

    it('preserves explicit MIME literals and all extension MIME mappings', () => {
      expect(previewMimeType(file({ mimeType: 'VIDEO/MP4', decryptedName: 'clip.unknown' }))).toBe('VIDEO/MP4');
      expect(previewMimeType(file({ mimeType: 'application/custom', decryptedName: 'clip.mp4' }))).toBe('application/custom');

      const mappings: Array<[string, string]> = [
        ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'], ['gif', 'image/gif'],
        ['webp', 'image/webp'], ['bmp', 'image/bmp'], ['avif', 'image/avif'], ['mp4', 'video/mp4'],
        ['mkv', 'video/x-matroska'], ['avi', 'video/x-msvideo'], ['mov', 'video/quicktime'],
        ['webm', 'video/webm'], ['m4v', 'video/x-m4v'], ['mp3', 'audio/mpeg'], ['wav', 'audio/wav'],
        ['ogg', 'audio/ogg'], ['oga', 'audio/ogg'], ['opus', 'audio/opus'], ['aac', 'audio/aac'],
        ['flac', 'audio/flac'], ['m4a', 'audio/mp4'],
      ];
      mappings.forEach(([extension, expected]) => {
        expect(previewMimeType(file({ decryptedName: `asset.${extension}` }))).toBe(expected);
      });
    });

    it('preserves preview MIME defaults and octet-stream fallbacks', () => {
      expect(previewMimeType(file({ type: 'audio', decryptedName: 'track.unknown' }))).toBe('audio/mpeg');
      expect(previewMimeType(file({ type: 'video', decryptedName: 'movie.unknown' }))).toBe('video/mp4');
      expect(previewMimeType(file({ type: 'image', decryptedName: 'photo.unknown' }))).toBe('application/octet-stream');
      expect(previewMimeType(file({ decryptedName: 'archive.zip' }))).toBe('application/octet-stream');
    });

    it('does not treat prototype-like type or extension names as supported previews', () => {
      const cases: Array<Partial<DriveFile>> = [
        { type: 'constructor', decryptedName: 'archive.zip' },
        { type: '__proto__', decryptedName: 'archive.zip' },
        { type: 'unknown', decryptedName: 'asset.constructor' },
        { type: 'unknown', decryptedName: 'asset.__proto__' },
      ];

      cases.forEach((values) => {
        expect(resolveFilePreviewKind(file(values))).toBe('unsupported');
      });
    });
  });
});
