import { provideHttpClient, HttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, of, Subject, throwError } from 'rxjs';
import { CryptoService } from '../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../core/crypto/kasumi-crypto.service';
import { DriveService } from '../services/drive.service';
import { DRIVE_TRANSFER_CHUNK_SIZE, DRIVE_CONTROL_REQUEST_DEADLINE_MS, DRIVE_CHUNK_REQUEST_DEADLINE_MS } from '../transfer-limits';
import { NetworkDeadlineError } from './abortable-observable';
import { UploadEngineService } from './upload-engine.service';
import {
  GoogleUploadPlan,
  LocalUploadPlan,
  UploadPlan,
} from './upload.models';

describe('UploadEngineService', () => {
  let engine: UploadEngineService;
  let drive: jasmine.SpyObj<DriveService>;
  let crypto: jasmine.SpyObj<CryptoService>;
  let kasumi: jasmine.SpyObj<KasumiCryptoService>;
  let http: HttpTestingController;
  let nextPutStarted: ReturnType<typeof deferred<void>> | undefined;

  beforeEach(() => {
    drive = jasmine.createSpyObj('DriveService', [
      'getUploadedChunks', 'uploadChunk', 'finalizeExternalUpload', 'createExternalUploadSession',
    ]);
    crypto = jasmine.createSpyObj('CryptoService', ['encryptName', 'hashName']);
    kasumi = jasmine.createSpyObj('KasumiCryptoService', [
      'calculateEncryptedSize', 'encryptFileParts', 'extractBaseNonce', 'generateBaseNonce',
    ]);
    crypto.encryptName.and.resolveTo('encrypted-value');
    crypto.hashName.and.resolveTo('name-hash');
    kasumi.calculateEncryptedSize.and.returnValue(14);
    kasumi.generateBaseNonce.and.returnValue(new Uint8Array(24).fill(8));
    kasumi.extractBaseNonce.and.resolveTo(new Uint8Array(24).fill(9));
    kasumi.encryptFileParts.and.callFake(() => parts([new Blob(['encrypted-file'])]));
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [] }));
    drive.uploadChunk.and.returnValue(of(undefined));
    drive.finalizeExternalUpload.and.returnValue(of(undefined));
    drive.createExternalUploadSession.and.returnValue(of({
      status: 'upload', session_uri: 'https://upload.example/session', access_token: 'token',
    }));

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting(), UploadEngineService,
        { provide: DriveService, useValue: drive },
        { provide: CryptoService, useValue: crypto },
        { provide: KasumiCryptoService, useValue: kasumi },
      ],
    });
    engine = TestBed.inject(UploadEngineService);
    http = TestBed.inject(HttpTestingController);
    const rawHttp = TestBed.inject(HttpClient);
    const realPut = rawHttp.put.bind(rawHttp);
    const putSpy = spyOn(rawHttp, 'put') as jasmine.Spy;
    putSpy.and.callFake((...args: unknown[]) => {
      nextPutStarted?.resolve(undefined);
      nextPutStarted = undefined;
      return Reflect.apply(realPut as (...values: unknown[]) => unknown, rawHttp, args);
    });
  });

  afterEach(() => http.verify());

  function waitForNextPut(): Promise<void> {
    const gate = deferred<void>();
    nextPutStarted = gate;
    return gate.promise;
  }

  describe('B.94 resumable request deadline', () => {
    beforeEach(() => jasmine.clock().install());
    afterEach(() => jasmine.clock().uninstall());
    const session = { session_uri: 'https://upload.example/session', access_token: 'test-token' };

    for (const status of [308, 200, 201]) {
      it(`B.94 reconciles one expired PUT with session status ${status} without retransmission`, async () => {
        const controller = new AbortController();
        let result: unknown;
        const pending = (engine as any).putGoogleFrame(session, new Blob(['frame']), 0, 8_388_640, controller.signal)
          .then((value: unknown) => { result = value; }, () => undefined);
        const put = http.expectOne(session.session_uri);
        jasmine.clock().tick(300_000);
        for (let i = 0; i < 5; i++) await Promise.resolve();
        expect(put.cancelled).toBeTrue();
        const queries = http.match(session.session_uri);
        expect(queries.length).toBe(1);
        if (queries.length === 1) {
          expect(queries[0].request.body).toBeNull();
          expect(queries[0].request.headers.get('Content-Range')).toBe('bytes */8388640');
          if (status === 308) queries[0].flush(null, { status, statusText: 'Resume Incomplete', headers: { Range: 'bytes=0-4194319' } });
          else queries[0].flush({ id: 'confirmed-id' }, { status, statusText: 'OK' });
          await pending;
          expect(result).toEqual(status === 308
            ? { kind: 'incomplete', confirmedOffset: 4_194_320 }
            : { kind: 'completed', externalFileId: 'confirmed-id' });
        }
        controller.abort();
        await pending;
        expect(drive.createExternalUploadSession).not.toHaveBeenCalled();
        http.expectNone(session.session_uri);
      });
    }

    it('B.94 bounds the status query without guessing a restart or offset', async () => {
      const controller = new AbortController();
      let error: Error | undefined;
      const pending = (engine as any).queryGoogleSession(session, 100, controller.signal)
        .catch((value: Error) => { error = value; });
      const query = http.expectOne(session.session_uri);
      jasmine.clock().tick(30_000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(query.cancelled).toBeTrue();
      expect(error?.name).toBe('NetworkDeadlineError');
      controller.abort();
      await pending;
      expect(drive.createExternalUploadSession).not.toHaveBeenCalled();
      http.expectNone(session.session_uri);
    });

    it('B.94 preserves user cancellation without issuing a status query', async () => {
      const controller = new AbortController();
      const pending = (engine as any).putGoogleFrame(session, new Blob(['frame']), 0, 100, controller.signal);
      const put = http.expectOne(session.session_uri);
      controller.abort();
      await expectAsync(pending).toBeRejectedWith(jasmine.objectContaining({ name: 'AbortError' }));
      jasmine.clock().tick(DRIVE_CHUNK_REQUEST_DEADLINE_MS);
      expect(put.cancelled).toBeTrue();
      http.expectNone(session.session_uri);
    });

    it('B.94 propagates a second deadline without replacement or guessed provider state', async () => {
      let error: unknown;
      const pending = (engine as any).putGoogleFrame(session, new Blob(['frame']), 0, 100, new AbortController().signal)
        .catch((value: unknown) => { error = value; });
      http.expectOne(session.session_uri);
      jasmine.clock().tick(DRIVE_CHUNK_REQUEST_DEADLINE_MS);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const query = http.expectOne(session.session_uri);
      expect(query.request.body).toBeNull();
      jasmine.clock().tick(DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      await pending;
      expect(error).toBeInstanceOf(NetworkDeadlineError);
      expect(query.cancelled).toBeTrue();
      expect(drive.createExternalUploadSession).not.toHaveBeenCalled();
      http.expectNone(session.session_uri);
    });

    it('B.94 keeps the existing idempotent local recovery fallback after a status deadline', async () => {
      const status = new Subject<{ uploaded_chunks: number[] }>();
      drive.getUploadedChunks.and.returnValue(status);
      const pending = engine.executeLocal(makeLocalPlan(14), 94, noPause(), { onProgress: () => undefined });
      expect(status.observed).toBeTrue();
      jasmine.clock().tick(DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      await expectAsync(pending).toBeResolvedTo({ paused: false });
      expect(status.observed).toBeFalse();
      expect(drive.uploadChunk).toHaveBeenCalledOnceWith(94, 0, jasmine.any(Blob));
    });

    it('B.94 rejects a local chunk deadline without reporting user cancellation or success', async () => {
      const chunk = new Subject<void>();
      drive.uploadChunk.and.returnValue(chunk);
      const progress = jasmine.createSpy('progress');
      const pending = engine.executeLocal(makeLocalPlan(14), 94, noPause(), { onProgress: progress });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(chunk.observed).toBeTrue();
      jasmine.clock().tick(DRIVE_CHUNK_REQUEST_DEADLINE_MS);
      await expectAsync(pending).toBeRejectedWith(jasmine.any(NetworkDeadlineError));
      expect(chunk.observed).toBeFalse();
      expect(drive.uploadChunk).toHaveBeenCalledTimes(1);
      expect(progress).not.toHaveBeenCalled();
    });

    it('B.94 bounds external finalization without repeating the POST', async () => {
      const finalize = new Subject<void>();
      drive.finalizeExternalUpload.and.returnValue(finalize);
      const pending = (engine as any).finalizeGoogle(94, 'synthetic-id');
      expect(finalize.observed).toBeTrue();
      jasmine.clock().tick(DRIVE_CONTROL_REQUEST_DEADLINE_MS);
      await expectAsync(pending).toBeRejectedWith(jasmine.any(NetworkDeadlineError));
      expect(finalize.observed).toBeFalse();
      expect(drive.finalizeExternalUpload).toHaveBeenCalledOnceWith(94, 'synthetic-id');
    });
  });

  it('planeja geometria sem materializar ciphertext', async () => {
    const file = new File(['plain'], 'secret.txt', { type: 'text/plain' });
    const plan = await engine.planUpload(file);

    expect(plan.encryptedSize).toBe(14);
    expect(plan.totalChunks).toBe(1);
    expect('encryptedBlob' in plan).toBeFalse();
  });

  it('cria receita Local com nonce estável e sem Blob', () => {
    const source = makePlan(14);
    const nonce = new Uint8Array(24).fill(7);
    const plan = engine.createLocalUploadPlan(source, nonce, '{ exact: true }');

    expect(plan.baseNonce).toBe(nonce);
    expect(plan.rematerializationMetadata).toBe('{ exact: true }');
    expect('encryptedBlob' in plan).toBeFalse();
  });

  it('Local usa encryptFileParts, framer real, nonce e metadata exatos', async () => {
    const plan = makeLocalPlan(14, new Uint8Array(24).fill(0x34), '{  "version": 2, "extra": "✓" }');
    const frames: Blob[] = [];
    kasumi.encryptFileParts.and.callFake((_file, fdk, nonce, metadata, signal) => {
      expect(fdk).toBe(plan.fdk);
      expect(nonce).toBe(plan.baseNonce);
      expect(metadata).toBe(plan.rematerializationMetadata);
      expect(signal).toBeUndefined();
      return parts([new Blob(['encrypted-file'])], frames);
    });

    const result = await engine.executeLocal(plan, 7, noPause(), { onProgress: () => undefined });

    expect(result).toEqual({ paused: false });
    expect(kasumi.encryptFileParts).toHaveBeenCalledTimes(1);
    expect(frames.length).toBe(1);
    expect(drive.uploadChunk).toHaveBeenCalledOnceWith(7, 0, jasmine.any(Blob));
    expect(drive.uploadChunk.calls.mostRecent().args[2].size).toBe(14);
  });

  it('Local reporta progresso pela geometria planejada e ignora chunk já confirmado', async () => {
    const plan = makeLocalPlan(DRIVE_TRANSFER_CHUNK_SIZE + 1);
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [0] }));
    const progress: number[] = [];
    kasumi.encryptFileParts.and.callFake(() => parts([
      new Blob([new Uint8Array(DRIVE_TRANSFER_CHUNK_SIZE + 1)]),
    ]));

    await engine.executeLocal(plan, 18, noPause(), { onProgress: update => progress.push(update.progress) });

    expect(drive.uploadChunk).toHaveBeenCalledOnceWith(18, 1, jasmine.any(Blob));
    expect(drive.uploadChunk.calls.mostRecent().args[2].size).toBe(1);
    expect(progress).toEqual([50, 100]);
  });

  it('faz fallback para todos os chunks quando o endpoint de resume falha', async () => {
    const plan = makeLocalPlan(DRIVE_TRANSFER_CHUNK_SIZE + 1);
    drive.getUploadedChunks.and.returnValue(throwError(() => new Error('resume unavailable')));
    kasumi.encryptFileParts.and.callFake(() => parts([
      new Blob([new Uint8Array(DRIVE_TRANSFER_CHUNK_SIZE)]), new Blob([new Uint8Array(1)]),
    ]));

    await engine.executeLocal(plan, 26, noPause(), { onProgress: () => undefined });

    expect(drive.uploadChunk.calls.allArgs().map(([, index]) => index)).toEqual([0, 1]);
  });

  it('rejeita índices de chunks confirmados fora da geometria', async () => {
    const plan = makeLocalPlan(14);
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [1] }));

    await expectAsync(engine.executeLocal(plan, 18, noPause(), { onProgress: () => undefined }))
      .toBeRejectedWithError('Encrypted upload geometry mismatch');
    expect(kasumi.encryptFileParts).not.toHaveBeenCalled();
    expect(drive.uploadChunk).not.toHaveBeenCalled();
  });

  it('rejeita geometria incompatível antes de consultar o estado remoto ou produzir ciphertext', async () => {
    const plan = { ...makeLocalPlan(DRIVE_TRANSFER_CHUNK_SIZE + 1), totalChunks: 1 };

    await expectAsync(engine.executeLocal(plan, 18, noPause(), { onProgress: () => undefined }))
      .toBeRejectedWithError('Encrypted upload geometry mismatch');
    expect(drive.getUploadedChunks).not.toHaveBeenCalled();
    expect(kasumi.encryptFileParts).not.toHaveBeenCalled();
    expect(drive.uploadChunk).not.toHaveBeenCalled();
  });

  it('não produz o próximo frame enquanto o upload atual está pendente', async () => {
    const plan = makeLocalPlan(DRIVE_TRANSFER_CHUNK_SIZE + 1);
    let produced = 0;
    const uploadStarted = deferred<void>();
    const releaseUpload = deferred<void>();
    drive.uploadChunk.and.callFake(() => new Observable(subscriber => {
      uploadStarted.resolve(undefined);
      void releaseUpload.promise.then(() => { subscriber.next(); subscriber.complete(); });
    }));
    kasumi.encryptFileParts.and.callFake(() => controlledParts(
      [new Blob([new Uint8Array(DRIVE_TRANSFER_CHUNK_SIZE)]), new Blob([new Uint8Array(1)])],
      () => produced++,
    ));

    const operation = engine.executeLocal(plan, 19, noPause(), { onProgress: () => undefined });
    await uploadStarted.promise;
    expect(produced).toBe(1);
    expect(drive.uploadChunk).toHaveBeenCalledTimes(1);

    releaseUpload.resolve(undefined);
    await operation;
    expect(produced).toBe(2);
  });

  it('pausa antes de pedir o próximo frame', async () => {
    const plan = makeLocalPlan(DRIVE_TRANSFER_CHUNK_SIZE + 1);
    let paused = false;
    let produced = 0;
    drive.uploadChunk.and.callFake(() => {
      paused = true;
      return of(undefined);
    });
    kasumi.encryptFileParts.and.callFake(() => controlledParts(
      [new Blob([new Uint8Array(DRIVE_TRANSFER_CHUNK_SIZE)]), new Blob([new Uint8Array(1)])],
      () => produced++,
    ));

    const result = await engine.executeLocal(plan, 20, {
      shouldPause: () => paused,
      shouldCancel: () => false,
    }, { onProgress: () => undefined });

    expect(result).toEqual({ paused: true });
    expect(produced).toBe(1);
    expect(drive.uploadChunk).toHaveBeenCalledTimes(1);
  });

  it('trata chunk Local terminal aceito como sucesso se a pausa chegar durante o POST', async () => {
    const plan = makeLocalPlan(14);
    let pauseRequested = false;
    const request = new Subject<void>();
    const uploadStarted = deferred<void>();
    const progress: number[] = [];

    drive.uploadChunk.and.callFake(() => {
      uploadStarted.resolve();
      return request.asObservable();
    });

    const operation = engine.executeLocal(plan, 24, {
      shouldPause: () => pauseRequested,
      shouldCancel: () => false,
    }, { onProgress: update => progress.push(update.progress) });

    await uploadStarted.promise;
    pauseRequested = true;
    request.next();
    request.complete();

    expect(await operation).toEqual({ paused: false });
    expect(drive.uploadChunk).toHaveBeenCalledTimes(1);
    expect(progress).toContain(100);
  });

  it('não publica 100% enquanto o POST Local está pendente', async () => {
    const request = new Subject<void>();
    const uploadStarted = deferred<void>();
    const progress: number[] = [];
    const plan = makeLocalPlan(14);

    drive.uploadChunk.and.callFake(() => {
      uploadStarted.resolve();
      return request.asObservable();
    });

    const operation = engine.executeLocal(plan, 27, noPause(), {
      onProgress: update => progress.push(update.progress),
    });

    await uploadStarted.promise;
    expect(progress).not.toContain(100);

    request.next();
    request.complete();

    expect(await operation).toEqual({ paused: false });
    expect(progress).toContain(100);
  });

  it('fecha o stream criptografado antes do POST terminal e resolve após publicar 100%', async () => {
    const plan = makeLocalPlan(DRIVE_TRANSFER_CHUNK_SIZE + 1);
    const events: string[] = [];
    drive.getUploadedChunks.and.returnValue(of({ uploaded_chunks: [0] }));
    kasumi.encryptFileParts.and.callFake(() => (async function* () {
      try {
        yield new Blob([new Uint8Array(plan.encryptedSize)]);
      } finally {
        events.push('source-finalizer-complete');
      }
    })());
    drive.uploadChunk.and.callFake((_fileId, index) => {
      expect(index).toBe(1);
      return new Observable(subscriber => {
        events.push('terminal-post-subscribed');
        subscriber.next(undefined);
        events.push('terminal-post-next');
        subscriber.complete();
      });
    });

    const operation = engine.executeLocal(plan, 28, noPause(), {
      onProgress: update => {
        if (update.progress === 100) events.push('progress-100');
      },
    });
    const result = await operation;
    events.push('execute-local-resolved');

    expect(result).toEqual({ paused: false });
    expect(events).toEqual([
      'source-finalizer-complete',
      'terminal-post-subscribed',
      'terminal-post-next',
      'progress-100',
      'execute-local-resolved',
    ]);
    expect(drive.uploadChunk).toHaveBeenCalledOnceWith(28, 1, jasmine.any(Blob));
  });

  it('pausa após POST Local não terminal aceito antes de produzir o próximo frame', async () => {
    const plan = makeLocalPlan(DRIVE_TRANSFER_CHUNK_SIZE + 1);
    let pauseRequested = false;
    let produced = 0;
    const request = new Subject<void>();
    const uploadStarted = deferred<void>();
    drive.uploadChunk.and.callFake((_fileId, index) => {
      if (index === 0) {
        uploadStarted.resolve();
        return request.asObservable();
      }
      return of(undefined);
    });
    kasumi.encryptFileParts.and.callFake(() => controlledParts(
      [new Blob([new Uint8Array(DRIVE_TRANSFER_CHUNK_SIZE)]), new Blob([new Uint8Array(1)])],
      () => produced++,
    ));

    const operation = engine.executeLocal(plan, 25, {
      shouldPause: () => pauseRequested,
      shouldCancel: () => false,
    }, { onProgress: () => undefined });

    await uploadStarted.promise;
    pauseRequested = true;
    request.next();
    request.complete();

    expect(await operation).toEqual({ paused: true });
    expect(produced).toBe(1);
    expect(drive.uploadChunk).toHaveBeenCalledTimes(1);
  });

  it('pausa durante a produção e não envia o frame produzido', async () => {
    const plan = makeLocalPlan(14);
    const cryptoStarted = deferred<void>();
    const releaseCrypto = deferred<void>();
    let paused = false;
    kasumi.encryptFileParts.and.callFake(async function* () {
      cryptoStarted.resolve(undefined);
      await releaseCrypto.promise;
      yield new Blob(['encrypted-file']);
    });
    const operation = engine.executeLocal(plan, 21, {
      shouldPause: () => paused,
      shouldCancel: () => false,
    }, { onProgress: () => undefined });
    await cryptoStarted.promise;
    paused = true;
    releaseCrypto.resolve(undefined);

    expect(await operation).toEqual({ paused: true });
    expect(drive.uploadChunk).not.toHaveBeenCalled();
  });

  it('cancela durante HTTP, aborta a assinatura e zera a FDK', async () => {
    const request = new Subject<void>();
    const requestStarted = deferred<void>();
    const controller = new AbortController();
    const plan = makeLocalPlan(14);
    drive.uploadChunk.and.callFake(() => {
      requestStarted.resolve(undefined);
      return request.asObservable();
    });
    const operation = engine.executeLocal(plan, 22, {
      shouldPause: () => false,
      shouldCancel: () => controller.signal.aborted,
      signal: controller.signal,
    }, { onProgress: () => undefined });
    await requestStarted.promise;
    controller.abort();

    expect(await operation).toEqual({ paused: false, cancelled: true });
    expect(request.observers.length).toBe(0);
    expect(plan.fdk.every(value => value === 0)).toBeTrue();
  });

  it('falha fechado quando o stream não corresponde à geometria planejada', async () => {
    const plan = makeLocalPlan(15);
    kasumi.encryptFileParts.and.callFake(() => parts([new Blob(['short'])]));

    await expectAsync(engine.executeLocal(plan, 23, noPause(), { onProgress: () => undefined }))
      .toBeRejectedWithError('Encrypted stream size mismatch');
    expect(drive.uploadChunk).not.toHaveBeenCalled();
  });

  it('Google usa encryptFileParts, framer real e Content-Range confirmado', async () => {
    const total = DRIVE_TRANSFER_CHUNK_SIZE + 1;
    const plan = makeGooglePlan(total, new Uint8Array(24).fill(0x44), '{ exact: true }');
    kasumi.encryptFileParts.and.callFake(() => parts([new Blob([new Uint8Array(total)])]));
    const requestStarted = waitForNextPut();
    const operation = engine.executeGoogle(plan, 10, undefined, noPause(), { onProgress: () => undefined });
    await requestStarted;
    const first = http.expectOne('https://upload.example/session');
    expect(first.request.withCredentials).toBeFalse();
    expect(first.request.headers.get('Content-Range')).toBe(`bytes 0-${DRIVE_TRANSFER_CHUNK_SIZE - 1}/${total}`);
    const secondRequestStarted = waitForNextPut();
    first.flush({}, { status: 308, statusText: 'Resume Incomplete', headers: { Range: `bytes=0-${DRIVE_TRANSFER_CHUNK_SIZE - 1}` } });
    await secondRequestStarted;
    const second = http.expectOne('https://upload.example/session');
    expect(second.request.headers.get('Content-Range')).toBe(`bytes ${DRIVE_TRANSFER_CHUNK_SIZE}-${total - 1}/${total}`);
    expect((second.request.body as Blob).size).toBe(1);
    second.flush({ id: 'external-id' });
    expect(await operation).toEqual({ paused: false });
    expect(drive.finalizeExternalUpload).toHaveBeenCalledOnceWith(10, 'external-id');
  });

  it('retoma sessão existente consultando o offset antes de produzir bytes', async () => {
    const total = DRIVE_TRANSFER_CHUNK_SIZE + 1;
    const plan = makeGooglePlan(total);
    const session = { session_uri: 'https://upload.example/existing', access_token: 'existing-token' };
    kasumi.encryptFileParts.and.callFake(() => parts([new Blob([new Uint8Array(total)])]));

    const requestStarted = waitForNextPut();
    const operation = engine.executeGoogle(plan, 10, session, noPause(), { onProgress: () => undefined });
    await requestStarted;
    const status = http.expectOne('https://upload.example/existing');
    expect(status.request.body).toBeNull();
    expect(status.request.withCredentials).toBeFalse();
    expect(status.request.headers.get('Authorization')).toBe('Bearer existing-token');
    const resumedRequestStarted = waitForNextPut();
    status.flush({}, {
      status: 308,
      statusText: 'Resume Incomplete',
      headers: { Range: 'bytes=0-3' },
    });
    await resumedRequestStarted;

    const resumed = http.expectOne('https://upload.example/existing');
    expect(resumed.request.headers.get('Content-Range')).toBe(`bytes 4-${total - 1}/${total}`);
    expect((resumed.request.body as Blob).size).toBe(total - 4);
    resumed.flush({ id: 'external-id' });

    await operation;
    expect(drive.finalizeExternalUpload).toHaveBeenCalledOnceWith(10, 'external-id');
  });

  it('rejeita sessão retida que confirma o total via 308 antes de publicar estado ou produzir bytes', async () => {
    const session = { session_uri: 'https://upload.example/retained-total', access_token: 'retained-token' };
    const progress: number[] = [];
    const statusStarted = waitForNextPut();
    const operation = engine.executeGoogle(makeGooglePlan(14), 10, session, noPause(), {
      onProgress: update => progress.push(update.transferredBytes),
    });
    await statusStarted;

    const status = http.expectOne(session.session_uri);
    expect(status.request.body).toBeNull();
    expect(status.request.headers.get('Authorization')).toBe('Bearer retained-token');
    expect(status.request.headers.get('Content-Range')).toBe('bytes */14');
    status.flush(null, {
      status: 308,
      statusText: 'Resume Incomplete',
      headers: { Range: 'bytes=0-13' },
    });

    await expectAsync(operation).toBeRejectedWithError('Google resumable upload completed without external ID');
    expect(progress).toEqual([]);
    expect(kasumi.encryptFileParts).not.toHaveBeenCalled();
    expect(drive.createExternalUploadSession).not.toHaveBeenCalled();
    expect(drive.finalizeExternalUpload).not.toHaveBeenCalled();
    http.expectNone(session.session_uri);
  });

  it('trata 308 sem Range como offset zero antes do primeiro PUT de dados', async () => {
    const plan = makeGooglePlan(14);
    const session = { session_uri: 'https://upload.example/no-range', access_token: 'token-no-range' };
    kasumi.encryptFileParts.and.callFake(() => parts([new Blob(['encrypted-file'])]));

    const statusStarted = waitForNextPut();
    const operation = engine.executeGoogle(plan, 10, session, noPause(), { onProgress: () => undefined });
    await statusStarted;
    const status = http.expectOne(session.session_uri);
    expect(status.request.body).toBeNull();
    expect(status.request.withCredentials).toBeFalse();
    expect(status.request.headers.get('Authorization')).toBe('Bearer token-no-range');
    expect(status.request.headers.get('Content-Range')).toBe('bytes */14');

    const dataStarted = waitForNextPut();
    status.flush(null, { status: 308, statusText: 'Resume Incomplete', headers: {} });
    await dataStarted;
    const data = http.expectOne(session.session_uri);
    expect(data.request.body instanceof Blob).toBeTrue();
    expect(data.request.headers.get('Content-Range')).toBe('bytes 0-13/14');
    data.flush({ id: 'external-id' });

    await operation;
    expect(drive.finalizeExternalUpload).toHaveBeenCalledOnceWith(10, 'external-id');
  });

  it('rejeita a matriz de Range inválido sem iniciar PUT de dados', async () => {
    const invalidRanges = [
      'bytes=4-8', 'bytes=9-8', 'bytes=abc-def', '0-42',
      'bytes=-1-5', 'bytes=0-', 'bytes=', 'bytes=0-999999999999999999',
    ];

    for (const range of invalidRanges) {
      const session = { session_uri: `https://upload.example/invalid-${range}`, access_token: 'token-invalid' };
      const statusStarted = waitForNextPut();
      const operation = engine.executeGoogle(makeGooglePlan(14), 10, session, noPause(), { onProgress: () => undefined });
      await statusStarted;
      const status = http.expectOne(session.session_uri);
      status.flush(null, { status: 308, statusText: 'Resume Incomplete', headers: { Range: range } });

      await expectAsync(operation).toBeRejectedWithError('Google resumable Range inválido');
      expect(kasumi.encryptFileParts).not.toHaveBeenCalled();
    }
  });

  it('rejeita Range com end igual ao total', async () => {
    const session = { session_uri: 'https://upload.example/end-total', access_token: 'token-end-total' };
    const statusStarted = waitForNextPut();
    const operation = engine.executeGoogle(makeGooglePlan(100), 10, session, noPause(), { onProgress: () => undefined });
    await statusStarted;
    const status = http.expectOne(session.session_uri);
    status.flush(null, {
      status: 308,
      statusText: 'Resume Incomplete',
      headers: { Range: 'bytes=0-100' },
    });

    await expectAsync(operation).toBeRejectedWithError('Google resumable Range inválido');
    expect(kasumi.encryptFileParts).not.toHaveBeenCalled();
  });

  it('rejeita ACK regressivo sem aceitar rollback de progresso', async () => {
    const plan = makeGooglePlan(14);
    kasumi.encryptFileParts.and.callFake(() => parts([new Blob(['encrypted-file'])]));
    const progress: number[] = [];
    const firstStarted = waitForNextPut();
    const operation = engine.executeGoogle(plan, 10, undefined, noPause(), {
      onProgress: update => progress.push(update.transferredBytes),
    });
    await firstStarted;
    const first = http.expectOne('https://upload.example/session');
    const secondStarted = waitForNextPut();
    first.flush(null, { status: 308, statusText: 'Resume Incomplete', headers: { Range: 'bytes=0-7' } });
    await secondStarted;
    const second = http.expectOne('https://upload.example/session');
    expect(second.request.headers.get('Content-Range')).toBe('bytes 8-13/14');
    second.flush(null, { status: 308, statusText: 'Resume Incomplete', headers: { Range: 'bytes=0-3' } });

    await expectAsync(operation).toBeRejectedWithError('Google resumable offset invalid');
    expect(progress).toEqual([8]);
    expect(drive.finalizeExternalUpload).not.toHaveBeenCalled();
  });

  it('rejeita ACK além do frame enviado sem publicar progresso impossível', async () => {
    const total = DRIVE_TRANSFER_CHUNK_SIZE + 14;
    const plan = makeGooglePlan(total);
    kasumi.encryptFileParts.and.callFake(() => parts([new Blob([new Uint8Array(total)])]));
    const progress: number[] = [];
    const firstStarted = waitForNextPut();
    const operation = engine.executeGoogle(plan, 10, undefined, noPause(), {
      onProgress: update => progress.push(update.transferredBytes),
    });
    await firstStarted;
    const first = http.expectOne('https://upload.example/session');
    expect(first.request.headers.get('Content-Range')).toBe(`bytes 0-${DRIVE_TRANSFER_CHUNK_SIZE - 1}/${total}`);
    first.flush(null, {
      status: 308,
      statusText: 'Resume Incomplete',
      headers: { Range: `bytes=0-${DRIVE_TRANSFER_CHUNK_SIZE}` },
    });

    await expectAsync(operation).toBeRejectedWithError('Google resumable offset exceeds sent frame');
    expect(progress).toEqual([]);
    expect(drive.finalizeExternalUpload).not.toHaveBeenCalled();
  });

  it('não publica 100% quando 308 confirma o total sem external ID', async () => {
    const progress: number[] = [];
    const requestStarted = waitForNextPut();
    const operation = engine.executeGoogle(makeGooglePlan(14), 10, undefined, noPause(), {
      onProgress: update => progress.push(update.transferredBytes),
    });
    await requestStarted;
    const request = http.expectOne('https://upload.example/session');
    request.flush(null, {
      status: 308,
      statusText: 'Resume Incomplete',
      headers: { Range: 'bytes=0-13' },
    });

    await expectAsync(operation).toBeRejectedWithError('Google resumable upload completed without external ID');
    expect(progress).toEqual([]);
    expect(drive.finalizeExternalUpload).not.toHaveBeenCalled();
  });

  it('limita três ACKs consecutivos sem avanço e não envia uma quarta vez', async () => {
    const plan = makeGooglePlan(14);
    kasumi.encryptFileParts.and.callFake(() => parts([new Blob(['encrypted-file'])]));
    let requestStarted = waitForNextPut();
    const operation = engine.executeGoogle(plan, 10, undefined, noPause(), { onProgress: () => undefined });

    for (let attempt = 0; attempt < 3; attempt++) {
      await requestStarted;
      const request = http.expectOne('https://upload.example/session');
      expect(request.request.headers.get('Content-Range')).toBe('bytes 0-13/14');
      if (attempt < 2) requestStarted = waitForNextPut();
      request.flush(null, { status: 308, statusText: 'Resume Incomplete', headers: {} });
    }

    await expectAsync(operation).toBeRejectedWithError('Google resumable upload made no progress');
    expect(drive.finalizeExternalUpload).not.toHaveBeenCalled();
  });

  it('consulta o estado antes de retransmitir depois de 503', async () => {
    const total = 14;
    kasumi.encryptFileParts.and.callFake(() => parts([new Blob(['encrypted-file'])]));
    const firstStarted = waitForNextPut();
    const operation = engine.executeGoogle(makeGooglePlan(total), 10, undefined, noPause(), { onProgress: () => undefined });
    await firstStarted;
    const first = http.expectOne('https://upload.example/session');
    expect(first.request.body instanceof Blob).toBeTrue();

    const statusStarted = waitForNextPut();
    first.error(new ProgressEvent('error'), { status: 503, statusText: 'Service Unavailable' });
    await statusStarted;
    const status = http.expectOne('https://upload.example/session');
    expect(status.request.body).toBeNull();
    expect(status.request.headers.get('Authorization')).toBe('Bearer token');
    expect(status.request.headers.get('Content-Range')).toBe('bytes */14');

    const dataStarted = waitForNextPut();
    status.flush(null, { status: 308, statusText: 'Resume Incomplete', headers: { Range: 'bytes=0-7' } });
    await dataStarted;
    const data = http.expectOne('https://upload.example/session');
    expect(data.request.headers.get('Content-Range')).toBe('bytes 8-13/14');
    data.flush({ id: 'external-id' });

    await operation;
    expect(drive.finalizeExternalUpload).toHaveBeenCalledOnceWith(10, 'external-id');
  });

  it('aceita conclusão da status query 200 e 201 sem criptografar ou reenviar dados', async () => {
    for (const statusCode of [200, 201]) {
      const session = { session_uri: `https://upload.example/completed-${statusCode}`, access_token: 'token-completed' };
      const statusStarted = waitForNextPut();
      const operation = engine.executeGoogle(makeGooglePlan(14), 10, session, noPause(), { onProgress: () => undefined });
      await statusStarted;
      const status = http.expectOne(session.session_uri);
      status.flush({ id: `remote-${statusCode}` }, { status: statusCode, statusText: 'OK' });

      await expectAsync(operation).toBeResolvedTo({ paused: false });
      expect(kasumi.encryptFileParts).not.toHaveBeenCalled();
      expect(drive.createExternalUploadSession).not.toHaveBeenCalled();
      expect(drive.finalizeExternalUpload).toHaveBeenCalledOnceWith(10, `remote-${statusCode}`);
      drive.finalizeExternalUpload.calls.reset();
    }
  });

  it('falha fechado quando PUT terminal responde 200 ou 201 sem ID', async () => {
    for (const statusCode of [200, 201]) {
      const requestStarted = waitForNextPut();
      const operation = engine.executeGoogle(makeGooglePlan(14), 10, undefined, noPause(), { onProgress: () => undefined });
      await requestStarted;
      const request = http.expectOne('https://upload.example/session');
      request.flush({}, { status: statusCode, statusText: 'OK' });

      await expectAsync(operation).toBeRejectedWithError('Google Drive upload failed: ID missing from response');
      expect(drive.finalizeExternalUpload).not.toHaveBeenCalled();
    }
  });

  it('consulta primeiro a sessão retida e reconcilia 401 como concluída', async () => {
    const session = { session_uri: 'https://upload.example/retained-s1', access_token: 'retained-old-token' };
    drive.createExternalUploadSession.and.returnValue(of({ status: 'completed', external_file_id: 'reconciled-id' }));
    const statusStarted = waitForNextPut();
    const operation = engine.executeGoogle(makeGooglePlan(14), 10, session, noPause(), { onProgress: () => undefined });
    await statusStarted;
    const status = http.expectOne(session.session_uri);
    expect(status.request.body).toBeNull();
    expect(status.request.headers.get('Authorization')).toBe('Bearer retained-old-token');
    status.flush(null, { status: 401, statusText: 'Unauthorized' });

    await expectAsync(operation).toBeResolvedTo({ paused: false });
    expect(drive.createExternalUploadSession).toHaveBeenCalledOnceWith(10);
    expect(kasumi.encryptFileParts).not.toHaveBeenCalled();
    expect(drive.finalizeExternalUpload).toHaveBeenCalledOnceWith(10, 'reconciled-id');
  });

  it('usa S2 depois de 401 na sessão retida, sem reenviar para S1', async () => {
    const session = { session_uri: 'https://upload.example/retained-s1', access_token: 'retained-old-token' };
    drive.createExternalUploadSession.and.returnValue(of({
      status: 'upload', session_uri: 'https://upload.example/fresh-s2', access_token: 'fresh-token',
    }));
    kasumi.encryptFileParts.and.callFake(() => parts([new Blob(['encrypted-file'])]));
    const statusStarted = waitForNextPut();
    const operation = engine.executeGoogle(makeGooglePlan(14), 10, session, noPause(), { onProgress: () => undefined });
    await statusStarted;
    const status = http.expectOne(session.session_uri);
    const dataStarted = waitForNextPut();
    status.flush(null, { status: 401, statusText: 'Unauthorized' });
    await dataStarted;
    const data = http.expectOne('https://upload.example/fresh-s2');
    expect(data.request.headers.get('Authorization')).toBe('Bearer fresh-token');
    expect(data.request.headers.get('Content-Range')).toBe('bytes 0-13/14');
    data.flush({ id: 'fresh-id' });

    await operation;
    expect(drive.createExternalUploadSession).toHaveBeenCalledOnceWith(10);
    expect(drive.finalizeExternalUpload).toHaveBeenCalledOnceWith(10, 'fresh-id');
  });

  it('limita a uma substituição quando S2 também é invalidada', async () => {
    const session = { session_uri: 'https://upload.example/retained-s1', access_token: 'retained-old-token' };
    drive.createExternalUploadSession.and.returnValue(of({
      status: 'upload', session_uri: 'https://upload.example/fresh-s2', access_token: 'fresh-token',
    }));
    const statusStarted = waitForNextPut();
    const operation = engine.executeGoogle(makeGooglePlan(14), 10, session, noPause(), { onProgress: () => undefined });
    await statusStarted;
    const status = http.expectOne(session.session_uri);
    const dataStarted = waitForNextPut();
    status.flush(null, { status: 401, statusText: 'Unauthorized' });
    await dataStarted;
    const data = http.expectOne('https://upload.example/fresh-s2');
    data.flush(null, { status: 404, statusText: 'Not Found' });

    await expectAsync(operation).toBeRejectedWithError('Google resumable session replacement limit reached');
    expect(drive.createExternalUploadSession).toHaveBeenCalledOnceWith(10);
    expect(drive.finalizeExternalUpload).not.toHaveBeenCalled();
  });

  it('não produz o próximo frame Google enquanto o PUT atual está pendente', async () => {
    const total = DRIVE_TRANSFER_CHUNK_SIZE + 1;
    let produced = 0;
    kasumi.encryptFileParts.and.callFake(() => controlledParts(
      [new Blob([new Uint8Array(DRIVE_TRANSFER_CHUNK_SIZE)]), new Blob([new Uint8Array(1)])],
      () => produced++,
    ));
    const firstStarted = waitForNextPut();
    const operation = engine.executeGoogle(makeGooglePlan(total), 10, undefined, noPause(), { onProgress: () => undefined });
    await firstStarted;
    const first = http.expectOne('https://upload.example/session');
    expect(produced).toBe(1);

    const secondStarted = waitForNextPut();
    first.flush(null, {
      status: 308,
      statusText: 'Resume Incomplete',
      headers: { Range: `bytes=0-${DRIVE_TRANSFER_CHUNK_SIZE - 1}` },
    });
    await secondStarted;
    expect(produced).toBe(2);
    const second = http.expectOne('https://upload.example/session');
    second.flush({ id: 'external-id' });

    await operation;
    expect(drive.finalizeExternalUpload).toHaveBeenCalledOnceWith(10, 'external-id');
  });

  it('pausa antes da sessão sem produzir crypto e preserva a FDK', async () => {
    const plan = makeGooglePlan(14);
    plan.fdk.fill(0x55);
    const result = await engine.executeGoogle(plan, 10, undefined, {
      shouldPause: () => true, shouldCancel: () => false,
    }, { onProgress: () => undefined });
    expect(result).toEqual({ paused: true, googleSession: undefined });
    expect(drive.createExternalUploadSession).not.toHaveBeenCalled();
    expect(kasumi.encryptFileParts).not.toHaveBeenCalled();
    expect(plan.fdk.every(value => value === 0x55)).toBeTrue();
  });

  it('pausa depois da sessão e antes do crypto retém a sessão', async () => {
    let pause = false;
    drive.createExternalUploadSession.and.callFake(() => {
      pause = true;
      return of({ status: 'upload', session_uri: 'https://upload.example/session', access_token: 'token' });
    });
    const plan = makeGooglePlan(14);
    const result = await engine.executeGoogle(plan, 10, undefined, {
      shouldPause: () => pause, shouldCancel: () => false,
    }, { onProgress: () => undefined });
    expect(result.paused).toBeTrue();
    expect(result.googleSession?.session_uri).toBe('https://upload.example/session');
    expect(kasumi.encryptFileParts).not.toHaveBeenCalled();
    expect(plan.fdk.every(value => value !== 0)).toBeTrue();
  });

  it('B88 pausa e retoma a sessão Google sem finalizar duas vezes', async () => {
    let pause = false;
    drive.createExternalUploadSession.and.callFake(() => {
      pause = true;
      return of({ status: 'upload', session_uri: 'https://upload.example/session', access_token: 'token' });
    });
    const plan = makeGooglePlan(14);
    const paused = await engine.executeGoogle(plan, 10, undefined, {
      shouldPause: () => pause, shouldCancel: () => false,
    }, { onProgress: () => undefined });

    expect(paused.paused).toBeTrue();
    expect(paused.googleSession?.session_uri).toBe('https://upload.example/session');

    const statusStarted = waitForNextPut();
    const operation = engine.executeGoogle(plan, 10, paused.googleSession, noPause(), { onProgress: () => undefined });
    await statusStarted;
    const status = http.expectOne('https://upload.example/session');
    expect(status.request.headers.get('Content-Range')).toBe('bytes */14');

    const dataStarted = waitForNextPut();
    status.flush(null, { status: 308, statusText: 'Resume Incomplete', headers: {} });
    await dataStarted;
    const data = http.expectOne('https://upload.example/session');
    expect(data.request.headers.get('Content-Range')).toBe('bytes 0-13/14');
    data.flush({ id: 'external-id' });

    expect(await operation).toEqual({ paused: false });
    expect(drive.finalizeExternalUpload).toHaveBeenCalledOnceWith(10, 'external-id');
  });

  it('terminal completion vence pausa tardia e finaliza uma vez', async () => {
    let pause = false;
    const requestStarted = waitForNextPut();
    const operation = engine.executeGoogle(makeGooglePlan(14), 10, undefined, {
      shouldPause: () => pause, shouldCancel: () => false,
    }, { onProgress: () => undefined });
    await requestStarted;
    const request = http.expectOne('https://upload.example/session');
    pause = true;
    request.flush({ id: 'external-id' });
    expect(await operation).toEqual({ paused: false });
    expect(drive.finalizeExternalUpload).toHaveBeenCalledOnceWith(10, 'external-id');
  });

  it('cancela antes da sessão e zera a FDK', async () => {
    const plan = makeGooglePlan(14);
    plan.fdk.fill(0x6d);
    const result = await engine.executeGoogle(plan, 10, undefined, {
      shouldPause: () => false, shouldCancel: () => true,
    }, { onProgress: () => undefined });
    expect(result).toEqual({ paused: false, cancelled: true });
    expect(drive.createExternalUploadSession).not.toHaveBeenCalled();
    expect(plan.fdk.every(value => value === 0)).toBeTrue();
  });

  it('cancela durante PUT, aborta a requisição e zera a FDK', async () => {
    const controller = new AbortController();
    const plan = makeGooglePlan(14);
    plan.fdk.fill(0x7a);
    const requestStarted = waitForNextPut();
    const operation = engine.executeGoogle(plan, 10, undefined, {
      shouldPause: () => false, shouldCancel: () => controller.signal.aborted, signal: controller.signal,
    }, { onProgress: () => undefined });
    await requestStarted;
    const request = http.expectOne('https://upload.example/session');
    controller.abort();
    expect(await operation).toEqual({ paused: false, cancelled: true, googleCleanupPending: true });
    expect(request.cancelled).toBeTrue();
    expect(drive.finalizeExternalUpload).not.toHaveBeenCalled();
    expect(plan.fdk.every(value => value === 0)).toBeTrue();
  });

  it('marca cleanup pendente quando cancela o PUT terminal', async () => {
    const controller = new AbortController();
    const plan = makeGooglePlan(14);
    const requestStarted = waitForNextPut();
    const operation = engine.executeGoogle(plan, 10, undefined, {
      shouldPause: () => false, shouldCancel: () => controller.signal.aborted, signal: controller.signal,
    }, { onProgress: () => undefined });
    await requestStarted;
    const request = http.expectOne('https://upload.example/session');
    controller.abort();

    const result = await operation;
    expect(result).toEqual({ paused: false, cancelled: true, googleCleanupPending: true });
    expect(request.cancelled).toBeTrue();
    expect(drive.finalizeExternalUpload).not.toHaveBeenCalled();
    expect(plan.fdk.every(value => value === 0)).toBeTrue();
  });

  it('não marca cleanup pendente ao cancelar PUT não terminal', async () => {
    const controller = new AbortController();
    const total = DRIVE_TRANSFER_CHUNK_SIZE + 1;
    kasumi.encryptFileParts.and.callFake(() => parts([new Blob([new Uint8Array(total)])]));
    const plan = makeGooglePlan(total);
    const requestStarted = waitForNextPut();
    const operation = engine.executeGoogle(plan, 10, undefined, {
      shouldPause: () => false, shouldCancel: () => controller.signal.aborted, signal: controller.signal,
    }, { onProgress: () => undefined });
    await requestStarted;
    const request = http.expectOne('https://upload.example/session');
    controller.abort();

    const result = await operation;
    expect(result).toEqual({ paused: false, cancelled: true });
    expect(request.cancelled).toBeTrue();
    expect(plan.fdk.every(value => value === 0)).toBeTrue();
  });

  it('substitui a sessão também para 401 e limita a uma substituição', async () => {
    drive.createExternalUploadSession.and.returnValues(
      of({ status: 'upload', session_uri: 'https://upload.example/stale', access_token: 'old-token' }),
      of({ status: 'upload', session_uri: 'https://upload.example/fresh', access_token: 'new-token' }),
    );
    const requestStarted = waitForNextPut();
    const operation = engine.executeGoogle(makeGooglePlan(14), 10, undefined, noPause(), { onProgress: () => undefined });
    await requestStarted;
    const stale = http.expectOne('https://upload.example/stale');
    const freshRequestStarted = waitForNextPut();
    stale.flush({}, { status: 401, statusText: 'Unauthorized' });
    await freshRequestStarted;
    const fresh = http.expectOne('https://upload.example/fresh');
    expect(fresh.request.headers.get('Authorization')).toBe('Bearer new-token');
    fresh.flush({ id: 'external-id' });

    await expectAsync(operation).toBeResolvedTo({ paused: false });
    expect(drive.createExternalUploadSession).toHaveBeenCalledTimes(2);
  });

  it('reconcilia escrita ambígua antes de avançar', async () => {
    const total = DRIVE_TRANSFER_CHUNK_SIZE + 1;
    const plan = makeGooglePlan(total);
    kasumi.encryptFileParts.and.callFake(() => parts([new Blob([new Uint8Array(total)])]));
    const requestStarted = waitForNextPut();
    const operation = engine.executeGoogle(plan, 10, undefined, noPause(), { onProgress: () => undefined });
    await requestStarted;
    const put = http.expectOne('https://upload.example/session');
    const statusRequestStarted = waitForNextPut();
    put.error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
    await statusRequestStarted;
    const status = http.expectOne('https://upload.example/session');
    expect(status.request.body).toBeNull();
    expect(status.request.headers.get('Content-Range')).toBe(`bytes */${total}`);
    const finalPutStarted = waitForNextPut();
    status.flush({}, { status: 308, statusText: 'Resume Incomplete', headers: { Range: `bytes=0-${DRIVE_TRANSFER_CHUNK_SIZE - 1}` } });
    await finalPutStarted;
    const finalPut = http.expectOne('https://upload.example/session');
    expect(finalPut.request.headers.get('Content-Range')).toBe(`bytes ${DRIVE_TRANSFER_CHUNK_SIZE}-${total - 1}/${total}`);
    finalPut.flush({ id: 'external-id' });
    await operation;
    expect(drive.finalizeExternalUpload).toHaveBeenCalledOnceWith(10, 'external-id');
  });

  it('aceita confirmação parcial reconstruindo o stream no offset do Google', async () => {
    const total = DRIVE_TRANSFER_CHUNK_SIZE * 2 + 1;
    const plan = makeGooglePlan(total);
    kasumi.encryptFileParts.and.callFake(() => parts([new Blob([new Uint8Array(total)])]));
    const requestStarted = waitForNextPut();
    const operation = engine.executeGoogle(plan, 10, undefined, noPause(), { onProgress: () => undefined });
    await requestStarted;
    const first = http.expectOne('https://upload.example/session');
    const partial = DRIVE_TRANSFER_CHUNK_SIZE / 2;
    const resumedRequestStarted = waitForNextPut();
    first.flush({}, { status: 308, statusText: 'Resume Incomplete', headers: { Range: `bytes=0-${partial - 1}` } });
    await resumedRequestStarted;
    const resumed = http.expectOne('https://upload.example/session');
    expect(resumed.request.headers.get('Content-Range')).toBe(`bytes ${partial}-${partial + DRIVE_TRANSFER_CHUNK_SIZE - 1}/${total}`);
    const lastRequestStarted = waitForNextPut();
    resumed.flush({}, { status: 308, statusText: 'Resume Incomplete', headers: { Range: `bytes=0-${partial + DRIVE_TRANSFER_CHUNK_SIZE - 1}` } });
    await lastRequestStarted;
    const last = http.expectOne('https://upload.example/session');
    expect(last.request.headers.get('Content-Range')).toBe(`bytes ${partial + DRIVE_TRANSFER_CHUNK_SIZE}-${total - 1}/${total}`);
    last.flush({ id: 'external-id' });
    await operation;
    expect(drive.finalizeExternalUpload).toHaveBeenCalledOnceWith(10, 'external-id');
  });

  it('cria uma sessão substituta no máximo uma vez quando a sessão expira', async () => {
    drive.createExternalUploadSession.and.returnValues(
      of({ status: 'upload', session_uri: 'https://upload.example/expired', access_token: 'old-token' }),
      of({ status: 'upload', session_uri: 'https://upload.example/replacement', access_token: 'new-token' }),
    );
    const requestStarted = waitForNextPut();
    const operation = engine.executeGoogle(makeGooglePlan(14), 10, undefined, noPause(), { onProgress: () => undefined });
    await requestStarted;
    const expired = http.expectOne('https://upload.example/expired');
    const replacementStarted = waitForNextPut();
    expired.flush({}, { status: 404, statusText: 'Not Found' });
    await replacementStarted;
    const replacement = http.expectOne('https://upload.example/replacement');
    expect(replacement.request.headers.get('Authorization')).toBe('Bearer new-token');
    replacement.flush({ id: 'external-id' });
    await operation;
    expect(drive.createExternalUploadSession).toHaveBeenCalledTimes(2);
  });

  it('mantém metadata e nonce exatos no recipe Google sem ciphertext', () => {
    const plan = makePlan(14);
    const nonce = new Uint8Array(24).fill(0x44);
    const googlePlan = engine.createGoogleUploadPlan(plan, nonce, '{ exact: true }');
    expect(googlePlan.baseNonce).toBe(nonce);
    expect(googlePlan.rematerializationMetadata).toBe('{ exact: true }');
    expect('encryptedBlob' in googlePlan).toBeFalse();
  });

  it('zera a FDK de planUpload quando a preparação falha depois do RNG', async () => {
    let capturedFdk!: Uint8Array;
    spyOn(globalThis.crypto, 'getRandomValues').and.callFake(value => {
      capturedFdk = value as unknown as Uint8Array;
      capturedFdk.fill(0x5a);
      return value;
    });
    let encryptNameCalls = 0;
    crypto.encryptName.and.callFake(async () => {
      encryptNameCalls++;
      if (encryptNameCalls === 2) throw new Error('encrypted FDK failed');
      return 'encrypted-value';
    });

    await expectAsync(engine.planUpload(new File(['plain'], 'secret.txt')))
      .toBeRejectedWithError('encrypted FDK failed');
    expect(capturedFdk.every(value => value === 0)).toBeTrue();
  });
});

function makePlan(encryptedSize: number): UploadPlan {
  return {
    file: new File(['plain'], 'secret.txt'),
    encryptedName: 'encrypted-name',
    nameHash: 'name-hash',
    encryptedFdk: 'encrypted-fdk',
    fdk: new Uint8Array(32).fill(7),
    totalChunks: Math.ceil(encryptedSize / DRIVE_TRANSFER_CHUNK_SIZE),
    encryptedSize,
  };
}

function makeLocalPlan(encryptedSize: number, baseNonce = new Uint8Array(24).fill(8), metadata?: string): LocalUploadPlan {
  return { ...makePlan(encryptedSize), baseNonce, rematerializationMetadata: metadata };
}

function makeGooglePlan(encryptedSize: number, baseNonce = new Uint8Array(24).fill(8), metadata?: string): GoogleUploadPlan {
  return { ...makePlan(encryptedSize), baseNonce, rematerializationMetadata: metadata };
}

function noPause() {
  return { shouldPause: () => false, shouldCancel: () => false };
}

async function* parts(values: readonly Blob[], captured?: Blob[]): AsyncGenerator<Blob> {
  for (const value of values) {
    captured?.push(value);
    yield value;
  }
}

async function* controlledParts(values: readonly Blob[], onYield: () => void): AsyncGenerator<Blob> {
  for (const value of values) {
    onYield();
    yield value;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(value => { resolve = value; });
  return { promise, resolve };
}
