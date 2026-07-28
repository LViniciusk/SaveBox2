import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface EncryptedFileMetadata {
  encrypted_name: string;
  size_bytes: number;
  storage_provider?: 'local' | 'google_drive';
  external_file_id?: string;
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
    onProgress?: (loaded: number, total: number) => void
  ): Promise<Blob> {
    if (totalSize <= 0) {
      return firstValueFrom(this.downloadSharedFile(shareId));
    }

    const chunks: Blob[] = [];
    for (let start = 0; start < totalSize; start += ShareService.MAX_RANGE_SIZE) {
      const end = Math.min(start + ShareService.MAX_RANGE_SIZE - 1, totalSize - 1);
      chunks.push(await firstValueFrom(this.downloadSharedFileRange(shareId, start, end)));
      onProgress?.(end + 1, totalSize);
    }

    return new Blob(chunks, { type: 'application/octet-stream' });
  }
}
