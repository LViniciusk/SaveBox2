export type UploadProvider = 'local' | 'google_drive';

export interface UploadPlan {
  file: File;
  encryptedName: string;
  nameHash: string;
  encryptedFdk: string;
  fdk: Uint8Array;
  totalChunks: number;
  encryptedSize: number;
  /** Encrypted metadata thumbnail kept client-side for optimistic tree updates. */
  thumbnail?: string;
}

export interface GoogleUploadPlan extends UploadPlan {
  baseNonce: Uint8Array;
  /** Exact metadata plaintext required to reproduce contextual recovery ciphertext. */
  rematerializationMetadata?: string;
}

export interface GoogleUploadSession {
  session_uri: string;
  access_token: string;
}

export interface LocalUploadPlan extends UploadPlan {
  baseNonce: Uint8Array;
  /** Exact metadata plaintext required to reproduce contextual recovery ciphertext. */
  rematerializationMetadata?: string;
}

export type InitializedUpload =
  | { provider: 'local'; plan: LocalUploadPlan }
  | { provider: 'google_drive'; plan: GoogleUploadPlan };

interface UploadProgressUpdate {
  progress: number;
  transferredBytes: number;
  totalBytes: number;
}

export interface UploadExecutionControl {
  shouldPause(): boolean;
  shouldCancel(): boolean;
  shouldDetach?(): boolean;
  signal?: AbortSignal;
}

export interface UploadEngineCallbacks {
  onProgress(update: UploadProgressUpdate): void;
}

export interface UploadExecutionResult {
  paused: boolean;
  cancelled?: boolean;
  googleSession?: GoogleUploadSession;
  googleCleanupPending?: boolean;
}

export interface BatchUploadRequestItem {
  client_ref: string;
  folder_id: number | null;
  encrypted_name: string;
  name_hash: string;
  encrypted_fdk: string;
  size_bytes: number;
  total_chunks: number;
  storage_provider: UploadProvider;
}

export interface BatchUploadResponseItem {
  client_ref: string;
  file_id: number;
  name_hash: string;
  storage_provider: UploadProvider;
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
  status: 'success' | 'paused' | 'cancelled' | 'error';
  error?: unknown;
  googleSession?: GoogleUploadSession;
  googleCleanupPending?: boolean;
}

export interface UploadBatchSummary {
  total: number;
  succeeded: number;
  paused: number;
  cancelled: number;
  failed: number;
}

export class UploadAbortError extends DOMException {
  constructor() {
    super('Upload cancelled', 'AbortError');
  }
}

export class UploadPauseError extends Error {
  constructor() {
    super('Upload paused');
    this.name = 'UploadPauseError';
  }
}

export function throwIfUploadCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new UploadAbortError();
}

export interface FolderUploadFile {
  file: File;
  segments: readonly string[];
}

export interface FolderUploadSourceFile {
  file: File;
  relativePath: string;
}

export interface FolderUploadNode {
  clientRef: string;
  parentClientRef: string | null;
  name: string;
  encryptedName?: string;
  nameHash?: string;
}

export interface FolderUploadTree {
  nodes: FolderUploadNode[];
  files: Array<{ file: File; folderClientRef: string | null }>;
}

export interface FolderBatchResponseItem {
  client_ref: string;
  folder_id: number;
  created: boolean;
}

export interface FolderUploadCandidate {
  file: File;
  folderId: number | null;
}
