import { DriveFile } from '../state/drive.store';
import { getPublicShareAvailability } from './public-share-policy';

describe('getPublicShareAvailability', () => {
  const file = (overrides: Partial<DriveFile> = {}): DriveFile => ({
    id: 1,
    isFolder: false,
    encryptedName: 'ciphertext',
    decryptedName: null,
    type: 'generic',
    sizeBytes: 1,
    sizeFormatted: '1 B',
    modifiedAt: '',
    owner: '',
    storageProvider: 'local',
    ...overrides,
  });

  it('allows local files', () => {
    expect(getPublicShareAvailability(file()).allowed).toBeTrue();
  });

  it('blocks Google Drive files', () => {
    expect(getPublicShareAvailability(file({ storageProvider: 'google_drive' }))).toEqual({
      allowed: false,
      reason: 'google_drive',
      message: 'O compartilhamento público não está disponível para arquivos armazenados no Google Drive.',
    });
  });

  it('blocks folders', () => {
    expect(getPublicShareAvailability(file({ isFolder: true }))).toEqual({
      allowed: false,
      reason: 'folder',
      message: 'Pastas não podem ser compartilhadas publicamente.',
    });
  });

  it('does not infer the provider from name, MIME or external metadata', () => {
    const availability = getPublicShareAvailability(file({
      encryptedName: 'google-drive.mp4',
      mimeType: 'video/google-drive',
      proxyExternalFileId: 'external-id',
    }));
    expect(availability.allowed).toBeTrue();
  });
});
