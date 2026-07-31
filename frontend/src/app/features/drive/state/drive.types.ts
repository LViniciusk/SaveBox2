export type DriveView = 'drive' | 'storage' | 'computer' | 'trash' | 'transfers';

export type StorageProvider = 'local' | 'google_drive';

export type StorageTargetStatus = 'ready' | 'unavailable' | 'unlinking';

export interface StorageTarget {
  key: string;
  provider: StorageProvider;
  label: string;
  externalStorageId: number | null;
  accountEmail?: string;
  accountPicture?: string;
  usedBytes: number;
  maxBytes: number | null;
  availableBytes: number | null;
  nanikaUsedBytes: number;
  status: StorageTargetStatus;
}

export interface LinkedGoogleAccount {
  id: number;
  accountEmail: string;
  accountPicture?: string;
  rootFolderId?: string;
  status: StorageTargetStatus;
  usedBytes: number;
  maxBytes: number | null;
  availableBytes: number | null;
  nanikaUsedBytes: number;
}
