import { DriveFile } from '../state/drive.store';

const GOOGLE_DRIVE_SHARING_UNAVAILABLE =
  'O compartilhamento público não está disponível para arquivos armazenados no Google Drive.';

export type PublicShareAvailability =
  | { allowed: true }
  | { allowed: false; reason: 'folder' | 'google_drive'; message: string };

export function getPublicShareAvailability(
  file: Pick<DriveFile, 'isFolder' | 'storageProvider'>,
): PublicShareAvailability {
  if (file.isFolder) {
    return {
      allowed: false,
      reason: 'folder',
      message: 'Pastas não podem ser compartilhadas publicamente.',
    };
  }
  if (file.storageProvider === 'google_drive') {
    return { allowed: false, reason: 'google_drive', message: GOOGLE_DRIVE_SHARING_UNAVAILABLE };
  }
  return { allowed: true };
}
