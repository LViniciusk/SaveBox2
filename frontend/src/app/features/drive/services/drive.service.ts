import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { BatchUploadRequestItem, BatchUploadResponseItem, FolderBatchResponseItem } from '../upload/upload.models';
import { firstValueFromAbortable } from '../upload/abortable-observable';
import { StorageProvider, StorageTarget } from '../state/drive.types';
import { StorageMoveJob } from '../storage-move/storage-move.models';
import { DRIVE_TRANSFER_CHUNK_SIZE } from '../transfer-limits';

function normalizeAccountPicture(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const picture = value.trim();
  return picture.startsWith('https://') && picture.length <= 2048 ? picture : undefined;
}

export interface QuotaResponse {
  used_bytes: number;
  max_bytes: number;
  gdrive_used_bytes?: number;
  gdrive_max_bytes?: number;
}

interface DriveFolderDto {
  id: number;
  parent_id: number | null;
  encrypted_name: string;
}

interface DriveFileDto {
  id: number;
  folder_id: number | null;
  encrypted_name: string;
  size_bytes: number;
  encrypted_fdk: string;
  is_hidden: boolean;
  storage_provider: StorageProvider;
  external_storage_id: number | null;
  mime_type?: string;
}

export interface TreeResponse {
  folders: DriveFolderDto[];
  files: DriveFileDto[];
  has_more: boolean;
}

export interface StorageTreeResponse {
  target: {
    provider: StorageProvider;
    external_storage_id: number | null;
  };
  current_folder_id: number | null;
  folders: DriveFolderDto[];
  files: DriveFileDto[];
  total_files: number;
  has_more: boolean;
  file_limit: number;
  file_offset: number;
}

interface PinnedFolderReference {
  folder_id: number;
  position: number;
}

export interface PinnedFoldersResponse {
  folders: PinnedFolderReference[];
}

export interface BatchInitUploadsResponse {
  files: BatchUploadResponseItem[];
}

export interface BatchCreateFoldersResponse {
  folders: FolderBatchResponseItem[];
}

export interface ExternalUploadRecoveryContext {
  storage_provider: 'google_drive';
  external_storage_id: number;
  name_hash: string;
}

export type ExternalUploadSessionResponse =
  | { status: 'upload'; session_uri: string; access_token: string }
  | { status: 'completed'; external_file_id: string };

@Injectable({ providedIn: 'root' })
export class DriveService {
  private readonly http = inject(HttpClient);

  getQuota(): Observable<QuotaResponse> {
    return this.http.get<QuotaResponse>(`${environment.apiUrl}/users/me/quota`, {
      withCredentials: true,
    });
  }

  getTree(fileLimit?: number, fileOffset = 0, includeFolders?: boolean): Observable<TreeResponse> {
    let url = fileLimit === undefined
      ? `${environment.apiUrl}/tree`
      : `${environment.apiUrl}/tree?file_limit=${fileLimit}&file_offset=${fileOffset}`;
    if (fileLimit !== undefined && includeFolders !== undefined) {
      url += `&include_folders=${includeFolders}`;
    }
    return this.http.get<TreeResponse>(url, {
      withCredentials: true,
    });
  }

  getPinnedFolders(): Observable<PinnedFoldersResponse> {
    return this.http.get<PinnedFoldersResponse>(`${environment.apiUrl}/folders/pinned`, {
      withCredentials: true,
    });
  }

  pinFolder(folderId: number): Observable<void> {
    return this.http.put<void>(`${environment.apiUrl}/folders/${folderId}/pin`, null, {
      withCredentials: true,
    });
  }

  unpinFolder(folderId: number): Observable<void> {
    return this.http.delete<void>(`${environment.apiUrl}/folders/${folderId}/pin`, {
      withCredentials: true,
    });
  }

  reorderPinnedFolders(folderIds: readonly number[]): Observable<void> {
    return this.http.put<void>(`${environment.apiUrl}/folders/pinned/order`, {
      folder_ids: [...folderIds],
    }, {
      withCredentials: true,
    });
  }

  createFolder(encryptedName: string, nameHash: string, parentId: number | null): Observable<{id: number}> {
    const body = {
      encrypted_name: encryptedName,
      name_hash: nameHash,
      parent_id: parentId
    };
    return this.http.post<{id: number}>(`${environment.apiUrl}/folders`, body, {
      withCredentials: true,
    });
  }

  initFileUpload(
    folderId: number | null, 
    encryptedName: string, 
    nameHash: string, 
    encryptedFdk: string, 
    sizeBytes: number, 
    totalChunks: number, 
    storageProvider: string = 'local',
    proxyExternalFileId?: string,
    proxySizeBytes?: number,
    proxyEncryptedFdk?: string,
    isHidden: boolean = false
  ): Observable<{file_id: number, storage_provider?: string}> {
    const body: any = {
      folder_id: folderId ?? null,
      encrypted_name: encryptedName,
      name_hash: nameHash,
      encrypted_fdk: encryptedFdk,
      size_bytes: sizeBytes,
      total_chunks: totalChunks,
      storage_provider: storageProvider,
      is_hidden: isHidden
    };
    
    if (proxyExternalFileId) body.proxy_external_file_id = proxyExternalFileId;
    if (proxySizeBytes !== undefined) body.proxy_size_bytes = proxySizeBytes;
    if (proxyEncryptedFdk) body.proxy_encrypted_fdk = proxyEncryptedFdk;

    return this.http.post<{file_id: number, storage_provider?: string}>(`${environment.apiUrl}/files`, body, {
      withCredentials: true,
    });
  }

  batchInitUploads(files: readonly BatchUploadRequestItem[]): Observable<BatchInitUploadsResponse> {
    return this.http.post<BatchInitUploadsResponse>(`${environment.apiUrl}/files/batch-init`, { files }, {
      withCredentials: true,
    });
  }

  batchCreateFolders(rootParentId: number | null, folders: readonly {
    client_ref: string;
    parent_client_ref: string | null;
    encrypted_name: string;
    name_hash: string;
  }[]): Observable<BatchCreateFoldersResponse> {
    return this.http.post<BatchCreateFoldersResponse>(`${environment.apiUrl}/folders/batch-create`, {
      root_parent_id: rootParentId,
      folders,
    }, { withCredentials: true });
  }

  uploadChunk(fileId: number, chunkIndex: number, chunkBlob: Blob): Observable<void> {
    return this.http.post<void>(`${environment.uploadApiUrl}/files/${fileId}/chunks`, chunkBlob, {
      headers: {
        'X-Chunk-Index': chunkIndex.toString()
      },
      withCredentials: true,
    });
  }

  getUploadedChunks(fileId: number): Observable<{ uploaded_chunks: number[] }> {
    return this.http.get<{ uploaded_chunks: number[] }>(`${environment.apiUrl}/files/${fileId}/uploaded-chunks`, {
      withCredentials: true,
    });
  }

  getPendingUploads(): Observable<{ pending_uploads: any[] }> {
    return this.http.get<{ pending_uploads: any[] }>(`${environment.apiUrl}/pending-uploads`, {
      withCredentials: true,
    });
  }

  getExternalUploadRecoveryContext(fileId: number): Observable<ExternalUploadRecoveryContext> {
    return this.http.get<ExternalUploadRecoveryContext>(
      `${environment.apiUrl}/files/${fileId}/external-upload-recovery-context`,
      { withCredentials: true },
    );
  }

  createExternalUploadSession(fileId: number): Observable<ExternalUploadSessionResponse> {
    return this.http.post<ExternalUploadSessionResponse>(
      `${environment.apiUrl}/files/${fileId}/external-upload-session`,
      {},
      { withCredentials: true },
    );
  }

  cancelExternalUpload(fileId: number): Observable<{ status: 'cleanup_pending' }> {
    return this.http.post<{ status: 'cleanup_pending' }>(
      `${environment.apiUrl}/files/${fileId}/external-upload-cancel`,
      {},
      { withCredentials: true },
    );
  }

  downloadPendingUploadRecoveryPrefix(fileId: number, endInclusive: number): Observable<Blob> {
    if (!Number.isInteger(endInclusive) || endInclusive < 0 || endInclusive >= DRIVE_TRANSFER_CHUNK_SIZE) {
      throw new Error('Range de recovery inválido');
    }
    return this.http.get(`${environment.apiUrl}/files/${fileId}/pending-upload-recovery-prefix`, {
      headers: new HttpHeaders().set('Range', `bytes=0-${endInclusive}`),
      observe: 'response',
      responseType: 'blob',
      withCredentials: true,
    }).pipe(
      map(response => {
        if (response.status !== 206 || !response.body) throw new Error('Resposta de recovery inválida');
        return response.body;
      }),
    );
  }

  downloadFile(fileId: number): Observable<Blob> {
    return this.http.get(`${environment.apiUrl}/files/${fileId}/download`, {
      responseType: 'blob',
      withCredentials: true,
    });
  }

  downloadFileRange(fileId: number, start: number, end: number): Observable<Blob> {
    return this.http.get(`${environment.apiUrl}/files/${fileId}/download`, {
      headers: new HttpHeaders().set('Range', `bytes=${start}-${end}`),
      observe: 'response',
      responseType: 'blob',
      withCredentials: true,
    }).pipe(
      map(response => {
        if ((response.status !== 200 && response.status !== 206) || !response.body) {
          throw new Error('Resposta Range inválida');
        }
        return response.body;
      })
    );
  }

  async downloadFileInRanges(fileId: number, totalSize: number, signal?: AbortSignal): Promise<Blob> {
    if (totalSize <= 0) throw new Error('Tamanho criptografado desconhecido');

    const chunks: Blob[] = [];
    const rangeSize = DRIVE_TRANSFER_CHUNK_SIZE;
    for (let start = 0; start < totalSize; start += rangeSize) {
      const end = Math.min(start + rangeSize - 1, totalSize - 1);
      chunks.push(await firstValueFromAbortable(this.downloadFileRange(fileId, start, end), signal));
    }
    return new Blob(chunks, { type: 'application/octet-stream' });
  }

  downloadExternalMetadata(fileId: number): Observable<{ storage_provider: string, external_file_id: string, access_token: string }> {
    return this.http.get<{ storage_provider: string, external_file_id: string, access_token: string }>(
      `${environment.apiUrl}/files/${fileId}/download`, {
        withCredentials: true,
      }
    );
  }

  downloadExternalFile(url: string, token: string): Observable<Blob> {
    return this.http.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      },
      responseType: 'blob'
    });
  }

  downloadExternalFileRange(url: string, token: string, start: number, end: number): Observable<Blob> {
    return this.http.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Range': `bytes=${start}-${end}`
      },
      responseType: 'blob'
    });
  }

  getLinkedGoogleAccounts(): Observable<{ accounts: Array<{
    id: number;
    account_email: string;
    account_picture?: string;
    root_folder_id?: string;
    status?: 'ready' | 'unlinking';
    }> }> {
    return this.http.get<{ accounts: Array<{
      id: number;
      account_email: string;
      account_picture?: string | null;
      root_folder_id?: string;
      status?: 'ready' | 'unlinking';
    }> }>(`${environment.apiUrl}/api/storage/google/accounts`, {
      withCredentials: true,
    }).pipe(map(response => ({
      accounts: (response.accounts ?? []).map(account => ({
        ...account,
        account_picture: normalizeAccountPicture(account.account_picture),
      })),
    })));
  }

  getStorageTargets(): Observable<StorageTarget[]> {
    return this.http.get<{ targets: Array<{
      key: string;
      provider: StorageProvider;
      label: string;
      external_storage_id: number | null;
      account_email?: string;
      account_picture?: string | null;
      used_bytes: number | null;
      max_bytes: number | null;
      available_bytes: number | null;
      nanika_used_bytes: number;
      status: StorageTarget['status'];
    }> }>(`${environment.apiUrl}/api/storage/targets`, { withCredentials: true }).pipe(
      map(response => response.targets.map(target => ({
        key: target.key,
        provider: target.provider,
        label: target.label,
        externalStorageId: target.external_storage_id,
        accountEmail: target.account_email,
        accountPicture: normalizeAccountPicture(target.account_picture),
        usedBytes: target.used_bytes,
        maxBytes: target.max_bytes,
        availableBytes: target.available_bytes,
        nanikaUsedBytes: target.nanika_used_bytes,
        status: target.status,
      })))
    );
  }

  getStorageTree(
    provider: StorageProvider,
    externalStorageId: number | null,
    folderId: number | null,
    fileLimit = 50,
    fileOffset = 0,
  ): Observable<StorageTreeResponse> {
    const params = new URLSearchParams({
      provider,
      file_limit: String(fileLimit),
      file_offset: String(fileOffset),
    });
    if (externalStorageId !== null) params.set('external_storage_id', String(externalStorageId));
    if (folderId !== null) params.set('folder_id', String(folderId));
    return this.http.get<StorageTreeResponse>(`${environment.apiUrl}/api/storage/tree?${params}`, {
      withCredentials: true,
    });
  }

  startStorageMove(fileId: number, target: StorageTarget): Observable<StorageMoveJob> {
    return this.http.post<StorageMoveJob>(`${environment.apiUrl}/files/${fileId}/storage-moves`, {
      target_provider: target.provider,
      ...(target.externalStorageId === null ? {} : { target_external_storage_id: target.externalStorageId }),
    }, { withCredentials: true });
  }

  getActiveStorageMoves(): Observable<{ moves: StorageMoveJob[] }> {
    return this.http.get<{ moves: StorageMoveJob[] }>(`${environment.apiUrl}/storage-moves/active`, { withCredentials: true });
  }

  getStorageMove(moveId: number): Observable<StorageMoveJob> {
    return this.http.get<StorageMoveJob>(`${environment.apiUrl}/storage-moves/${moveId}`, { withCredentials: true });
  }

  pauseStorageMove(moveId: number): Observable<StorageMoveJob> {
    return this.http.post<StorageMoveJob>(`${environment.apiUrl}/storage-moves/${moveId}/pause`, {}, { withCredentials: true });
  }

  resumeStorageMove(moveId: number): Observable<StorageMoveJob> {
    return this.http.post<StorageMoveJob>(`${environment.apiUrl}/storage-moves/${moveId}/resume`, {}, { withCredentials: true });
  }

  cancelStorageMove(moveId: number, items: readonly { item_id: number; target_external_file_id: string }[] = []): Observable<StorageMoveJob> {
    return this.http.delete<StorageMoveJob>(`${environment.apiUrl}/storage-moves/${moveId}`, {
      body: items.length ? { items } : undefined,
      withCredentials: true,
    });
  }

  clearStorageMove(moveId: number): Observable<void> {
    return this.http.delete<void>(`${environment.apiUrl}/storage-moves/${moveId}/clear`, { withCredentials: true });
  }

  reportStorageMoveFailure(moveId: number, errorCode: string, stage: string, retryable: boolean,
                           items: readonly { item_id: number; target_external_file_id: string }[] = []): Observable<StorageMoveJob> {
    return this.http.post<StorageMoveJob>(`${environment.apiUrl}/storage-moves/${moveId}/failure`, {
      error_code: errorCode,
      stage,
      retryable,
      ...(items.length ? { items } : {}),
    }, { withCredentials: true });
  }

  reportStorageMoveProgress(moveId: number, itemId: number, transferredBytes: number): Observable<StorageMoveJob> {
    return this.http.post<StorageMoveJob>(`${environment.apiUrl}/storage-moves/${moveId}/progress`, {
      item_id: itemId,
      transferred_bytes: transferredBytes,
    }, { withCredentials: true });
  }

  getStorageMoveSource(moveId: number, itemId: number): Observable<{
    provider: 'google_drive';
    external_file_id: string;
    external_storage_id: number;
    access_token: string;
    size_bytes: number;
  }> {
    return this.http.get<{
      provider: 'google_drive'; external_file_id: string; external_storage_id: number; access_token: string; size_bytes: number;
    }>(`${environment.apiUrl}/storage-moves/${moveId}/items/${itemId}/source`, { withCredentials: true });
  }

  downloadStorageMoveSourceRange(moveId: number, itemId: number, start: number, end: number): Observable<Blob> {
    return this.http.get(`${environment.apiUrl}/storage-moves/${moveId}/items/${itemId}/source`, {
      headers: new HttpHeaders({ Range: `bytes=${start}-${end}` }),
      responseType: 'blob',
      withCredentials: true,
    });
  }

  getStorageMoveUploadedChunks(moveId: number, itemId: number): Observable<{ uploaded_chunks: number[] }> {
    return this.http.get<{ uploaded_chunks: number[] }>(`${environment.apiUrl}/storage-moves/${moveId}/items/${itemId}/uploaded-chunks`, { withCredentials: true });
  }

  markStorageMoveTargetUploaded(moveId: number, itemId: number, targetExternalFileId?: string): Observable<StorageMoveJob> {
    return this.http.post<StorageMoveJob>(`${environment.apiUrl}/storage-moves/${moveId}/items/${itemId}/target-uploaded`,
      targetExternalFileId ? { target_external_file_id: targetExternalFileId } : {}, { withCredentials: true });
  }

  reconcileStorageMove(moveId: number): Observable<StorageMoveJob> {
    return this.http.post<StorageMoveJob>(`${environment.apiUrl}/storage-moves/${moveId}/reconcile`, {}, { withCredentials: true });
  }

  uploadStorageMoveChunk(moveId: number, itemId: number, chunkIndex: number, chunk: Blob): Observable<{ transferred_bytes: number }> {
    return this.http.put<{ transferred_bytes: number }>(`${environment.uploadApiUrl}/storage-moves/${moveId}/items/${itemId}/chunks/${chunkIndex}`, chunk, { withCredentials: true });
  }

  createStorageMoveGoogleSession(moveId: number, itemId: number): Observable<{ session_uri: string; access_token: string }> {
    return this.http.post<{ session_uri: string; access_token: string }>(`${environment.apiUrl}/storage-moves/${moveId}/items/${itemId}/google-session`, {}, { withCredentials: true });
  }

  completeStorageMove(moveId: number): Observable<StorageMoveJob> {
    return this.http.post<StorageMoveJob>(`${environment.apiUrl}/storage-moves/${moveId}/complete`, {}, { withCredentials: true });
  }

  unlinkGoogleAccount(accountId: number): Observable<any> {
    return this.http.delete(`${environment.apiUrl}/api/storage/google/accounts/${accountId}`, {
      withCredentials: true,
    });
  }

  generateGoogleState(): Observable<{ state: string }> {
    return this.http.get<{ state: string }>(`${environment.apiUrl}/api/storage/google/generate-state`, {
      withCredentials: true,
    });
  }

  finalizeExternalUpload(fileId: number, externalFileId: string): Observable<any> {
    return this.http.post(`${environment.apiUrl}/files/${fileId}/finalize-external`, {
      external_file_id: externalFileId
    }, {
      withCredentials: true,
    });
  }

  /** Soft-delete (trash) a single file by ID */
  trashFile(fileId: number): Observable<void> {
    return this.http.delete<void>(`${environment.apiUrl}/files/${fileId}`, {
      withCredentials: true,
    });
  }

  /** Hard-delete (permanent) a single file by ID (must be in trash first) */
  hardDeleteFile(fileId: number): Observable<void> {
    return this.http.delete<void>(`${environment.apiUrl}/trash/files/${fileId}`, {
      withCredentials: true,
    });
  }

  batchSoftDeleteFiles(fileIds: number[]): Observable<void> {
    return this.http.request<void>('delete', `${environment.apiUrl}/files/batch-delete`, {
      body: { file_ids: fileIds },
      withCredentials: true
    });
  }

  batchHardDeleteFiles(fileIds: number[]): Observable<void> {
    return this.http.request<void>('delete', `${environment.apiUrl}/trash/files/batch-delete`, {
      body: { file_ids: fileIds },
      withCredentials: true
    });
  }

  updateFile(fileId: number, body: { encrypted_name?: string; name_hash?: string; folder_id?: number | null }): Observable<any> {
    return this.http.put(`${environment.apiUrl}/files/${fileId}`, body, {
      withCredentials: true,
    });
  }

  updateFolder(folderId: number, body: { encrypted_name?: string; name_hash?: string; parent_id?: number | null }): Observable<any> {
    return this.http.put(`${environment.apiUrl}/folders/${folderId}`, body, {
      withCredentials: true,
    });
  }

  trashFolder(folderId: number): Observable<void> {
    return this.http.delete<void>(`${environment.apiUrl}/folders/${folderId}`, {
      withCredentials: true,
    });
  }

  batchSoftDeleteFolders(folderIds: number[]): Observable<void> {
    return this.http.request<void>('delete', `${environment.apiUrl}/folders/batch-delete`, {
      body: { folder_ids: folderIds },
      withCredentials: true
    });
  }

  getTrash(): Observable<{ folders: any[]; files: any[] }> {
    return this.http.get<{ folders: any[]; files: any[] }>(`${environment.apiUrl}/trash`, {
      withCredentials: true,
    });
  }

  restoreFile(fileId: number): Observable<void> {
    return this.http.post<void>(`${environment.apiUrl}/files/${fileId}/restore`, {}, {
      withCredentials: true,
    });
  }

  restoreFolder(folderId: number): Observable<void> {
    return this.http.post<void>(`${environment.apiUrl}/folders/${folderId}/restore`, {}, {
      withCredentials: true,
    });
  }

  hardDeleteFolder(folderId: number): Observable<void> {
    return this.http.delete<void>(`${environment.apiUrl}/trash/folders/${folderId}`, {
      withCredentials: true,
    });
  }

  batchHardDeleteFolders(folderIds: number[]): Observable<void> {
    return this.http.request<void>('delete', `${environment.apiUrl}/trash/folders/batch-delete`, {
      body: { folder_ids: folderIds },
      withCredentials: true
    });
  }

  emptyTrash(): Observable<any> {
    return this.http.delete(`${environment.apiUrl}/trash/empty`, {
      withCredentials: true,
    });
  }

  createShareLink(fileId: number, encryptedNameFdk: string): Observable<{ share_id: string }> {
    return this.http.post<{ share_uuid: string }>(`${environment.apiUrl}/files/${fileId}/share`, {
      encrypted_name_fdk: encryptedNameFdk,
    }, {
      withCredentials: true
    }).pipe(
      map(res => ({ share_id: res.share_uuid }))
    );
  }

  listShares(fileId: number): Observable<{ id: number, share_id: string, created_at: string }[]> {
    return this.http.get<{ id: number, share_id: string, created_at: string }[]>(`${environment.apiUrl}/files/${fileId}/shares`, {
      withCredentials: true
    });
  }

  revokeShare(shareId: string): Observable<void> {
    return this.http.delete<void>(`${environment.apiUrl}/shares/${shareId}`, {
      withCredentials: true
    });
  }
}
