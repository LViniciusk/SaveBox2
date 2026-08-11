import { StorageProvider } from '../state/drive.types';

type StorageMoveStatus = 'prepared' | 'transferring' | 'paused' | 'target_uploaded' |
  'committing' | 'cleanup_pending' | 'completed' | 'cancelled' | 'failed';

export interface StorageMoveItem {
  id: number;
  file_id: number;
  role: 'original' | 'proxy';
  source_external_file_id?: string;
  target_external_file_id?: string;
  total_bytes: number;
  transferred_bytes: number;
  status: 'prepared' | 'transferring' | 'target_uploaded' | 'completed' | 'cancelled' | 'failed';
}

export interface StorageMoveJob {
  id: number;
  file_id: number;
  status: StorageMoveStatus;
  source_provider: StorageProvider;
  source_external_storage_id: number | null;
  target_provider: StorageProvider;
  target_external_storage_id: number | null;
  total_bytes: number;
  transferred_bytes: number;
  error_code?: string;
  error_detail?: string;
  is_retryable: boolean;
  failure_stage?: 'prepare' | 'source_metadata' | 'source_read' | 'target_session' | 'target_write' | 'target_ack' | 'commit' | 'cleanup';
  items: StorageMoveItem[];
}

export interface StorageMoveView extends StorageMoveJob {
  fileName: string;
  sourceLabel: string;
  targetLabel: string;
  speedBytesPerSecond: number;
  etaSeconds: number | null;
  validationPending?: boolean;
  stateSyncError?: boolean;
}
