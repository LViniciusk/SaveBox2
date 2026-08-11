import type { DriveFile } from '../state/drive.store';

export type FilePreviewKind = 'image' | 'video' | 'audio' | 'unsupported';

export interface FilePreviewRequest {
  file: DriveFile;
  playlist: readonly DriveFile[];
}

type SupportedPreviewKind = Exclude<FilePreviewKind, 'unsupported'>;

type PreviewFile = Pick<DriveFile, 'type' | 'decryptedName' | 'encryptedName' | 'mimeType'>;

interface ExtensionPreviewMetadata {
  readonly kind: SupportedPreviewKind;
  readonly mimeType: string;
}

const MIME_KIND_BY_PREFIX: ReadonlyArray<readonly [string, SupportedPreviewKind]> = [
  ['image/', 'image'],
  ['video/', 'video'],
  ['audio/', 'audio'],
];

const TYPE_KIND: ReadonlyMap<string, SupportedPreviewKind> = new Map([
  ['image', 'image'],
  ['video', 'video'],
  ['audio', 'audio'],
]);

const EXTENSION_METADATA: ReadonlyMap<string, ExtensionPreviewMetadata> = new Map([
  ['jpg', { kind: 'image', mimeType: 'image/jpeg' }],
  ['jpeg', { kind: 'image', mimeType: 'image/jpeg' }],
  ['png', { kind: 'image', mimeType: 'image/png' }],
  ['gif', { kind: 'image', mimeType: 'image/gif' }],
  ['webp', { kind: 'image', mimeType: 'image/webp' }],
  ['bmp', { kind: 'image', mimeType: 'image/bmp' }],
  ['avif', { kind: 'image', mimeType: 'image/avif' }],
  ['mp4', { kind: 'video', mimeType: 'video/mp4' }],
  ['mkv', { kind: 'video', mimeType: 'video/x-matroska' }],
  ['avi', { kind: 'video', mimeType: 'video/x-msvideo' }],
  ['mov', { kind: 'video', mimeType: 'video/quicktime' }],
  ['webm', { kind: 'video', mimeType: 'video/webm' }],
  ['m4v', { kind: 'video', mimeType: 'video/x-m4v' }],
  ['mp3', { kind: 'audio', mimeType: 'audio/mpeg' }],
  ['wav', { kind: 'audio', mimeType: 'audio/wav' }],
  ['ogg', { kind: 'audio', mimeType: 'audio/ogg' }],
  ['oga', { kind: 'audio', mimeType: 'audio/ogg' }],
  ['opus', { kind: 'audio', mimeType: 'audio/opus' }],
  ['aac', { kind: 'audio', mimeType: 'audio/aac' }],
  ['flac', { kind: 'audio', mimeType: 'audio/flac' }],
  ['m4a', { kind: 'audio', mimeType: 'audio/mp4' }],
]);

const DEFAULT_MIME_BY_KIND = {
  image: 'application/octet-stream',
  video: 'video/mp4',
  audio: 'audio/mpeg',
  unsupported: 'application/octet-stream',
} as const satisfies Readonly<Record<FilePreviewKind, string>>;

function extensionOf(
  file: Pick<DriveFile, 'decryptedName' | 'encryptedName'>,
): string {
  const name = (file.decryptedName || file.encryptedName).toLowerCase();
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
}

function mimeKindOf(mimeType: string | null | undefined): SupportedPreviewKind | undefined {
  const mime = mimeType ? mimeType.toLowerCase() : '';
  const match = MIME_KIND_BY_PREFIX.find(([prefix]) => mime.startsWith(prefix));
  return match ? match[1] : undefined;
}

export function resolveFilePreviewKind(file: PreviewFile): FilePreviewKind {
  const mimeKind = mimeKindOf(file.mimeType);
  if (mimeKind) return mimeKind;

  const typeKind = TYPE_KIND.get(file.type);
  if (typeKind) return typeKind;

  const extensionMetadata = EXTENSION_METADATA.get(extensionOf(file));
  if (extensionMetadata) return extensionMetadata.kind;
  return 'unsupported';
}

export function previewMimeType(file: PreviewFile): string {
  if (file.mimeType) return file.mimeType;
  const extensionMetadata = EXTENSION_METADATA.get(extensionOf(file));
  if (extensionMetadata) return extensionMetadata.mimeType;

  return DEFAULT_MIME_BY_KIND[resolveFilePreviewKind(file)];
}
