import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface QuotaResponse {
  used_bytes: number;
  max_bytes: number;
  gdrive_used_bytes?: number;
  gdrive_max_bytes?: number;
}

export interface DriveFolderDto {
  id: number;
  parent_id: number | null;
  encrypted_name: string;
}

export interface DriveFileDto {
  id: number;
  folder_id: number | null;
  encrypted_name: string;
  size_bytes: number;
  encrypted_fdk: string;
  is_hidden: boolean;
}

export interface TreeResponse {
  folders: DriveFolderDto[];
  files: DriveFileDto[];
}

@Injectable({ providedIn: 'root' })
export class DriveService {
  private readonly http = inject(HttpClient);

  getQuota(): Observable<QuotaResponse> {
    return this.http.get<QuotaResponse>(`${environment.apiUrl}/users/me/quota`, {
      withCredentials: true,
    });
  }

  getTree(): Observable<TreeResponse> {
    return this.http.get<TreeResponse>(`${environment.apiUrl}/tree`, {
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
  ): Observable<{file_id: number, storage_provider?: string, access_token?: string, root_folder_id?: string}> {
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

    return this.http.post<{file_id: number, storage_provider?: string, access_token?: string, root_folder_id?: string}>(`${environment.apiUrl}/files`, body, {
      withCredentials: true,
    });
  }

  uploadChunk(fileId: number, chunkIndex: number, chunkBlob: Blob): Observable<void> {
    return this.http.post<void>(`${environment.apiUrl}/files/${fileId}/chunks`, chunkBlob, {
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

  downloadFile(fileId: number): Observable<Blob> {
    return this.http.get(`${environment.apiUrl}/files/${fileId}/download`, {
      responseType: 'blob',
      withCredentials: true,
    });
  }

  downloadFileRange(fileId: number, start: number, end: number): Observable<Blob> {
    return this.http.get(`${environment.apiUrl}/files/${fileId}/download`, {
      headers: {
        'Range': `bytes=${start}-${end}`
      },
      responseType: 'blob',
      withCredentials: true,
    });
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

  getLinkedGoogleAccounts(): Observable<any[]> {
    return this.http.get<any[]>(`${environment.apiUrl}/api/storage/google/accounts`, {
      withCredentials: true,
    });
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

  emptyTrash(): Observable<any> {
    return this.http.delete(`${environment.apiUrl}/trash/empty`, {
      withCredentials: true,
    });
  }
}
