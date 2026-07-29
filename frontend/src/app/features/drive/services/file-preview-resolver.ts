import { DriveFile } from '../state/drive.store';

export type FilePreviewKind = 'image' | 'video' | 'audio' | 'unsupported';

export interface FilePreviewRequest {
  file: DriveFile;
  playlist: readonly DriveFile[];
}

export function resolveFilePreviewKind(file: Pick<DriveFile, 'type' | 'decryptedName' | 'encryptedName' | 'mimeType'>): FilePreviewKind {
  const mime = file.mimeType?.toLowerCase() ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';

  if (file.type === 'image' || file.type === 'video' || file.type === 'audio') return file.type;

  const name = (file.decryptedName || file.encryptedName).toLowerCase();
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'].includes(extension)) return 'image';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v'].includes(extension)) return 'video';
  if (['mp3', 'wav', 'ogg', 'oga', 'opus', 'aac', 'flac', 'm4a'].includes(extension)) return 'audio';
  return 'unsupported';
}

export function previewMimeType(file: Pick<DriveFile, 'type' | 'decryptedName' | 'encryptedName' | 'mimeType'>): string {
  if (file.mimeType) return file.mimeType;
  const kind = resolveFilePreviewKind(file);
  const name = (file.decryptedName || file.encryptedName).toLowerCase();
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const mimeByExtension: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', avif: 'image/avif', mp4: 'video/mp4', mkv: 'video/x-matroska',
    avi: 'video/x-msvideo', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus',
    aac: 'audio/aac', flac: 'audio/flac', m4a: 'audio/mp4',
  };
  return mimeByExtension[extension] ?? (kind === 'audio' ? 'audio/mpeg' : kind === 'video' ? 'video/mp4' : 'application/octet-stream');
}
