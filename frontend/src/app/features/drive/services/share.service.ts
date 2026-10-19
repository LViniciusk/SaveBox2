import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface EncryptedFileMetadata {
  encrypted_name: string;
  size_bytes: number;
  storage_provider?: 'local' | 'google_drive';
  external_file_id?: string;
}

@Injectable({ providedIn: 'root' })
export class ShareService {
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
}
