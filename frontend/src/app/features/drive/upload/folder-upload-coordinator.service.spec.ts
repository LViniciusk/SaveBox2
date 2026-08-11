import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, Subject } from 'rxjs';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { DriveService } from '../services/drive.service';
import { FolderUploadCoordinatorService } from './folder-upload-coordinator.service';

type FolderRequest = { client_ref: string };

function files(...paths: string[]): File[] {
  return paths.map(path => {
    const name = path.split(/[\\/]/).at(-1)!;
    const result = new File(['content'], name);
    Object.defineProperty(result, 'webkitRelativePath', { configurable: true, value: path });
    return result;
  });
}

function configureResponse(drive: any, factory: (items: readonly FolderRequest[]) => readonly unknown[]): void {
  drive.batchCreateFolders.and.callFake((_root: number | null, items: readonly FolderRequest[]) => of({ folders: factory(items) }));
}

async function expectInconsistent(
  service: FolderUploadCoordinatorService,
  drive: any,
  factory: (items: readonly FolderRequest[]) => readonly unknown[],
  paths: readonly string[] = ['Projeto/a.txt'],
): Promise<void> {
  configureResponse(drive, factory);
  await expectAsync(service.prepare(files(...paths), null)).toBeRejectedWithError('Resposta de pastas inconsistente');
}

describe('FolderUploadCoordinatorService', () => {
  let service: FolderUploadCoordinatorService;
  let drive: any;
  let crypto: any;

  beforeEach(() => {
    drive = jasmine.createSpyObj('DriveService', ['batchCreateFolders']);
    crypto = jasmine.createSpyObj('CryptoService', ['encryptName', 'hashName']);
    crypto.encryptName.and.callFake(async (name: string) => `enc-${name}`);
    crypto.hashName.and.callFake(async (name: string) => `hash-${name}`);
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), FolderUploadCoordinatorService, { provide: DriveService, useValue: drive }, { provide: CryptoService, useValue: crypto }]
    });
    service = TestBed.inject(FolderUploadCoordinatorService);
  });

  it('B.94 bounds folder preparation without converting deadline into cancellation', async () => {
    jasmine.clock().install();
    try {
      const source = new Subject<{ folders: [] }>();
      drive.batchCreateFolders.and.returnValue(source);
      const controller = new AbortController();
      let error: Error | undefined;
      const pending = service.prepare(files('Synthetic/a.txt'), null, controller.signal).catch(value => { error = value; });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(source.observed).toBeTrue();
      jasmine.clock().tick(30_000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(source.observed).toBeFalse();
      expect(error?.name).toBe('NetworkDeadlineError');
      controller.abort();
      await pending;
    } finally { jasmine.clock().uninstall(); }
  });

  it('encrypts segments, sends no paths, and maps an out-of-order response by ref', async () => {
    const parent = new File(['a'], 'a.txt');
    Object.defineProperty(parent, 'webkitRelativePath', { configurable: true, value: 'Projeto/docs/a.txt' });
    drive.batchCreateFolders.and.callFake((_root: number | null, items: Array<{ client_ref: string }>) => of({ folders: [
      { client_ref: items[1].client_ref, folder_id: 22, created: true },
      { client_ref: items[0].client_ref, folder_id: 11, created: true },
    ] }));
    const result = await service.prepare([parent], null);
    const request = drive.batchCreateFolders.calls.mostRecent().args[1];

    expect(result[0].folderId).toBe(22);
    expect(request[0]).toEqual(jasmine.objectContaining({ encrypted_name: 'enc-Projeto', name_hash: 'hash-Projeto', parent_client_ref: null }));
    expect(request[1]).toEqual(jasmine.objectContaining({ encrypted_name: 'enc-docs', name_hash: 'hash-docs', parent_client_ref: request[0].client_ref }));
    expect(JSON.stringify(request)).not.toContain('Projeto/docs');
    expect(JSON.stringify(request)).not.toContain('a.txt');
  });

  it('does not map files when the response is inconsistent', async () => {
    const item = new File(['a'], 'a.txt');
    Object.defineProperty(item, 'webkitRelativePath', { configurable: true, value: 'Projeto/a.txt' });
    drive.batchCreateFolders.and.returnValue(of({ folders: [{ client_ref: 'wrong', folder_id: 1, created: true }] }));
    await expectAsync(service.prepare([item], null)).toBeRejectedWithError('Resposta de pastas inconsistente');
  });

  it('prepares explicit folder sources with an abort signal', async () => {
    drive.batchCreateFolders.and.callFake((_root: number | null, items: Array<{ client_ref: string }>) => of({ folders: [
      { client_ref: items[0].client_ref, folder_id: 42, created: false },
    ] }));
    const item = new File(['a'], 'a.txt');
    const result = await service.prepareSources([{ file: item, relativePath: 'Projeto/a.txt' }], null, new AbortController().signal);

    expect(result).toEqual([{ file: item, folderId: 42 }]);
  });

  it('accepts created=false and ignores extra response properties', async () => {
    configureResponse(drive, items => [{ client_ref: items[0].client_ref, folder_id: 42, created: false, extra: 'ignored' }]);

    const result = await service.prepare(files('Projeto/a.txt'), null);

    expect(result[0].folderId).toBe(42);
  });

  it('rejects responses with the wrong length', async () => {
    await expectInconsistent(service, drive, () => []);
    await expectInconsistent(service, drive, items => [
      { client_ref: items[0].client_ref, folder_id: 1, created: true },
      { client_ref: 'extra', folder_id: 2, created: true },
    ]);
  });

  it('rejects unknown, duplicate, missing, and non-string client refs', async () => {
    await expectInconsistent(service, drive, () => [{ client_ref: 'unknown', folder_id: 1, created: true }]);
    await expectInconsistent(service, drive, items => [
      { client_ref: items[0].client_ref, folder_id: 1, created: true },
      { client_ref: items[0].client_ref, folder_id: 2, created: true },
    ], ['A/a.txt', 'B/b.txt']);
    await expectInconsistent(service, drive, items => [
      { client_ref: items[0].client_ref, folder_id: 1, created: true },
      { client_ref: '', folder_id: 2, created: true },
    ], ['A/a.txt', 'B/b.txt']);

    for (const clientRef of [null, undefined, 1, {}, []]) {
      await expectInconsistent(service, drive, () => [{ client_ref: clientRef, folder_id: 1, created: true }]);
    }
  });

  it('rejects invalid folder IDs and duplicate folder IDs', async () => {
    for (const folderId of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined]) {
      await expectInconsistent(service, drive, items => [{ client_ref: items[0].client_ref, folder_id: folderId, created: true }]);
    }

    await expectInconsistent(service, drive, items => [
      { client_ref: items[0].client_ref, folder_id: 7, created: true },
      { client_ref: items[1].client_ref, folder_id: 7, created: false },
    ], ['A/a.txt', 'B/b.txt']);
  });

  it('rejects invalid created values while preserving strict booleans', async () => {
    for (const created of [null, undefined, 0, 1, 'true', {}, []]) {
      await expectInconsistent(service, drive, items => [{ client_ref: items[0].client_ref, folder_id: 1, created }]);
    }

    configureResponse(drive, items => [{ client_ref: items[0].client_ref, folder_id: 1, created: true }]);
    const result = await service.prepare(files('A/a.txt'), null);
    expect(result[0].folderId).toBe(1);
  });

  it('rejects null, undefined, and empty response items before mapping', async () => {
    for (const item of [null, undefined, {}]) {
      await expectInconsistent(service, drive, () => [item]);
    }
  });

  it('rejects a partially valid response without returning any file mapping', async () => {
    configureResponse(drive, items => [
      { client_ref: items[0].client_ref, folder_id: 1, created: true },
      { client_ref: 'wrong', folder_id: 2, created: true },
    ]);

    await expectAsync(service.prepare(files('A/a.txt', 'B/b.txt'), null)).toBeRejectedWithError('Resposta de pastas inconsistente');
  });
});
