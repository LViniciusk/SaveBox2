import { ApplicationRef, inject, Injectable, signal } from '@angular/core';
import { FetchBackend, HttpBackend, HttpXhrBackend, HttpEventType, HttpInterceptorFn, provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { defer, finalize, firstValueFrom, of, tap } from 'rxjs';
import { DriveStore, DriveFile } from '../../src/app/features/drive/state/drive.store';
import { DriveService } from '../../src/app/features/drive/services/drive.service';
import { AuthService } from '../../src/app/core/auth/auth.service';
import { AppStateService } from '../../src/app/core/state/app-state.service';
import { jwtInterceptor } from '../../src/app/core/interceptors/jwt.interceptor';
import { errorInterceptor } from '../../src/app/core/interceptors/error.interceptor';
import { DialogService } from '../../src/app/core/dialog/dialog.service';
import { VideoTranscoderService } from '../../src/app/features/drive/services/video-transcoder.service';
import { UploadEngineService } from '../../src/app/features/drive/upload/upload-engine.service';
import { UploadBatchCoordinatorService } from '../../src/app/features/drive/upload/upload-batch-coordinator.service';
import { FolderUploadCoordinatorService } from '../../src/app/features/drive/upload/folder-upload-coordinator.service';
import { StorageMoveEngineService } from '../../src/app/features/drive/storage-move/storage-move-engine.service';
import { DownloadEngineService } from '../../src/app/features/drive/services/download-engine.service';
import { ThumbnailLoaderService } from '../../src/app/features/drive/services/thumbnail-loader.service';
import { validatePartialResponse, validateBounds } from './range-adapter';
import { directRange, DirectCounters, selectTransport } from './r9-transport';

export interface R8Fixture { id: number; name: string; ciphertextBytes: number; }
interface Runtime { username: string; password: string; fileIds: Record<string, number>; fdks?: Record<string, number[]>; }
declare global { interface Window { r8RefreshStore: () => Promise<Record<string, number>>; } }
export const r8Mode = (window as Window & { r8BootstrapMode?: string }).r8BootstrapMode ?? null;
const r9Transport = selectTransport((window as Window & { ap06R9Transport?: unknown }).ap06R9Transport);
if (r9Transport && r8Mode !== 'backend') throw new Error('R9_REAL_BACKEND_REQUIRED');
const realStore = r8Mode === 'store' || r8Mode === 'backend';
const backend = r8Mode === 'backend';
let fixtures: R8Fixture[] = [], runtime: Runtime | undefined, store: DriveStore | null = null;
const c = () => window.r5Counters.observed;
const unexpected = () => { c()['unexpectedPeripheralOperations']++; throw new Error('R8_UNEXPECTED_PERIPHERAL_OPERATION'); };
const peripheral = new Proxy({}, { get: (_, key) => key === 'then' ? undefined : unexpected });
const expectedId = (fixture: R8Fixture) => backend ? runtime!.fileIds[String(fixture.id)] : fixture.id;

@Injectable()
class R9DirectDriveService extends DriveService {
  private readonly session = inject(AuthService);
  override downloadFileRange(id: number, start: number, end: number) {
    return directRange(id, start, end, fixtures.map(row => ({ id: expectedId(row), ciphertextBytes: row.ciphertextBytes })),
      () => this.session.getToken(), c() as unknown as DirectCounters);
  }
}

// Observe the original HttpClient chain after JWT attachment, without replacing its transport.
export const observeR8Http: HttpInterceptorFn = (request, next) => defer(() => {
  const range = request.headers.get('Range');
  if (range && (!request.headers.has('Authorization') || !request.withCredentials)) throw new Error('R8_JWT_INTERCEPTOR_MISSING');
  let settled = false;
  c()['outstandingSubscriptions']++;
  if (range) {
    c()['rangeRequestsStarted']++; c()['activeRanges']++; c()['pendingOperations']++;
    c()['maxActiveRanges'] = Math.max(c()['maxActiveRanges'], c()['activeRanges']);
    if (range.startsWith('bytes=0-')) c()['metadataRequests']++;
    c()['jwtRangesValidated']++;
  }
  return next(request).pipe(tap({ next: event => {
    if (!range || event.type !== HttpEventType.Response) return;
    const fixture = fixtures.find(row => request.url.endsWith(`/files/${expectedId(row)}/download`));
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!fixture || !match || !(event.body instanceof Blob)) throw new Error('R8_HTTP_RANGE_IDENTITY_INVALID');
    const start = Number(match[1]), end = Number(match[2]);
    validateBounds(start, end, fixture.ciphertextBytes);
    validatePartialResponse({ status: event.status, headers: event.headers }, start, end, fixture.ciphertextBytes);
    if (event.body.size !== end - start + 1) throw new Error('TRUNCATED_RANGE_BODY');
    c()['http206Validated']++; c()['rangeBytesReceived'] += event.body.size;
    c()['rangeRequestsCompleted']++; settled = true;
  }, error: () => { if (range && !settled) { c()['rangeRequestsFailed']++; settled = true; } } }), finalize(() => {
    c()['outstandingSubscriptions']--;
    if (range) {
      if (!settled) c()['rangeRequestsAborted']++;
      c()['activeRanges']--; c()['pendingOperations']--;
    }
  }));
});

export function r8Providers(controlledRange: (id: number, start: number, end: number) => unknown) {
  return [provideRouter([]), provideHttpClient(...(r9Transport === 'angular-fetch' ? [withFetch()] : []),
    withInterceptors([jwtInterceptor, errorInterceptor, observeR8Http])),
    { provide: DriveService, ...(backend ? { useClass: r9Transport === 'direct-fetch' ? R9DirectDriveService : DriveService } : { useValue: {
      downloadFileRange: controlledRange,
      getTree: () => of({ folders: [], has_more: false, files: fixtures.map(row => ({ id: row.id,
        encrypted_name: row.name + '.mp4', size_bytes: row.ciphertextBytes, encrypted_fdk: 'synthetic-bypassed',
        storage_provider: 'local', external_storage_id: null, folder_id: null, is_hidden: false })) }),
      getPendingUploads: () => of({ pending_uploads: [] }),
    } }) },
    { provide: DriveStore, ...(realStore ? { useClass: DriveStore } : { useValue: { files: unexpected } }) },
    ...[DialogService, VideoTranscoderService, UploadEngineService, UploadBatchCoordinatorService,
      FolderUploadCoordinatorService, StorageMoveEngineService, DownloadEngineService].map(provide => ({ provide, useValue: peripheral })),
    { provide: ThumbnailLoaderService, useValue: { thumbnails: signal({}), clear: () => {}, prune: () => {}, load: unexpected } },
  ];
}

export async function configureR8(app: ApplicationRef, values: R8Fixture[], selected: string, credentials?: Runtime) {
  fixtures = values; runtime = credentials;
  if (!r8Mode) return;
  if (selected !== r8Mode) throw new Error('R8_MODE_DI_MISMATCH');
  if (backend) {
    if (!runtime || Object.keys(runtime.fileIds).sort().join() !== '0,1,2') throw new Error('R8_BACKEND_MAPPING_MISSING');
    if (r9Transport) {
      if (!runtime.fdks || Object.keys(runtime.fdks).sort().join() !== '0,1,2' ||
          Object.values(runtime.fdks).some(key => key.length !== 32 || key.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255))) {
        throw new Error('R9_PRIVATE_KEYS_REQUIRED');
      }
      c()['directAuthorizedRanges'] = 0;
      const http = app.injector.get(HttpBackend), drive = app.injector.get(DriveService);
      const proof = { transport: r9Transport, xhrBackend: http instanceof HttpXhrBackend, fetchBackend: http instanceof FetchBackend,
        originalRange: drive.downloadFileRange === DriveService.prototype.downloadFileRange,
        directRange: drive instanceof R9DirectDriveService, realAuth: app.injector.get(AuthService) instanceof AuthService };
      if (proof.fetchBackend !== (r9Transport === 'angular-fetch') || proof.xhrBackend !== (r9Transport !== 'angular-fetch') ||
          proof.originalRange !== (r9Transport !== 'direct-fetch') || proof.directRange !== (r9Transport === 'direct-fetch')) {
        throw new Error('R9_HTTP_DI_PROOF_FAILED');
      }
      Object.assign(window, { r9TransportProof: () => proof });
    }
    const auth = app.injector.get(AuthService);
    c()['authAttempts']++;
    const authenticated = await firstValueFrom(auth.loginWithCredentials(runtime.username, runtime.password));
    runtime.password = ''; // The original AuthService retains the JWT in RAM only.
    if (!authenticated || !auth.getToken()) throw new Error('R8_AUTHENTICATION_FAILED');
    c()['authSuccesses']++;
  } else app.injector.get(AppStateService).lock();
  if (realStore) {
    store = app.injector.get(DriveStore);
    if (!(store instanceof DriveStore) || store !== app.injector.get(DriveStore)) throw new Error('R8_STORE_DI_INVALID');
    c()['storeLoadStarted']++; await store.loadTree();
    if (store.isLoading() || store.files().length !== 3 || store.visibleFiles().length !== 3 ||
        store.transfers().length || Object.keys(store.thumbnails()).length) throw new Error('R8_STORE_LOAD_FAILED');
    for (const fixture of fixtures) validateStoreFile(fixture);
    c()['storeLoadCompleted']++;
    await app.whenStable(); c()['storeEffectsSettled']++;
    window.r8RefreshStore = async () => {
      await store!.loadTree();
      await app.whenStable();
      for (const fixture of fixtures) validateStoreFile(fixture);
      return { files: store!.files().length, visibleFiles: store!.visibleFiles().length,
        transfers: store!.transfers().length, thumbnails: Object.keys(store!.thumbnails()).length,
        outstandingSubscriptions: c()['outstandingSubscriptions'] };
    };
  }
}

function validateStoreFile(fixture: R8Fixture): DriveFile {
  const file = store!.files().find(row => row.id === expectedId(fixture));
  if (!file || file.isFolder || file.sizeBytes !== fixture.ciphertextBytes || file.storageProvider !== 'local' ||
      file.externalStorageId !== null || file.isHidden || file.proxyExternalFileId || file.shareUuid || file.shareFdk ||
      file.encryptedName !== fixture.name + '.mp4' || (file.mimeType !== undefined && file.mimeType !== 'video/mp4')) throw new Error('R8_STORE_FILE_IDENTITY_INVALID');
  return file;
}

export function r8File(fixture: R8Fixture): DriveFile | null {
  if (!realStore) return null;
  const file = validateStoreFile(fixture);
  c()['storeFileResolved']++;
  if (backend) c()['backendFileIdMatches']++;
  return { ...file, forceOriginal: true,
    shareFdk: r9Transport ? Uint8Array.from(runtime!.fdks![String(fixture.id)]) :
      Uint8Array.from({ length: 32 }, (_, i) => (i + 1 + fixture.id * 37) % 256) };
}

export function r8Contracts() {
  return { storeReal: !realStore || store instanceof DriveStore, storeShared: !realStore || store !== null,
    storeFilesValid: !realStore || store!.files().length === 3, proxyAndPrivateFdkBypassed: true };
}
