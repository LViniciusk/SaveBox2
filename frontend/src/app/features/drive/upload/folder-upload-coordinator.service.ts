import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { DriveService } from '../services/drive.service';
import { buildFolderUploadTree, parseDirectoryFiles, parseDirectorySources } from './folder-upload-tree';
import { FolderBatchResponseItem, FolderUploadCandidate, FolderUploadSourceFile } from './upload.models';
import { firstValueFromAbortable } from './abortable-observable';
import { throwIfUploadCancelled } from './upload.models';

@Injectable({ providedIn: 'root' })
export class FolderUploadCoordinatorService {
  private readonly driveService = inject(DriveService);
  private readonly cryptoService = inject(CryptoService);

  async prepare(files: readonly File[], rootParentId: number | null, signal?: AbortSignal): Promise<FolderUploadCandidate[]> {
    if (!files.length) return [];
    return this.prepareTree(buildFolderUploadTree(parseDirectoryFiles(files)), rootParentId, signal);
  }

  async prepareSources(sources: readonly FolderUploadSourceFile[], rootParentId: number | null, signal?: AbortSignal): Promise<FolderUploadCandidate[]> {
    if (!sources.length) return [];
    return this.prepareTree(buildFolderUploadTree(parseDirectorySources(sources)), rootParentId, signal);
  }

  private async prepareTree(tree: ReturnType<typeof buildFolderUploadTree>, rootParentId: number | null, signal?: AbortSignal): Promise<FolderUploadCandidate[]> {
    const folders = [];
    for (const node of tree.nodes) {
      throwIfUploadCancelled(signal);
      folders.push({
        client_ref: node.clientRef,
        parent_client_ref: node.parentClientRef,
        encrypted_name: await this.cryptoService.encryptName(node.name),
        name_hash: await this.cryptoService.hashName(node.name),
      });
    }

    const response = await firstValueFromAbortable(this.driveService.batchCreateFolders(rootParentId, folders), signal);
    throwIfUploadCancelled(signal);
    const byRef = this.validateResponse(tree.nodes.map(node => node.clientRef), response.folders);
    return tree.files.map(item => ({
      file: item.file,
      folderId: item.folderClientRef ? byRef.get(item.folderClientRef)! : rootParentId,
    }));
  }

  private validateResponse(expectedRefs: readonly string[], response: readonly FolderBatchResponseItem[]): Map<string, number> {
    if (response.length !== expectedRefs.length) throw new Error('Resposta de pastas inconsistente');
    const expected = new Set(expectedRefs);
    const seen = new Set<string>();
    const ids = new Set<number>();
    const result = new Map<string, number>();
    for (const item of response) {
      if (!item || typeof item.client_ref !== 'string' || !expected.has(item.client_ref) || seen.has(item.client_ref) ||
          !Number.isInteger(item.folder_id) || item.folder_id <= 0 || typeof item.created !== 'boolean' || ids.has(item.folder_id)) {
        throw new Error('Resposta de pastas inconsistente');
      }
      seen.add(item.client_ref);
      ids.add(item.folder_id);
      result.set(item.client_ref, item.folder_id);
    }
    if (seen.size !== expected.size) throw new Error('Resposta de pastas inconsistente');
    return result;
  }
}
