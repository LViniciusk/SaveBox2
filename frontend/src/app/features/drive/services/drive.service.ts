import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface QuotaResponse {
  used_bytes: number;
  max_bytes: number;
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

  initFileUpload(folderId: number | null, encryptedName: string, nameHash: string, encryptedFdk: string, sizeBytes: number): Observable<{file_id: number}> {
    const body = {
      folder_id: folderId,
      encrypted_name: encryptedName,
      name_hash: nameHash,
      encrypted_fdk: encryptedFdk,
      size_bytes: sizeBytes
    };
    return this.http.post<{file_id: number}>(`${environment.apiUrl}/files`, body, {
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

  downloadFile(fileId: number): Observable<Blob> {
    return this.http.get(`${environment.apiUrl}/files/${fileId}/download`, {
      responseType: 'blob',
      withCredentials: true,
    });
  }
}
