import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TransferPanelComponent } from './transfer-panel.component';
import { DriveStore, TransferItem } from '../../state/drive.store';

describe('TransferPanelComponent', () => {
  let fixture: ComponentFixture<TransferPanelComponent>;
  let store: any;

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
    store = jasmine.createSpyObj('DriveStore', [
      'clearCompletedTransfers', 'pauseTransfer', 'resumeUpload', 'resumeDownload',
      'cancelTransfer', 'recoverUpload'
      , 'pauseTransferGroup', 'resumeTransferGroup', 'cancelTransferGroup', 'clearTransferGroup'
    ], { transfers: signal<TransferItem[]>([]), transferGroupViews: signal([]) });
    store.recoverUpload.and.returnValue(Promise.resolve());

    await TestBed.configureTestingModule({
      imports: [TransferPanelComponent],
      providers: [provideZonelessChangeDetection(), { provide: DriveStore, useValue: store }]
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
      transfer({ id: 'success', status: 'success' }),
      transfer({ id: 'error', status: 'error', errorMsg: 'Falha de rede' }),
      transfer({ id: 'paused', status: 'paused', progress: 10 }),
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.transfer-card')).toHaveSize(4);
    expect(fixture.nativeElement.querySelector('.spinner')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Falha de rede');
    expect(fixture.nativeElement.querySelector('.transfer-card.paused')).not.toBeNull();
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
    const pending = transfer({ status: 'paused', isRecovery: true, pendingData: { chunk: 1 } });
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
    const pending = transfer({ status: 'paused', isRecovery: true });
    const emptyInput = { files: null, value: 'selected' };
    fixture.componentInstance.onRecoverFileSelected({ target: emptyInput } as any, pending);
    expect(emptyInput.value).toBe('');

    store.recoverUpload.and.returnValue(Promise.reject(new Error('offline')));
    spyOn(window, 'alert');
    const fileInput = { files: [new File(['data'], 'arquivo.txt')], value: 'selected' };
    fixture.componentInstance.onRecoverFileSelected({ target: fileInput } as any, pending);
    await Promise.resolve();
    expect(window.alert).toHaveBeenCalledWith('Falha ao recuperar upload: offline');

    store.recoverUpload.and.returnValue(Promise.reject('unknown failure'));
    const stringFileInput = { files: [new File(['data'], 'arquivo.txt')], value: 'selected' };
    fixture.componentInstance.onRecoverFileSelected({ target: stringFileInput } as any, pending);
    await Promise.resolve();
    expect(window.alert).toHaveBeenCalledWith('Falha ao recuperar upload: unknown failure');
  });
});
