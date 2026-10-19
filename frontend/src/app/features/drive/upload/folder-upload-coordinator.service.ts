import { Injectable, inject } from '@angular/core';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { DriveService } from '../services/drive.service';
import { buildFolderUploadTree, parseDirectoryFiles, parseDirectorySources } from './folder-upload-tree';
import type { FolderBatchResponseItem, FolderUploadCandidate, FolderUploadSourceFile } from './upload.models';
import { firstValueFromAbortable } from './abortable-observable';
import { throwIfUploadCancelled } from './upload.models';
import { DRIVE_CONTROL_REQUEST_DEADLINE_MS } from '../transfer-limits';

const INVALID_FOLDER_RESPONSE = 'Resposta de pastas inconsistente';

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

    const response = await firstValueFromAbortable(this.driveService.batchCreateFolders(rootParentId, folders), signal, DRIVE_CONTROL_REQUEST_DEADLINE_MS);
    throwIfUploadCancelled(signal);
    const byRef = this.validateResponse(tree.nodes.map(node => node.clientRef), response.folders);
    return tree.files.map(item => ({
      file: item.file,
      folderId: item.folderClientRef ? byRef.get(item.folderClientRef)! : rootParentId,
    }));
  }

  private validateResponse(expectedRefs: readonly string[], response: readonly FolderBatchResponseItem[]): Map<string, number> {
    if (response.length !== expectedRefs.length) throw new Error(INVALID_FOLDER_RESPONSE);
    const remainingRefs = new Set(expectedRefs);
    const folderIds = new Set<number>();
    const result = new Map<string, number>();
    for (const item of response) {
      if (!this.isValidResponseItem(item) || !remainingRefs.delete(item.client_ref) || folderIds.has(item.folder_id)) {
        throw new Error(INVALID_FOLDER_RESPONSE);
      }
      folderIds.add(item.folder_id);
      result.set(item.client_ref, item.folder_id);
    }
    return result;
  }

  private isValidResponseItem(item: unknown): item is FolderBatchResponseItem {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as Partial<FolderBatchResponseItem>;
    const folderId = candidate.folder_id;
    return typeof candidate.client_ref === 'string'
      && Number.isInteger(folderId)
      && (folderId as number) > 0
      && typeof candidate.created === 'boolean';
  }
}
