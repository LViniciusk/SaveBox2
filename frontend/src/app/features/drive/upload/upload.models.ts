export type UploadProvider = 'local' | 'google_drive';

export interface PreparedUpload {
  file: File;
  encryptedBlob: Blob;
  encryptedName: string;
  nameHash: string;
  encryptedFdk: string;
  fdk: Uint8Array;
  totalChunks: number;
  encryptedSize: number;
}

export interface UploadProgressUpdate {
  progress: number;
  transferredBytes: number;
  totalBytes: number;
}

export interface UploadExecutionControl {
  shouldPause(): boolean;
  shouldCancel(): boolean;
}

export interface UploadEngineCallbacks {
  onProgress(update: UploadProgressUpdate): void;
}

export interface UploadExecutionResult {
  paused: boolean;
}

export interface BatchUploadRequestItem {
  folder_id: number | null;
  encrypted_name: string;
  name_hash: string;
  encrypted_fdk: string;
  size_bytes: number;
  total_chunks: number;
  storage_provider: UploadProvider;
}

export interface BatchUploadResponseItem {
  file_id: number;
  name_hash: string;
  storage_provider: UploadProvider;
  access_token?: string;
  root_folder_id?: string;
}

export interface UploadBatchCandidate {
  file: File;
  folderId: number | null;
  transferId: string;
  provider: UploadProvider;
  control: UploadExecutionControl;
}

export interface UploadBatchResult {
  transferId: string;
  status: 'success' | 'paused' | 'error';
  error?: unknown;
}

export interface UploadBatchSummary {
  total: number;
  succeeded: number;
  paused: number;
  failed: number;
}
