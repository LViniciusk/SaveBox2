import type { Observable } from 'rxjs';
import type { DriveService } from '../src/app/features/drive/services/drive.service';
import type { KasumiCryptoService } from '../src/app/core/crypto/kasumi-crypto.service';
import type { DriveFile } from '../src/app/features/drive/state/drive.store';
import { firstValueFromAbortable } from '../src/app/features/drive/upload/abortable-observable';
import { KASUMI_CHUNK_SIZE } from '../src/app/core/crypto/kasumi-format';
import { R12_CONDITIONS, selectR12, rangeBodyBytes } from './ap06-r12-contract.mjs';

export async function runR12Stage(condition: string, fixture: {id:number;bytes:number;dataOffset:number;ciphertextBytes:number},
  file: DriveFile, drive: DriveService, kasumi: KasumiCryptoService,
  getBuffer: (start:number,end:number)=>Observable<ArrayBuffer>, c: Record<string,number>, signal: AbortSignal): Promise<void> {
  const selected=selectR12(condition)!;
  if(![0,1,2].includes(fixture.id)||fixture.bytes<=2*KASUMI_CHUNK_SIZE||fixture.bytes>3*KASUMI_CHUNK_SIZE||
    !Number.isSafeInteger(fixture.dataOffset)||fixture.dataOffset<=0||fixture.dataOffset+2*(KASUMI_CHUNK_SIZE+16)>fixture.ciphertextBytes)throw new Error('R12_FIXTURE_INVALID');
  const mode=R12_CONDITIONS[selected].payload;
  async function operation(start:number,end:number,metadata:boolean): Promise<void> {
    c['pendingOperations']++;
    let references=0;
    try {
      const at=performance.now(),direct=!metadata&&mode==='direct-arraybuffer';
      const body=await firstValueFromAbortable<Blob|ArrayBuffer>(direct?getBuffer(start,end):drive.downloadFileRange(file.id,start,end),signal);
      c['obtainMs']+=performance.now()-at;c['activeReferences']++;references++;
      const bytes=rangeBodyBytes(condition,!metadata,body);
      if(bytes!==end-start+1)throw new Error('R12_TRUNCATED_BODY');
      if(signal.aborted)throw new DOMException('Aborted','AbortError');
      if(metadata){
        const info=await kasumi.extractMetadata(body as Blob,file.shareFdk!,fixture.ciphertextBytes);
        if(info.expectedSize!==fixture.bytes||info.dataOffset!==fixture.dataOffset||!info.metadata)throw new Error('R12_METADATA_IDENTITY_INVALID');
        const nonce=await kasumi.extractBaseNonce(body as Blob);nonce.fill(0);
        c['metadataBytes']+=bytes;c['metadataCompleted']++;
      } else if(direct){c['payloadArrayBufferCount']++;c['payloadArrayBufferBytes']+=bytes;}
      else {
        c['payloadBlobCount']++;c['payloadBlobBytes']+=bytes;
        if(mode==='blob-arraybuffer'){
          const at=performance.now(),buffer=await (body as Blob).arrayBuffer();
          c['materializeMs']+=performance.now()-at;c['activeReferences']++;references++;
          if(buffer.byteLength!==bytes)throw new Error('R12_MATERIALIZATION_TRUNCATED');
          c['payloadArrayBufferCount']++;c['payloadArrayBufferBytes']+=buffer.byteLength;
        }
      }
      if(signal.aborted)throw new DOMException('Aborted','AbortError');
      c['completedOperations']++;
    } catch(error){c[signal.aborted?'cancelledOperations':'failedOperations']++;throw error;}
    finally{c['activeReferences']-=references;c['pendingOperations']--;}
  }
  c['sessionsStarted']++;
  try {
    // Metadata has one common Blob/crypto phase; its stack is gone before either payload Range.
    await operation(0,131071,true);
    const start=fixture.dataOffset;
    await operation(start,start+KASUMI_CHUNK_SIZE+15,false);
    await operation(start+KASUMI_CHUNK_SIZE+16,start+2*(KASUMI_CHUNK_SIZE+16)-1,false);
    c['sessionsCompleted']++;
  }catch(error){c['sessionsFailed']++;throw error;}
}
