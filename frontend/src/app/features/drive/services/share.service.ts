import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { firstValueFromAbortable } from '../upload/abortable-observable';

export interface EncryptedFileMetadata {
  encrypted_name: string;
  size_bytes: number;
  storage_provider?: 'local' | 'google_drive';
}

@Injectable({ providedIn: 'root' })
export class ShareService {
  private static readonly MAX_RANGE_SIZE = 4_194_320;
  private readonly http = inject(HttpClient);

  getSharedFileMetadata(shareId: string): Observable<EncryptedFileMetadata> {
    return this.http.get<EncryptedFileMetadata>(`${environment.apiUrl}/share/${shareId}`);
  }

  downloadSharedFile(shareId: string): Observable<Blob> {
    return this.http.get(`${environment.apiUrl}/share/${shareId}/download`, {
      responseType: 'blob'
    });
  }

  downloadSharedFileRange(shareId: string, start: number, end: number): Observable<Blob> {
    return this.http.get(`${environment.apiUrl}/share/${shareId}/download`, {
      headers: { Range: `bytes=${start}-${end}` },
      responseType: 'blob'
    });
  }

  async downloadSharedFileInRanges(
    shareId: string,
    totalSize: number,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<Blob> {
    if (totalSize <= 0) {
      return firstValueFromAbortable(this.downloadSharedFile(shareId), signal);
    }

    const chunks: Blob[] = [];
    for (let start = 0; start < totalSize; start += ShareService.MAX_RANGE_SIZE) {
      const end = Math.min(start + ShareService.MAX_RANGE_SIZE - 1, totalSize - 1);
      chunks.push(await firstValueFromAbortable(this.downloadSharedFileRange(shareId, start, end), signal));
      onProgress?.(end + 1, totalSize);
    }

    return new Blob(chunks, { type: 'application/octet-stream' });
  }
}
