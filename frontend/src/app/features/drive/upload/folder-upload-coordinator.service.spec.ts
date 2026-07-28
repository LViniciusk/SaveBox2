import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { DriveService } from '../services/drive.service';
import { FolderUploadCoordinatorService } from './folder-upload-coordinator.service';

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
});
