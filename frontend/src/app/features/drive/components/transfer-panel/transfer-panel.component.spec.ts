import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TransferPanelComponent } from './transfer-panel.component';
import { DriveStore, TransferItem } from '../../state/drive.store';
import { StorageMoveEngineService } from '../../storage-move/storage-move-engine.service';
import { StorageMoveView } from '../../storage-move/storage-move.models';

describe('TransferPanelComponent', () => {
  let fixture: ComponentFixture<TransferPanelComponent>;
  let store: any;
  const moveEngine = {
    jobs: signal<StorageMoveView[]>([]),
    pause: jasmine.createSpy('pause').and.resolveTo(),
    resume: jasmine.createSpy('resume').and.resolveTo(),
    cancel: jasmine.createSpy('cancel').and.resolveTo(),
    clear: jasmine.createSpy('clear'),
  };

  const transfer = (overrides: Partial<TransferItem> = {}): TransferItem => ({
    id: 'transfer-1',
    fileName: 'arquivo.txt',
    type: 'upload',
    status: 'processing',
    progress: 42,
    timestamp: new Date('2026-01-01T12:00:00Z'),
    ...overrides,
  });

  beforeEach(async () => {
    moveEngine.jobs.set([]);
    moveEngine.pause.calls.reset();
    moveEngine.resume.calls.reset();
    moveEngine.cancel.calls.reset();
    moveEngine.clear.calls.reset();
    store = jasmine.createSpyObj('DriveStore', [
      'clearCompletedTransfers', 'pauseTransfer', 'resumeUpload', 'resumeDownload',
      'cancelTransfer', 'recoverUpload'
      , 'pauseTransferGroup', 'resumeTransferGroup', 'cancelTransferGroup', 'clearTransferGroup'
    ], { transfers: signal<TransferItem[]>([]), transferGroupViews: signal([]) });
    store.recoverUpload.and.returnValue(Promise.resolve());

    await TestBed.configureTestingModule({
      imports: [TransferPanelComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: DriveStore, useValue: store },
        { provide: StorageMoveEngineService, useValue: moveEngine },
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(TransferPanelComponent);
    fixture.componentRef.setInput('currentView', 'transfers');
  });

  it('shows the empty transfer state', () => {
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.transfers-empty')?.textContent)
      .toContain('Nenhuma transferência');
    expect(fixture.nativeElement.querySelector('.transfers-popup-wrapper')).toBeNull();
  });

  it('renders processing, success, error and paused states', () => {
    store.transfers.set([
      transfer(),
      transfer({ id: 'success', status: 'success', progress: 100, statusMessage: 'Concluído!' }),
      transfer({ id: 'error', status: 'error', errorMsg: 'Falha de rede' }),
      transfer({ id: 'paused', status: 'paused', progress: 10 }),
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.transfer-card')).toHaveSize(4);
    expect(fixture.nativeElement.querySelector('.spinner')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Falha de rede');
    expect(fixture.nativeElement.querySelector('.transfer-card.success')?.textContent).toContain('Concluído');
    expect(fixture.nativeElement.querySelector('.transfer-card.paused')).not.toBeNull();
  });

  it('uses the Default dark palette for transfer cards', () => {
    document.documentElement.dataset['theme'] = 'default';
    store.transfers.set([transfer()]);
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('.transfer-card') as HTMLElement;
    expect(getComputedStyle(card).backgroundColor).toBe('rgb(32, 32, 32)');
    expect(getComputedStyle(card.querySelector('.transfer-filename')!).color).toBe('rgb(243, 243, 243)');
  });

  it('delegates transfer controls to the store', () => {
    store.transfers.set([
      transfer({ id: 'processing' }),
      transfer({ id: 'upload-paused', status: 'paused' }),
      transfer({ id: 'download-paused', type: 'download', status: 'paused' }),
    ]);
    fixture.detectChanges();

    const buttons = [...fixture.nativeElement.querySelectorAll('.transfer-control-btn')] as HTMLButtonElement[];
    buttons[0].click();
    buttons[1].click();
    buttons[2].click();
    buttons[3].click();
    fixture.nativeElement.querySelector('.clear-completed-btn').click();

    expect(store.pauseTransfer).toHaveBeenCalledWith('processing');
    expect(store.resumeUpload).toHaveBeenCalledWith('upload-paused');
    expect(store.resumeDownload).toHaveBeenCalledWith('download-paused');
    expect(store.cancelTransfer).toHaveBeenCalledWith('upload-paused');
    expect(store.clearCompletedTransfers).toHaveBeenCalled();
  });

  it('toggles the mini popup without changing the transfer view', () => {
    store.transfers.set([transfer({ status: 'success' })]);
    fixture.componentRef.setInput('currentView', 'drive');
    fixture.detectChanges();

    const header = fixture.nativeElement.querySelector('.transfers-popup-header') as HTMLElement;
    expect(fixture.nativeElement.querySelector('.transfers-container')).toBeNull();
    expect(fixture.nativeElement.querySelector('.transfers-popup-body')).not.toBeNull();
    header.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.transfers-popup-body')).toBeNull();
  });

  it('closes the mini popup without clearing transfers', () => {
    store.transfers.set([transfer({ status: 'success' })]);
    fixture.componentRef.setInput('currentView', 'drive');
    fixture.detectChanges();

    const closeButton = fixture.nativeElement.querySelector('[aria-label="Fechar transferências"]') as HTMLButtonElement;
    closeButton.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.transfers-popup-wrapper')).toBeNull();
    expect(store.transfers()).toHaveSize(1);
  });

  it('recovers a paused upload and resets the file input', async () => {
    const pending = transfer({ status: 'paused', isRecovery: true, pendingData: { chunk: 1 } as any });
    store.transfers.set([pending]);
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['data'], 'arquivo.txt')] });
    input.dispatchEvent(new Event('change'));
    await Promise.resolve();

    expect(store.recoverUpload).toHaveBeenCalledWith('transfer-1', { chunk: 1 }, jasmine.any(File));
    expect(input.value).toBe('');
  });

  it('renders status messages and download recovery controls in the popup', () => {
    store.transfers.set([
      transfer({ status: 'processing', statusMessage: 'Enviando', speed: '1 MB/s', eta: '2s' }),
      transfer({ id: 'recovery', type: 'download', status: 'paused', isRecovery: true, statusMessage: 'Selecione o arquivo' }),
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Enviando');
    expect(fixture.nativeElement.textContent).toContain('Selecione o arquivo');
    expect(fixture.nativeElement.querySelectorAll('.mini-transfer-item')).toHaveSize(2);
  });

  it('renders grouped transfers and delegates group controls', () => {
    store.transfers.set([transfer({ id: 'grouped', groupId: 'group-1' })]);
    store.transferGroupViews.set([{
      id: 'group-1', source: 'drop-files', transferIds: ['grouped'], totalFiles: 1,
      completedFiles: 0, failedFiles: 0, cancelledFiles: 0, pausedFiles: 0, activeFiles: 1,
      totalBytes: 100, transferredBytes: 50, progress: 0.5, speedBytesPerSecond: 10,
      etaSeconds: 5, status: 'active', canPause: true, canResume: false, canCancel: true, canClear: false,
    }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.transfer-group-label').textContent).toContain('Arquivos arrastados');
    expect(fixture.nativeElement.querySelector('.transfer-group-meta').textContent).toContain('Em andamento');
    fixture.nativeElement.querySelector('[title="Pausar grupo"]').click();
    expect(store.pauseTransferGroup).toHaveBeenCalledWith('group-1');
    fixture.nativeElement.querySelector('.transfer-group-header').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.transfer-group-item')).not.toBeNull();
  });

  it('renders a persistent storage move with pause controls', () => {
    moveEngine.jobs.set([{
      id: 30, file_id: 9, status: 'transferring', source_provider: 'local', source_external_storage_id: null,
      target_provider: 'google_drive', target_external_storage_id: 7, total_bytes: 100, transferred_bytes: 25,
      is_retryable: false,
      items: [], fileName: 'cipher.bin', sourceLabel: 'Local', targetLabel: 'Conta Google',
      speedBytesPerSecond: 10, etaSeconds: 8,
    }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.storage-move-card')?.textContent).toContain('Local → Conta Google');
    (fixture.nativeElement.querySelector('.storage-move-card .transfer-control-btn') as HTMLButtonElement).click();
    expect(moveEngine.pause).toHaveBeenCalledOnceWith(30);
  });

  it('offers Continue for a manually paused storage move', () => {
    moveEngine.resume.calls.reset();
    moveEngine.jobs.set([{
      id: 35, file_id: 14, status: 'paused', source_provider: 'local', source_external_storage_id: null,
      target_provider: 'google_drive', target_external_storage_id: 7, total_bytes: 100, transferred_bytes: 25,
      is_retryable: false, items: [], fileName: 'manual.bin', sourceLabel: 'Local', targetLabel: 'Google',
      speedBytesPerSecond: 0, etaSeconds: null,
    }]);
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('.storage-move-card') as HTMLElement;
    expect(card.textContent).toContain('Pausado');
    expect(card.querySelector('[title="Pausar"]')).toBeNull();
    const resume = card.querySelector('[title="Continuar"]') as HTMLButtonElement;
    expect(resume).not.toBeNull();
    resume.click();
    expect(moveEngine.resume).toHaveBeenCalledOnceWith(35);
  });

  it('does not offer resume for terminal storage move failures', () => {
    moveEngine.jobs.set([{
      id: 31, file_id: 10, status: 'failed', source_provider: 'local', source_external_storage_id: null,
      target_provider: 'google_drive', target_external_storage_id: 7, total_bytes: 100, transferred_bytes: 25,
      is_retryable: false, error_detail: 'Falha permanente durante a transferencia',
      items: [], fileName: 'cipher.bin', sourceLabel: 'Local', targetLabel: 'Conta Google',
      speedBytesPerSecond: 0, etaSeconds: null,
    }]);
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('.storage-move-card') as HTMLElement;
    expect(card.textContent).toContain('Erro terminal');
    expect([...card.querySelectorAll('button')].some(button => button.textContent?.includes('play_arrow'))).toBeFalse();
  });

  it('aligns mini storage-move controls with valid state transitions', () => {
    fixture.componentRef.setInput('currentView', 'drive');
    moveEngine.pause.calls.reset();
    moveEngine.resume.calls.reset();
    moveEngine.jobs.set([
      {
        id: 36, file_id: 15, status: 'prepared', source_provider: 'local', source_external_storage_id: null,
        target_provider: 'google_drive', target_external_storage_id: 7, total_bytes: 100, transferred_bytes: 0,
        is_retryable: false, items: [], fileName: 'prepared.bin', sourceLabel: 'Local', targetLabel: 'Google',
        speedBytesPerSecond: 0, etaSeconds: null,
      },
      {
        id: 37, file_id: 16, status: 'paused', source_provider: 'local', source_external_storage_id: null,
        target_provider: 'google_drive', target_external_storage_id: 7, total_bytes: 100, transferred_bytes: 25,
        is_retryable: false, items: [], fileName: 'manual.bin', sourceLabel: 'Local', targetLabel: 'Google',
        speedBytesPerSecond: 0, etaSeconds: null,
      },
      {
        id: 38, file_id: 17, status: 'target_uploaded', source_provider: 'local', source_external_storage_id: null,
        target_provider: 'google_drive', target_external_storage_id: 7, total_bytes: 100, transferred_bytes: 100,
        is_retryable: false, items: [], fileName: 'uploaded.bin', sourceLabel: 'Local', targetLabel: 'Google',
        speedBytesPerSecond: 0, etaSeconds: null,
      },
      {
        id: 39, file_id: 18, status: 'cleanup_pending', source_provider: 'local', source_external_storage_id: null,
        target_provider: 'google_drive', target_external_storage_id: 7, total_bytes: 100, transferred_bytes: 100,
        is_retryable: false, items: [], fileName: 'cleanup.bin', sourceLabel: 'Local', targetLabel: 'Google',
        speedBytesPerSecond: 0, etaSeconds: null,
      },
    ]);
    fixture.detectChanges();

    const item = (name: string) => [...fixture.nativeElement.querySelectorAll('.mini-transfer-item.storage-move-card')]
      .find((candidate: HTMLElement) => candidate.textContent?.includes(name)) as HTMLElement;
    const icon = (name: string) => item(name).querySelector('button .material-symbols-outlined')?.textContent?.trim();

    expect(icon('prepared.bin')).toBe('pause');
    expect(icon('manual.bin')).toBe('play_arrow');
    expect(item('uploaded.bin').querySelector('button')).toBeNull();
    expect(item('cleanup.bin').querySelector('button')).toBeNull();

    (item('prepared.bin').querySelector('button') as HTMLButtonElement).click();
    (item('manual.bin').querySelector('button') as HTMLButtonElement).click();
    expect(moveEngine.pause).toHaveBeenCalledOnceWith(36);
    expect(moveEngine.resume).toHaveBeenCalledOnceWith(37);
  });

  it('uses neutral move text and hides unconfirmed speed and ETA', () => {
    moveEngine.jobs.set([{
      id: 32, file_id: 11, status: 'transferring', source_provider: 'google_drive', source_external_storage_id: 1,
      target_provider: 'local', target_external_storage_id: null, total_bytes: 100, transferred_bytes: 96,
      is_retryable: false, items: [], fileName: 'video.bin', sourceLabel: 'Google', targetLabel: 'Local',
      speedBytesPerSecond: 0, etaSeconds: null, stateSyncError: true,
    }]);
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('.storage-move-card') as HTMLElement;
    expect(card.textContent).toContain('Sincronização indisponível');
    expect(card.textContent).toContain('Movendo “video.bin”');
    expect(card.textContent).not.toContain('Transferindo “video.bin”');
    expect(card.textContent).not.toContain('MB/s');
    expect(card.textContent).not.toContain('seg');
    expect(card.querySelector('.transfer-progress-bar-fill')?.getAttribute('style')).toContain('width: 96%');
  });

  it('does not cancel cleanup and preserves retryable paused presentation', () => {
    moveEngine.jobs.set([
      {
        id: 33, file_id: 12, status: 'cleanup_pending', source_provider: 'local', source_external_storage_id: null,
        target_provider: 'google_drive', target_external_storage_id: 1, total_bytes: 10, transferred_bytes: 10,
        is_retryable: false, items: [], fileName: 'cleanup.bin', sourceLabel: 'Local', targetLabel: 'Google',
        speedBytesPerSecond: 0, etaSeconds: null,
      },
      {
        id: 34, file_id: 13, status: 'paused', source_provider: 'local', source_external_storage_id: null,
        target_provider: 'google_drive', target_external_storage_id: 1, total_bytes: 10, transferred_bytes: 5,
        is_retryable: true, items: [], fileName: 'retry.bin', sourceLabel: 'Local', targetLabel: 'Google',
        speedBytesPerSecond: 0, etaSeconds: null,
      },
    ]);
    fixture.detectChanges();

    const cards = [...fixture.nativeElement.querySelectorAll('.storage-move-card')] as HTMLElement[];
    expect(cards[0].querySelector('[title="Cancelar"]')).toBeNull();
    expect(cards[0].querySelector('[title="Continuar"]')).toBeNull();
    expect(cards[1].textContent).toContain('Erro recuperável / Pausado');
    expect(cards[1].querySelector('[title="Continuar"]')).not.toBeNull();
  });

  it('keeps grouped completed items bounded and orders active items first', () => {
    const items = Array.from({ length: 60 }, (_, index) => transfer({
      id: `done-${index}`,
      fileName: `done-${index}`,
      status: 'success',
      progress: 100,
      groupId: 'large-group',
      timestamp: new Date(2026, 0, 1, 12, 0, index),
    }));
    items.push(transfer({ id: 'active', fileName: 'active', groupId: 'large-group', status: 'processing' }));
    store.transfers.set(items);
    store.transferGroupViews.set([{
      id: 'large-group', source: 'multiple-files', transferIds: items.map(item => item.id), totalFiles: items.length,
      completedFiles: 60, failedFiles: 0, cancelledFiles: 0, pausedFiles: 0, activeFiles: 1,
      totalBytes: 60, transferredBytes: 60, progress: 0.99, speedBytesPerSecond: 1,
      etaSeconds: 1, status: 'active', canPause: true, canResume: false, canCancel: true, canClear: false,
    }]);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('.transfer-group-header').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.transfer-group-item')).toHaveSize(26);
    expect(fixture.nativeElement.querySelector('.transfer-group-item-name').textContent).toContain('active');
    expect(fixture.nativeElement.textContent).toContain('Mostrar mais 50');

    fixture.nativeElement.querySelector('.completed-control-btn').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.transfer-group-item')).toHaveSize(61);
  });

  it('uses a single scroll region for the full transfer view', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.transfers-scroll-region')).not.toBeNull();
    expect(getComputedStyle(fixture.nativeElement.querySelector('.transfers-container')).overflow).toBe('hidden');
    expect(fixture.nativeElement.classList.contains('transfer-panel--page')).toBeTrue();
    expect(fixture.nativeElement.querySelector('.transfers-header')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.transfers-header').compareDocumentPosition(fixture.nativeElement.querySelector('.transfers-scroll-region')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the page scrollable and progressive with 813 transfers across two groups', () => {
    const makeGroup = (id: string, completed: number, active: number) => {
      const items = Array.from({ length: completed }, (_, index) => transfer({
        id: `${id}-done-${index}`, fileName: `${id}-done-${index}`, groupId: id, status: 'success', progress: 100,
      }));
      items.push(...Array.from({ length: active }, (_, index) => transfer({
        id: `${id}-active-${index}`, fileName: `${id}-active-${index}`, groupId: id,
        status: index === 1 ? 'paused' : index === 2 ? 'error' : 'processing',
      })));
      return items;
    };
    const first = makeGroup('group-a', 330, 3);
    const second = makeGroup('group-b', 476, 3);
    const standalone = transfer({ id: 'standalone', groupId: undefined, fileName: 'avulso.txt' });
    const items = [...first, ...second, standalone];
    store.transfers.set(items);
    store.transferGroupViews.set([
      { id: 'group-a', source: 'multiple-files', transferIds: first.map(item => item.id), totalFiles: first.length, completedFiles: 330, failedFiles: 1, cancelledFiles: 0, pausedFiles: 1, activeFiles: 1, totalBytes: 333, transferredBytes: 330, progress: .9, speedBytesPerSecond: 1, etaSeconds: 1, status: 'active', canPause: true, canResume: false, canCancel: true, canClear: false },
      { id: 'group-b', source: 'folder-upload', transferIds: second.map(item => item.id), totalFiles: second.length, completedFiles: 476, failedFiles: 1, cancelledFiles: 0, pausedFiles: 1, activeFiles: 1, totalBytes: 479, transferredBytes: 476, progress: .9, speedBytesPerSecond: 1, etaSeconds: 1, status: 'active', canPause: true, canResume: false, canCancel: true, canClear: false },
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.transfer-group')).toHaveSize(2);
    expect(fixture.nativeElement.querySelectorAll('.transfer-group-item')).toHaveSize(0);
    expect(fixture.nativeElement.querySelector('.transfers-list').textContent).toContain('avulso.txt');

    const headers = fixture.nativeElement.querySelectorAll('.transfer-group-header') as NodeListOf<HTMLButtonElement>;
    headers[0].click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.transfer-group-item')).toHaveSize(28);
    expect(fixture.nativeElement.textContent).toContain('Mostrar mais 50');
    expect(headers[0].getAttribute('aria-controls')).toBe('transfer-group-items-group-a');
    expect(fixture.nativeElement.querySelector('#transfer-group-items-group-a')?.getAttribute('role')).toBe('region');

    fixture.nativeElement.querySelector('.completed-control-btn').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.transfer-group-item')).toHaveSize(78);
  });

  it('marks the popup and page variants explicitly', () => {
    store.transfers.set([transfer({ status: 'success' })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.classList.contains('transfer-panel--page')).toBeTrue();

    fixture.componentRef.setInput('currentView', 'drive');
    fixture.detectChanges();
    expect(fixture.nativeElement.classList.contains('transfer-panel--popup')).toBeTrue();
    expect(fixture.nativeElement.querySelector('.transfers-popup-wrapper.transfer-panel--popup')).not.toBeNull();
  });

  it('does not show group progress or an overlaid clear button after completion', () => {
    store.transfers.set([transfer({ id: 'finished', groupId: 'group-2', status: 'success', progress: 100 })]);
    store.transferGroupViews.set([{
      id: 'group-2', source: 'folder-upload', transferIds: ['finished'], totalFiles: 1,
      completedFiles: 1, failedFiles: 0, cancelledFiles: 0, pausedFiles: 0, activeFiles: 0,
      totalBytes: 1024, transferredBytes: 1024, progress: 1, speedBytesPerSecond: 0,
      etaSeconds: null, status: 'success', canPause: false, canResume: false, canCancel: false, canClear: true,
    }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.transfer-group .transfer-progress-bar-container')).toBeNull();
    expect(fixture.nativeElement.querySelector('[title="Limpar grupo"]')).not.toBeNull();
  });

  it('resets an empty recovery input and handles recovery failures', async () => {
    const pending = transfer({ status: 'paused', isRecovery: true, pendingData: {} as any });
    const emptyInput = { files: null, value: 'selected' };
    fixture.componentInstance.onRecoverFileSelected({ target: emptyInput } as any, pending);
    expect(emptyInput.value).toBe('');

    spyOn(window, 'alert');
    store.recoverUpload.and.returnValue(Promise.reject(new DOMException('Upload cancelled', 'AbortError')));
    const cancelledInput = { files: [new File(['data'], 'arquivo.txt')], value: 'selected' };
    fixture.componentInstance.onRecoverFileSelected({ target: cancelledInput } as any, pending);
    await Promise.resolve();
    expect(window.alert).not.toHaveBeenCalled();

    store.recoverUpload.and.returnValue(Promise.reject(new Error('offline')));
    const fileInput = { files: [new File(['data'], 'arquivo.txt')], value: 'selected' };
    fixture.componentInstance.onRecoverFileSelected({ target: fileInput } as any, pending);
    await Promise.resolve();
    await Promise.resolve();
    expect(window.alert).toHaveBeenCalledWith('Falha ao recuperar upload: offline');

    store.recoverUpload.and.returnValue(Promise.reject('unknown failure'));
    const stringFileInput = { files: [new File(['data'], 'arquivo.txt')], value: 'selected' };
    fixture.componentInstance.onRecoverFileSelected({ target: stringFileInput } as any, pending);
    await Promise.resolve();
    await Promise.resolve();
    expect(window.alert).toHaveBeenCalledWith('Falha ao recuperar upload: unknown failure');
  });
});
