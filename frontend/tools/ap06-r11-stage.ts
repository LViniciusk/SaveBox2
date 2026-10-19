import { firstValueFrom } from 'rxjs';
import { DriveService } from '../src/app/features/drive/services/drive.service';
import { KasumiCryptoService } from '../src/app/core/crypto/kasumi-crypto.service';
import { VideoStreamService } from '../src/app/features/drive/services/video-stream.service';
import { DriveFile } from '../src/app/features/drive/state/drive.store';
import { KASUMI_CHUNK_SIZE } from '../src/app/core/crypto/kasumi-format';

// This driver uses the original private communication/pipeline methods without changing the production service.
export async function runR11Stage(condition: string, fixture: { id:number; bytes:number; dataOffset:number; ciphertextBytes:number },
  file: DriveFile, drive: DriveService, kasumi: KasumiCryptoService, stream: VideoStreamService): Promise<void> {
  if (!['r11.2','r11.3'].includes(condition) || fixture.bytes <= 2*KASUMI_CHUNK_SIZE || fixture.bytes > 3*KASUMI_CHUNK_SIZE)
    throw new Error('R11_STAGE_FIXTURE_INVALID');
  const get = (start:number,end:number) => firstValueFrom(drive.downloadFileRange(file.id,start,end));
  const metadataBlob = await get(0,131071);
  const fdk = file.shareFdk!;
  const metadata = await kasumi.extractMetadata(metadataBlob,fdk,fixture.ciphertextBytes);
  if (metadata.expectedSize !== fixture.bytes || metadata.dataOffset !== fixture.dataOffset || !metadata.metadata)
    throw new Error('R11_METADATA_IDENTITY_INVALID');
  const nonce = await kasumi.extractBaseNonce(metadataBlob);
  const state: any = { fdk, baseNonce:nonce, lifecycleController:new AbortController(), aborted:false,
    seekGeneration:0, totalChunks:3, plaintextSize:fixture.bytes, sourceBuffers:new Map() };
  const service = stream as any;
  try {
    if (condition === 'r11.3') {
      state.cryptoWorker = new Worker(new URL('../src/app/features/drive/workers/stream-crypto.worker',import.meta.url),{type:'module'});
      state.transmuxWorker = new Worker(new URL('../src/app/features/drive/workers/stream-transmux.worker',import.meta.url),{type:'module'});
    }
    const first = await (await get(fixture.dataOffset,fixture.dataOffset+KASUMI_CHUNK_SIZE+15)).arrayBuffer();
    if (condition === 'r11.3') {
      const decrypted = await service.sendToCryptoWorker(state,first,0);
      const response = await service.sendBootstrapToTransmuxWorker(state,decrypted,null,undefined,false);
      if (!response.initData?.length || !response.segments?.length) throw new Error('R11_BOOTSTRAP_OUTPUT_MISSING');
    }
    const nextStart = fixture.dataOffset+KASUMI_CHUNK_SIZE+16;
    const next = (await get(nextStart,nextStart+KASUMI_CHUNK_SIZE+15)).arrayBuffer();
    if (condition === 'r11.3') {
      await service.runChunkPipeline(state,0,1,1,next,null);
    } else await next;
  } finally {
    state.aborted=true; state.lifecycleController.abort();
    state.cryptoWorker?.terminate(); state.transmuxWorker?.terminate(); nonce.fill(0);
  }
}
