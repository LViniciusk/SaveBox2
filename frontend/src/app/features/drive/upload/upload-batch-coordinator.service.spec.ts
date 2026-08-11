import { provideZonelessChangeDetection } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { DriveService } from '../services/drive.service';
import { UploadEngineService } from './upload-engine.service';
import { UploadBatchCoordinatorService } from './upload-batch-coordinator.service';
import {
  BatchUploadResponseItem,
  GoogleUploadPlan,
  LocalUploadPlan,
  UploadBatchCandidate,
  UploadPlan,
} from './upload.models';

describe('UploadBatchCoordinatorService', () => {
  let coordinator: UploadBatchCoordinatorService;
  let drive: jasmine.SpyObj<DriveService>;
  let engine: jasmine.SpyObj<UploadEngineService>;

  beforeEach(() => {
    drive = jasmine.createSpyObj('DriveService', ['batchInitUploads', 'trashFile', 'hardDeleteFile', 'cancelExternalUpload']);
    engine = jasmine.createSpyObj('UploadEngineService', [
      'planUpload', 'createLocalUploadPlan', 'createGoogleUploadPlan', 'discardUploadPlan',
      'executeLocal', 'executeGoogle',
    ]);
    drive.batchInitUploads.and.callFake(request => of({ files: request.map((item, index) => response(item, index + 1)) }));
    drive.trashFile.and.returnValue(of(undefined));
    drive.hardDeleteFile.and.returnValue(of(undefined));
    engine.planUpload.and.callFake(file => Promise.resolve(plan(file.name)));
    engine.createLocalUploadPlan.and.callFake(source => localPlan(source));
    engine.createGoogleUploadPlan.and.callFake(source => googlePlan(source));
    engine.discardUploadPlan.and.callFake(source => source.fdk.fill(0));
    engine.executeLocal.and.resolveTo({ paused: false });
    engine.executeGoogle.and.resolveTo({ paused: false });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(), UploadBatchCoordinatorService,
        { provide: DriveService, useValue: drive },
        { provide: UploadEngineService, useValue: engine },
      ],
    });
    coordinator = TestBed.inject(UploadBatchCoordinatorService);
  });

  it('B.94 expires batch initialization as failure and releases every planned FDK', async () => {
    jasmine.clock().install();
    try {
      const source = new Subject<{ files: BatchUploadResponseItem[] }>();
      drive.batchInitUploads.and.returnValue(source);
      const input = candidate('b94-batch', 'local');
      let summary: unknown;
      const pending = coordinator.upload([input], callbacks()).then(value => { summary = value; });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(source.observed).toBeTrue();
      jasmine.clock().tick(30_000);
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(source.observed).toBeFalse();
      expect(summary).toEqual({ total: 1, succeeded: 0, paused: 0, cancelled: 0, failed: 1 });
      expect(engine.discardUploadPlan).toHaveBeenCalledTimes(1);
      source.error(new Error('synthetic teardown'));
      await pending;
    } finally { jasmine.clock().uninstall(); }
  });

  it('mantém o limite de rede Local em três tarefas e usa streaming', async () => {
    const candidates = Array.from({ length: 4 }, (_, index) => candidate(`local-${index}`, 'local'));
    let active = 0;
    let maximum = 0;
    const enteredThree = deferred<void>();
    const enteredFourth = deferred<void>();
    const releases: Array<Deferred<void>> = [];
    engine.executeLocal.and.callFake(async () => {
      active++;
      maximum = Math.max(maximum, active);
      const gate = deferred<void>();
      releases.push(gate);
      if (active === 3) enteredThree.resolve();
      if (releases.length === 4) enteredFourth.resolve();
      await gate.promise;
      active--;
      return { paused: false };
    });

    const operation = coordinator.upload(candidates, callbacks());
    await enteredThree.promise;
    expect(maximum).toBe(3);
    expect(engine.createGoogleUploadPlan).not.toHaveBeenCalled();
    expect(releases).toHaveSize(3);
    releases[0].resolve();
    await enteredFourth.promise;
    expect(maximum).toBe(3);
    expect(releases).toHaveSize(4);
    releases.slice(1).forEach(release => release.resolve());
    expect(await operation).toEqual({ total: 4, succeeded: 4, paused: 0, cancelled: 0, failed: 0 });
  });

  it('cria recipe somente para Google e entrega ambos sem Blob', async () => {
    const local = candidate('local', 'local');
    const google = candidate('google', 'google_drive');
    const initialized = new Map<string, unknown>();

    const summary = await coordinator.upload([local, google], {
      ...callbacks(),
      onInitialized: (item, value) => initialized.set(item.transferId, value),
    });

    expect(summary.succeeded).toBe(2);
    expect(engine.createLocalUploadPlan).toHaveBeenCalledTimes(1);
    expect(engine.createGoogleUploadPlan).toHaveBeenCalledTimes(1);
    expect(engine.executeLocal).toHaveBeenCalledTimes(1);
    expect(engine.executeGoogle).toHaveBeenCalledTimes(1);
    expect((initialized.get(local.transferId) as { provider: string }).provider).toBe('local');
    expect((initialized.get(google.transferId) as { provider: string }).provider).toBe('google_drive');
  });

  it('compartilha a autoridade de criptografia entre Local e Google', async () => {
    const enteredTwo = deferred<void>();
    const enteredThird = deferred<void>();
    const enteredFourth = deferred<void>();
    const releases: Array<Deferred<void>> = [];
    let active = 0;
    let maximum = 0;
    let probeCount = 0;
    const cryptoProbe = async (): Promise<void> => {
      active++;
      probeCount++;
      maximum = Math.max(maximum, active);
      if (active === 2) enteredTwo.resolve();
      const gate = deferred<void>();
      releases.push(gate);
      if (probeCount === 3) enteredThird.resolve();
      if (probeCount === 4) enteredFourth.resolve();
      await gate.promise;
      active--;
    };
    engine.executeGoogle.and.callFake(async (_plan, _id, _session, _control, _callbacks, schedule) => {
      await schedule!(() => cryptoProbe());
      return { paused: false };
    });
    engine.executeLocal.and.callFake(async (_plan, _id, _control, _callbacks, schedule) => {
      await schedule!(() => cryptoProbe());
      return { paused: false };
    });

    const operation = coordinator.upload([
      candidate('local-1', 'local'), candidate('local-2', 'local'),
      candidate('google-1', 'google_drive'), candidate('google-2', 'google_drive'),
    ], callbacks());
    await enteredTwo.promise;
    expect(maximum).toBe(2);
    expect(releases).toHaveSize(2);
    releases[0].resolve();
    await enteredThird.promise;
    expect(maximum).toBe(2);
    releases[1].resolve();
    await enteredFourth.promise;
    releases.slice(2).forEach(release => release.resolve());
    expect((await operation).failed).toBe(0);
  });

  it('não inicia criptografia para candidato cancelado antes do window', async () => {
    const item = candidate('cancelled', 'local');
    item.control.shouldCancel = () => true;

    const summary = await coordinator.upload([item], callbacks());

    expect(summary).toEqual({ total: 1, succeeded: 0, paused: 0, cancelled: 1, failed: 0 });
    expect(engine.planUpload).not.toHaveBeenCalled();
    expect(engine.executeLocal).not.toHaveBeenCalled();
  });

  it('mantém status pausado sem materializar novamente o Local', async () => {
    const item = candidate('paused', 'local');
    engine.executeLocal.and.resolveTo({ paused: true });
    const results: string[] = [];

    const summary = await coordinator.upload([item], {
      ...callbacks(),
      onResult: result => results.push(result.status),
    });

    expect(summary).toEqual({ total: 1, succeeded: 0, paused: 1, cancelled: 0, failed: 0 });
    expect(results).toEqual(['paused']);
    expect(engine.createGoogleUploadPlan).not.toHaveBeenCalled();
  });

  it('preserva a sessão Google e o sinal de cleanup no resultado do batch', async () => {
    const item = candidate('paused-google', 'google_drive');
    const session = { session_uri: 'https://upload.example/s1', access_token: 'token-s1' };
    engine.executeGoogle.and.resolveTo({ paused: true, googleSession: session, googleCleanupPending: true });
    const results: unknown[] = [];

    await coordinator.upload([item], {
      ...callbacks(),
      onResult: result => results.push(result),
    });

    expect(results).toEqual([{
      transferId: item.transferId,
      status: 'paused',
      googleSession: session,
    }]);
  });

  it('aguarda o callback assíncrono de resultado pausado antes de resolver o batch', async () => {
    const item = candidate('paused-callback', 'local');
    engine.executeLocal.and.resolveTo({ paused: true });
    const callbackStarted = deferred<void>();
    const releaseCallback = deferred<void>();
    let operationResolved = false;

    const operation = coordinator.upload([item], {
      ...callbacks(),
      onResult: async result => {
        expect(result).toEqual({ transferId: item.transferId, status: 'paused' });
        callbackStarted.resolve(undefined);
        await releaseCallback.promise;
      },
    });
    void operation.then(() => { operationResolved = true; });

    await callbackStarted.promise;
    expect(operationResolved).toBeFalse();

    releaseCallback.resolve(undefined);
    const summary = await operation;

    expect(operationResolved).toBeTrue();
    expect(summary).toEqual({ total: 1, succeeded: 0, paused: 1, cancelled: 0, failed: 0 });
  });

  it('não materializa Google no coordinator nem cria fallback Local', async () => {
    const item = candidate('google', 'google_drive');

    const summary = await coordinator.upload([item], callbacks());

    expect(summary.succeeded).toBe(1);
    expect(engine.createGoogleUploadPlan).toHaveBeenCalledTimes(1);
    expect(engine.executeGoogle).toHaveBeenCalledTimes(1);
    expect(engine.executeLocal).not.toHaveBeenCalled();
  });

  it('mantém window de 10 e interrompe windows posteriores após 401', async () => {
    const candidates = Array.from({ length: 11 }, (_, index) => candidate(`auth-${index}`, 'local'));
    drive.batchInitUploads.and.returnValue(throwError(() => new HttpErrorResponse({ status: 401 })));
    const results: string[] = [];

    const summary = await coordinator.upload(candidates, {
      ...callbacks(),
      onResult: result => results.push(result.transferId),
    });

    expect(summary).toEqual({ total: 11, succeeded: 0, paused: 0, cancelled: 0, failed: 11 });
    expect(drive.batchInitUploads).toHaveBeenCalledTimes(1);
    expect(drive.batchInitUploads.calls.mostRecent().args[0]).toHaveSize(10);
    expect(engine.planUpload).toHaveBeenCalledTimes(10);
    expect(results).toHaveSize(11);
  });

  it('divide 11 candidatos em windows 10 + 1', async () => {
    const candidates = Array.from({ length: 11 }, (_, index) => candidate(`window-${index}`, 'local'));
    drive.batchInitUploads.and.callFake(items => of({
      files: items.map((item, index) => response(item, index + 1)),
    }));

    const summary = await coordinator.upload(candidates, callbacks());

    expect(summary.succeeded).toBe(11);
    expect(drive.batchInitUploads.calls.allArgs().map(([items]) => items.length)).toEqual([10, 1]);
  });

  it('limita o planejamento a duas tarefas sem depender de tempo', async () => {
    const candidates = Array.from({ length: 5 }, (_, index) => candidate(`plan-${index}`, 'local'));
    const enteredTwo = deferred<void>();
    const releases: Array<Deferred<void>> = [];
    let active = 0;
    let maximum = 0;
    let hold = true;
    engine.planUpload.and.callFake(async file => {
      if (!hold) return plan(file.name);
      active++;
      maximum = Math.max(maximum, active);
      if (active === 2) enteredTwo.resolve();
      const gate = deferred<void>();
      releases.push(gate);
      await gate.promise;
      active--;
      return plan(file.name);
    });
    drive.batchInitUploads.and.callFake(items => of({
      files: items.map((item, index) => response(item, index + 1)),
    }));

    const operation = coordinator.upload(candidates, callbacks());
    await enteredTwo.promise;
    expect(engine.planUpload).toHaveBeenCalledTimes(2);
    expect(maximum).toBe(2);
    hold = false;
    releases.slice(0, 2).forEach(gate => gate.resolve());
    expect((await operation).succeeded).toBe(5);
    expect(maximum).toBe(2);
  });

  it('limita a rede Google a duas execuções', async () => {
    const candidates = Array.from({ length: 3 }, (_, index) => candidate(`google-${index}`, 'google_drive'));
    const enteredTwo = deferred<void>();
    const releases: Array<Deferred<void>> = [];
    let active = 0;
    let maximum = 0;
    let hold = true;
    engine.executeGoogle.and.callFake(async () => {
      if (!hold) return { paused: false };
      active++;
      maximum = Math.max(maximum, active);
      if (active === 2) enteredTwo.resolve();
      const gate = deferred<void>();
      releases.push(gate);
      await gate.promise;
      active--;
      return { paused: false };
    });
    drive.batchInitUploads.and.callFake(items => of({
      files: items.map((item, index) => response(item, index + 1)),
    }));

    const operation = coordinator.upload(candidates, callbacks());
    await enteredTwo.promise;
    expect(maximum).toBe(2);
    expect(releases).toHaveSize(2);
    hold = false;
    releases.forEach(gate => gate.resolve());
    expect((await operation).succeeded).toBe(3);
    expect(maximum).toBe(2);
  });

  it('valida a matriz de respostas antes de executar qualquer provider', async () => {
    const localOne = candidate('matrix-1', 'local');
    const localTwo = candidate('matrix-2', 'local');
    const validOne = response({ client_ref: localOne.transferId, name_hash: 'hash-matrix-1', storage_provider: 'local' }, 1);
    const validTwo = response({ client_ref: localTwo.transferId, name_hash: 'hash-matrix-2', storage_provider: 'local' }, 2);
    const cases: Array<{ candidates: UploadBatchCandidate[]; responses: BatchUploadResponseItem[] }> = [
      { candidates: [localOne], responses: [] },
      { candidates: [localOne], responses: [{ ...validOne, client_ref: '' }] },
      { candidates: [localOne], responses: [{ ...validOne, client_ref: 'unknown' }] },
      { candidates: [localOne], responses: [{ ...validOne, name_hash: 'wrong' }] },
      { candidates: [localOne, localTwo], responses: [validOne, { ...validOne, file_id: 3 }] },
      { candidates: [localOne, localTwo], responses: [validOne, { ...validTwo, file_id: 1 }] },
      { candidates: [localOne], responses: [{ ...validOne, storage_provider: 'invalid' as BatchUploadResponseItem['storage_provider'] }] },
    ];

    for (const testCase of cases) {
      drive.batchInitUploads.and.returnValue(of({ files: testCase.responses }));
      engine.executeLocal.calls.reset();
      engine.executeGoogle.calls.reset();
      engine.discardUploadPlan.calls.reset();
      const results: unknown[] = [];
      const summary = await coordinator.upload(testCase.candidates, {
        ...callbacks(),
        onResult: result => results.push(result),
      });

      expect(summary.failed).toBe(testCase.candidates.length);
      expect(results).toHaveSize(testCase.candidates.length);
      expect(engine.executeLocal).not.toHaveBeenCalled();
      expect(engine.executeGoogle).not.toHaveBeenCalled();
      expect(engine.discardUploadPlan).toHaveBeenCalledTimes(testCase.candidates.length);
    }
  });

  it('correlaciona respostas fora de ordem por client_ref', async () => {
    const first = candidate('opaque-a', 'local');
    const second = candidate('opaque-b', 'local');
    first.folderId = 101;
    second.folderId = 202;
    engine.planUpload.and.callFake(async file => ({ ...plan(file.name), nameHash: 'same-name-hash' }));
    drive.batchInitUploads.and.callFake(items => of({
      files: [...items].reverse().map(item => ({
        ...response(item, item.client_ref === first.transferId ? 101 : 202),
        name_hash: 'same-name-hash',
      })),
    }));
    const initialized = new Map<string, number>();

    const summary = await coordinator.upload([first, second], {
      ...callbacks(),
      onInitialized: (item, _initialized, init) => initialized.set(item.transferId, init.file_id),
    });

    expect(summary.succeeded).toBe(2);
    expect(initialized).toEqual(new Map([['opaque-a', 101], ['opaque-b', 202]]));
  });

  it('rejeita duplicata no mesmo diretório e permite a mesma hash em diretórios diferentes', async () => {
    const duplicateA = candidate('duplicate-a', 'local');
    const duplicateB = candidate('duplicate-b', 'local');
    const otherFolder = candidate('other-folder', 'local');
    duplicateA.folderId = duplicateB.folderId = 7;
    otherFolder.folderId = 8;
    drive.batchInitUploads.and.callFake(items => of({
      files: items.map((item, index) => ({ ...response(item, index + 1), name_hash: 'same-hash' })),
    }));
    const planned = new Map<string, UploadPlan>();
    engine.planUpload.and.callFake(async file => {
      const next = { ...plan(file.name), nameHash: 'same-hash' };
      planned.set(file.name, next);
      return next;
    });

    const summary = await coordinator.upload([duplicateA, duplicateB, otherFolder], callbacks());

    expect(summary).toEqual({ total: 3, succeeded: 1, paused: 0, cancelled: 0, failed: 2 });
    expect(drive.batchInitUploads.calls.mostRecent().args[0]).toHaveSize(1);
    expect(engine.discardUploadPlan).toHaveBeenCalledTimes(2);
    expect([...planned.values()].filter(item => item.fdk.every(value => value === 0))).toHaveSize(2);
  });

  it('emite exatamente um resultado terminal por candidato e preserva a soma', async () => {
    const success = candidate('terminal-success', 'local');
    const paused = candidate('terminal-paused', 'local');
    const failed = candidate('terminal-failed', 'local');
    const cancelled = candidate('terminal-cancelled', 'local');
    cancelled.control.shouldCancel = () => true;
    engine.executeLocal.and.callFake(async local => {
      if (local.file.name === paused.file.name) return { paused: true };
      if (local.file.name === failed.file.name) throw new Error('execution failed');
      return { paused: false };
    });
    drive.batchInitUploads.and.callFake(items => of({
      files: items.map((item, index) => response(item, index + 1)),
    }));
    const results: unknown[] = [];

    const summary = await coordinator.upload([success, paused, failed, cancelled], {
      ...callbacks(),
      onResult: result => results.push(result),
    });

    expect(summary).toEqual({ total: 4, succeeded: 1, paused: 1, cancelled: 1, failed: 1 });
    expect(results).toHaveSize(4);
    expect(summary.succeeded + summary.paused + summary.cancelled + summary.failed).toBe(summary.total);
  });

  it('serializa uploads de topo sem bloquear o processamento interno', async () => {
    const first = candidate('serialized-first', 'local');
    const second = candidate('serialized-second', 'local');
    const firstEntered = deferred<void>();
    const releaseFirst = deferred<void>();
    engine.planUpload.and.callFake(async file => {
      if (file.name === first.file.name) {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      return plan(file.name);
    });
    drive.batchInitUploads.and.callFake(items => of({
      files: items.map((item, index) => response(item, index + 1)),
    }));

    const firstOperation = coordinator.upload([first], callbacks());
    await firstEntered.promise;
    const secondOperation = coordinator.upload([second], callbacks());
    expect(engine.planUpload).toHaveBeenCalledTimes(1);

    releaseFirst.resolve();
    await firstOperation;
    await secondOperation;
    expect(engine.planUpload).toHaveBeenCalledTimes(2);
  });

  it('não publica nem limpa remotamente quando a sessão é desanexada durante a execução', async () => {
    const item = candidate('detached', 'local');
    let detached = false;
    (item.control as any).shouldDetach = () => detached;
    const executionStarted = deferred<void>();
    const releaseExecution = deferred<{ paused: boolean }>();
    engine.executeLocal.and.callFake(async () => {
      executionStarted.resolve();
      return releaseExecution.promise;
    });
    const results: unknown[] = [];

    const operation = coordinator.upload([item], {
      ...callbacks(),
      onResult: result => results.push(result),
    });
    await executionStarted.promise;
    detached = true;
    releaseExecution.resolve({ paused: false });

    const summary = await operation;

    expect(summary.succeeded).toBe(0);
    expect(summary.cancelled).toBe(0);
    expect(results).toEqual([]);
    expect(drive.trashFile).not.toHaveBeenCalled();
    expect(drive.hardDeleteFile).not.toHaveBeenCalled();
  });

  it('mantém cancelamento explícito separado do detach de sessão', async () => {
    const item = candidate('detached-before-handoff', 'local');
    let detached = false;
    (item.control as any).shouldDetach = () => detached;
    engine.executeLocal.and.callFake(async () => ({ paused: false, cancelled: true }));

    const results: string[] = [];
    const operation = coordinator.upload([item], {
      ...callbacks(),
      onInitialized: () => { detached = true; },
      onResult: result => results.push(result.status),
    });

    const summary = await operation;

    expect(summary.cancelled).toBe(0);
    expect(results).toEqual([]);
    expect(engine.executeLocal).not.toHaveBeenCalled();
    expect(drive.trashFile).not.toHaveBeenCalled();
    expect(drive.hardDeleteFile).not.toHaveBeenCalled();
  });
});

function plan(name: string): UploadPlan {
  return {
    file: new File(['plain'], name),
    encryptedName: `encrypted-${name}`,
    nameHash: `hash-${name}`,
    encryptedFdk: `fdk-${name}`,
    fdk: new Uint8Array(32).fill(7),
    encryptedSize: 14,
    totalChunks: 1,
  };
}

function localPlan(source: UploadPlan): LocalUploadPlan {
  return { ...source, baseNonce: new Uint8Array(24).fill(8) };
}

function googlePlan(source: UploadPlan): GoogleUploadPlan {
  return { ...source, baseNonce: new Uint8Array(24).fill(8) };
}

function candidate(name: string, provider: 'local' | 'google_drive'): UploadBatchCandidate {
  return {
    file: new File(['plain'], name),
    folderId: null,
    transferId: name,
    provider,
    control: { shouldPause: () => false, shouldCancel: () => false },
  };
}

function response(request: { client_ref: string; name_hash: string; storage_provider: 'local' | 'google_drive' }, fileId: number): BatchUploadResponseItem {
  return {
    client_ref: request.client_ref,
    file_id: fileId,
    name_hash: request.name_hash,
    storage_provider: request.storage_provider,
  };
}

function callbacks() {
  return {
    onInitialized: () => undefined,
    onStarted: () => undefined,
    onProgress: () => undefined,
    onResult: () => undefined,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(value => { resolve = value; });
  return { promise, resolve };
}
