import { CommonModule } from '@angular/common';
import { Component, inject, input, signal } from '@angular/core';
import { DriveStore, TransferItem } from '../../state/drive.store';
import { DriveView } from '../../state/drive.types';

@Component({
  selector: 'app-transfer-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (currentView() === 'transfers') {
      <div class="transfers-container">
        <div class="transfers-header">
          <h2>Fila de Transferências</h2>
          @if (driveStore.transfers().length > 0) {
            <button class="clear-completed-btn" (click)="driveStore.clearCompletedTransfers()">
              <span class="material-symbols-outlined">clear_all</span>
              Limpar Concluídos
            </button>
          }
        </div>

        @if (driveStore.transferGroupViews().length > 0) {
          <div class="transfer-groups">
            @for (group of driveStore.transferGroupViews(); track group.id) {
              <div class="transfer-group" [class.terminal-group]="group.canClear">
                <button class="transfer-group-header" (click)="toggleGroup(group.id)" [attr.aria-expanded]="isGroupExpanded(group.id)">
                  <span class="material-symbols-outlined">{{ isGroupExpanded(group.id) ? 'expand_more' : 'chevron_right' }}</span>
                  <span class="transfer-group-label">{{ groupSourceLabel(group.source) }}</span>
                  <span class="transfer-group-count">{{ group.completedFiles }}/{{ group.totalFiles }}</span>
                </button>
                <div class="transfer-group-summary">
                  <div class="transfer-group-meta">{{ groupStatusLabel(group.status) }} · {{ group.progress * 100 | number:'1.0-0' }}%</div>
                  @if (group.status !== 'success' && group.status !== 'error' && group.status !== 'cancelled') {
                    <div class="transfer-progress-bar-container"><div class="transfer-progress-bar-fill" [style.width.%]="group.progress * 100"></div></div>
                  }
                  <div class="transfer-group-meta">{{ formatBytes(group.transferredBytes) }} / {{ formatBytes(group.totalBytes) }}</div>
                  <div class="transfer-group-actions">
                    @if (group.canPause) { <button class="transfer-control-btn" (click)="$event.stopPropagation(); driveStore.pauseTransferGroup(group.id)" title="Pausar grupo"><span class="material-symbols-outlined">pause</span></button> }
                    @if (group.canResume) { <button class="transfer-control-btn" (click)="$event.stopPropagation(); driveStore.resumeTransferGroup(group.id)" title="Retomar grupo"><span class="material-symbols-outlined">play_arrow</span></button> }
                    @if (group.canCancel) { <button class="transfer-control-btn cancel" (click)="$event.stopPropagation(); driveStore.cancelTransferGroup(group.id)" title="Cancelar grupo"><span class="material-symbols-outlined">close</span></button> }
                    @if (group.canClear) { <button class="transfer-control-btn" (click)="$event.stopPropagation(); driveStore.clearTransferGroup(group.id)" title="Limpar grupo"><span class="material-symbols-outlined">delete</span></button> }
                  </div>
                </div>
                @if (isGroupExpanded(group.id)) {
                  <div class="transfer-group-items">
                    @for (transfer of groupTransfers(group); track transfer.id) {
                      <div class="transfer-group-item" [class.success]="transfer.status === 'success'" [class.error]="transfer.status === 'error'" [class.paused]="transfer.status === 'paused'">
                        <div class="transfer-group-item-name" [title]="transfer.fileName">{{ transfer.fileName }}</div>
                        <div class="transfer-group-item-status">
                          @if (transfer.status === 'processing') {
                            <span>{{ transfer.progress }}%</span>
                            <button class="transfer-control-btn" (click)="driveStore.pauseTransfer(transfer.id)" title="Pausar arquivo"><span class="material-symbols-outlined">pause</span></button>
                          } @else if (transfer.status === 'paused') {
                            <span>Pausado</span>
                            <button class="transfer-control-btn" (click)="transfer.type === 'upload' ? driveStore.resumeUpload(transfer.id) : driveStore.resumeDownload(transfer.id)" title="Retomar arquivo"><span class="material-symbols-outlined">play_arrow</span></button>
                            <button class="transfer-control-btn cancel" (click)="driveStore.cancelTransfer(transfer.id)" title="Cancelar arquivo"><span class="material-symbols-outlined">close</span></button>
                          } @else if (transfer.status === 'success') {
                            <span>Concluído</span>
                          } @else if (transfer.status === 'error') {
                            <span>Falhou</span>
                          }
                        </div>
                      </div>
                    }
                  </div>
                }
              </div>
            }
          </div>
        }

        @if (driveStore.transfers().length === 0) {
          <div class="transfers-empty">
            <span class="material-symbols-outlined empty-icon">check_circle</span>
            <p>Nenhuma transferência pendente ou concluída no momento.</p>
          </div>
        } @else {
          <div class="transfers-list">
            @for (t of driveStore.transfers(); track t.id) {
              @if (!t.groupId) {
              <div class="transfer-card" [class.error]="t.status === 'error'" [class.success]="t.status === 'success'" [class.paused]="t.status === 'paused'">
                <div class="transfer-icon-area">
                  @if (t.type === 'upload') {
                    <span class="material-symbols-outlined transfer-type-icon upload">upload</span>
                  } @else {
                    <span class="material-symbols-outlined transfer-type-icon download">download</span>
                  }
                </div>

                <div class="transfer-details">
                  <div class="transfer-filename" [title]="t.fileName">{{ t.fileName }}</div>
                  @if (t.statusMessage) {
                    <div class="transfer-status-message" style="font-size: 11px; color: #666; margin-top: 2px;">{{ t.statusMessage }}</div>
                  }
                  <div class="transfer-meta">
                    <span class="transfer-type-badge">{{ t.type === 'upload' ? 'Upload' : 'Download' }}</span>
                    <span class="transfer-time">{{ t.timestamp | date:'shortTime' }}</span>
                    @if (t.status === 'processing') {
                      <span class="transfer-speed" style="margin-left: 8px; color: #1a73e8; font-weight: 500; display: inline-flex; align-items: center; gap: 4px;">
                        <span class="material-symbols-outlined" style="font-size: 14px;">speed</span>
                        {{ t.speed || 'Calculando...' }}
                      </span>
                      <span class="transfer-eta" style="margin-left: 8px; color: #5f6368; display: inline-flex; align-items: center; gap: 4px;">
                        <span class="material-symbols-outlined" style="font-size: 14px;">schedule</span>
                        {{ t.eta }}
                      </span>
                    } @else if (t.status === 'paused') {
                      <span class="transfer-speed" style="margin-left: 8px; color: #d97706; font-weight: 500; display: inline-flex; align-items: center; gap: 4px;">
                        <span class="material-symbols-outlined" style="font-size: 14px;">pause</span>
                        Pausado
                      </span>
                    }
                  </div>
                  @if (t.status === 'processing' || t.status === 'paused') {
                    <div class="transfer-progress-bar-container">
                      <div class="transfer-progress-bar-fill" [style.width.%]="t.progress" [style.background-color]="t.status === 'paused' ? '#d97706' : '#1a73e8'"></div>
                    </div>
                  }
                  @if (t.status === 'error' && t.errorMsg) {
                    <div class="transfer-error-msg">{{ t.errorMsg }}</div>
                  }
                </div>

                <div class="transfer-status-area" style="display: flex; align-items: center; gap: 8px;">
                  @if (t.status === 'processing') {
                    <div class="status-indicator processing">
                      <div class="spinner"></div>
                      <span>{{ t.progress }}%</span>
                    </div>
                    <button class="transfer-control-btn pause" (click)="driveStore.pauseTransfer(t.id)" title="Pausar">
                      <span class="material-symbols-outlined">pause</span>
                    </button>
                  } @else if (t.status === 'paused') {
                    <div class="status-indicator paused" style="color: #d97706; font-weight: 500; font-size: 13px;">
                      <span>{{ t.progress }}%</span>
                    </div>
                    @if (t.isRecovery) {
                      <button class="transfer-control-btn resume" (click)="recoveryInput.click()" title="Selecionar arquivo para retomar">
                        <span class="material-symbols-outlined">folder_open</span>
                      </button>
                      <input type="file" #recoveryInput style="display: none" (change)="onRecoverFileSelected($event, t)" />
                    } @else {
                      <button class="transfer-control-btn resume" (click)="t.type === 'upload' ? driveStore.resumeUpload(t.id) : driveStore.resumeDownload(t.id)" title="Retomar">
                        <span class="material-symbols-outlined">play_arrow</span>
                      </button>
                    }
                    <button class="transfer-control-btn cancel" (click)="driveStore.cancelTransfer(t.id)" title="Cancelar e limpar">
                      <span class="material-symbols-outlined">close</span>
                    </button>
                  } @else if (t.status === 'success') {
                    <div class="status-indicator success">
                      <span class="material-symbols-outlined">check_circle</span>
                      <span>Concluido</span>
                    </div>
                  } @else if (t.status === 'error') {
                    <div class="status-indicator error">
                      <span class="material-symbols-outlined">error</span>
                      <span>Falhou</span>
                    </div>
                  }
                </div>
              </div>
              }
            }
          </div>
        }
      </div>
    }

    @if (driveStore.transfers().length > 0 && !isTransfersPopupClosed()) {
      <div class="transfers-popup-wrapper">
        <div class="transfers-popup-header" (click)="togglePopup()">
          <span class="popup-title">Transferências ({{ driveStore.transfers().length }})</span>
          <div class="popup-actions">
            <button class="icon-btn" (click)="$event.stopPropagation(); togglePopup()">
              <span class="material-symbols-outlined">{{ isTransfersPopupMinimized() ? 'expand_less' : 'expand_more' }}</span>
            </button>
            <button class="icon-btn" (click)="$event.stopPropagation(); closePopup()" title="Fechar transferências" aria-label="Fechar transferências">
              <span class="material-symbols-outlined">close</span>
            </button>
          </div>
        </div>
        @if (!isTransfersPopupMinimized()) {
          <div class="transfers-popup-body">
            @for (group of driveStore.transferGroupViews(); track group.id) {
              <div class="mini-transfer-group" [class.terminal-group]="group.canClear">
                <button class="mini-group-header" (click)="$event.stopPropagation(); toggleGroup(group.id)" [attr.aria-expanded]="isGroupExpanded(group.id)">
                  <span class="material-symbols-outlined">{{ isGroupExpanded(group.id) ? 'expand_more' : 'chevron_right' }}</span>
                  <span>{{ groupSourceLabel(group.source) }}</span>
                  <span>{{ group.completedFiles }}/{{ group.totalFiles }}</span>
                </button>
                <div class="mini-progress-track"><div class="mini-progress-fill" [style.width.%]="group.progress * 100"></div></div>
              </div>
            }
            @for (t of driveStore.transfers().slice().reverse(); track t.id) {
              @if (!t.groupId || isGroupExpanded(t.groupId)) {
              <div class="mini-transfer-item" [class.success]="t.status === 'success'" [class.error]="t.status === 'error'" [class.paused]="t.status === 'paused'">
                <div class="mini-transfer-icon-wrapper">
                  @if (t.type === 'upload') {
                    <span class="material-symbols-outlined mini-icon">upload</span>
                  } @else {
                    <span class="material-symbols-outlined mini-icon">download</span>
                  }
                </div>
                <div class="mini-transfer-details">
                  <div class="mini-transfer-header">
                    <span class="mini-filename" [title]="t.fileName">{{ t.fileName }}</span>
                    <span class="mini-status">
                      @if (t.status === 'processing') {
                        {{ t.progress }}%
                      } @else if (t.status === 'success') {
                        <span class="material-symbols-outlined success-icon">check_circle</span>
                      } @else if (t.status === 'error') {
                        <span class="material-symbols-outlined error-icon">error</span>
                      } @else if (t.status === 'paused') {
                        <span class="material-symbols-outlined paused-icon">pause</span>
                      }
                    </span>
                  </div>
                  @if (t.status === 'processing' || t.status === 'paused') {
                    <div class="mini-progress-track">
                      <div class="mini-progress-fill" [style.width.%]="t.progress" [style.background-color]="t.status === 'paused' ? '#d97706' : '#1a73e8'"></div>
                    </div>
                  }
                  @if (t.statusMessage && t.status !== 'success') {
                    <div class="mini-status-msg">{{ t.statusMessage }}</div>
                  }
                </div>
              </div>
              }
            }
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .transfers-popup-wrapper { position: absolute; bottom: 24px; right: 24px; width: 360px; background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15), 0 1px 4px rgba(0,0,0,0.1); z-index: 50; display: flex; flex-direction: column; border: 1px solid #dadce0; overflow: hidden; }
    .transfers-popup-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; background: #323232; color: white; cursor: pointer; user-select: none; }
    .transfers-popup-header:hover { background: #404040; }
    .popup-title { font-weight: 500; font-size: 14px; }
    .popup-actions { display: flex; align-items: center; gap: 8px; }
    .popup-actions .icon-btn { background: transparent; border: none; color: white; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 4px; border-radius: 4px; }
    .popup-actions .icon-btn:hover { background: rgba(255,255,255,0.1); }
    .popup-actions .icon-btn span { font-size: 20px; }
    .transfer-groups { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
    .transfer-group { border: 1px solid #d2e3fc; border-radius: 8px; background: #f8fbff; overflow: hidden; }
    .transfer-group.terminal-group { border-color: #c8e6c9; background: #f7fff8; }
    .transfer-group-header, .mini-group-header { width: 100%; display: flex; align-items: center; gap: 6px; border: 0; background: transparent; cursor: pointer; text-align: left; color: #202124; }
    .transfer-group-header { padding: 8px 10px 2px; font-weight: 500; }
    .transfer-group-header .material-symbols-outlined, .mini-group-header .material-symbols-outlined { font-size: 18px; }
    .transfer-group-label { flex: 1; }
    .transfer-group-count { color: #5f6368; font-size: 12px; }
    .transfer-group-summary { padding: 0 10px 8px 34px; }
    .transfer-group-meta { color: #5f6368; font-size: 11px; }
    .transfer-group-actions { display: flex; justify-content: flex-end; margin-top: 4px; }
    .transfer-group-items { border-top: 1px solid #d2e3fc; }
    .transfer-group-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px 7px 34px; border-bottom: 1px solid #e5eefb; font-size: 12px; }
    .transfer-group-item:last-child { border-bottom: 0; }
    .transfer-group-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #334155; }
    .transfer-group-item-status { display: flex; align-items: center; gap: 3px; color: #64748b; }
    .transfer-group-item.success .transfer-group-item-status { color: #166534; }
    .transfer-group-item.error .transfer-group-item-status { color: #991b1b; }
    .transfer-group-item.paused .transfer-group-item-status { color: #b45309; }
    .mini-transfer-group { padding: 8px 12px 6px; border-bottom: 1px solid #e8eaed; background: #f8fbff; }
    .mini-group-header { justify-content: flex-start; font-size: 12px; font-weight: 500; }
    .mini-group-header span:nth-child(2) { flex: 1; }
    .transfers-popup-body { max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; }
    .mini-transfer-item { display: flex; align-items: flex-start; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #f1f3f4; }
    .mini-transfer-item:last-child { border-bottom: none; }
    .mini-transfer-icon-wrapper { color: #5f6368; display: flex; align-items: center; justify-content: center; background: #f1f3f4; border-radius: 50%; width: 32px; height: 32px; flex-shrink: 0; }
    .mini-transfer-icon-wrapper .mini-icon { font-size: 18px; }
    .mini-transfer-item.success .mini-transfer-icon-wrapper { background: #e6f4ea; color: #137333; }
    .mini-transfer-item.error .mini-transfer-icon-wrapper { background: #fce8e6; color: #c5221f; }
    .mini-transfer-details { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .mini-transfer-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .mini-filename { font-size: 13px; font-weight: 500; color: #202124; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mini-status { font-size: 12px; color: #5f6368; display: flex; align-items: center; }
    .mini-status .success-icon { color: #137333; font-size: 16px; }
    .mini-status .error-icon { color: #c5221f; font-size: 16px; }
    .mini-status .paused-icon { color: #d97706; font-size: 16px; }
    .mini-progress-track { width: 100%; height: 4px; background: #e2e8f0; border-radius: 2px; overflow: hidden; margin-top: 2px; }
    .mini-progress-fill { height: 100%; background: #1a73e8; transition: width 0.2s ease-out; }
    .mini-status-msg { font-size: 11px; color: #5f6368; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .transfers-container { padding: 0 24px 24px; font-family: 'Roboto', sans-serif; }
    .transfers-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; border-bottom: 1px solid #e2e8f0; padding-bottom: 12px; }
    .transfers-header h2 { margin: 0; font-size: 20px; font-weight: 500; color: #0f172a; }
    .clear-completed-btn { display: flex; align-items: center; gap: 6px; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 20px; padding: 6px 16px; font-size: 13px; font-weight: 500; color: #334155; cursor: pointer; transition: background 150ms, border-color 150ms; }
    .clear-completed-btn:hover { background: #e2e8f0; border-color: #94a3b8; }
    .clear-completed-btn .material-symbols-outlined { font-size: 18px; }
    .transfers-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 0; color: #64748b; text-align: center; }
    .transfers-empty .empty-icon { font-size: 48px; color: #94a3b8; margin-bottom: 12px; }
    .transfers-empty p { margin: 0; font-size: 14px; }
    .transfers-list { display: flex; flex-direction: column; gap: 12px; }
    .transfer-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; display: flex; align-items: center; gap: 16px; transition: box-shadow 150ms, border-color 150ms; }
    .transfer-card:hover { box-shadow: 0 1px 3px rgba(0,0,0,0.05); border-color: #cbd5e1; }
    .transfer-card.success { background: #f0fdf4; border-color: #bbf7d0; }
    .transfer-card.error { background: #fef2f2; border-color: #fecaca; }
    .transfer-icon-area { width: 40px; height: 40px; border-radius: 50%; background: #e2e8f0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .transfer-card.success .transfer-icon-area { background: #dcfce7; }
    .transfer-card.error .transfer-icon-area { background: #fee2e2; }
    .transfer-type-icon { font-size: 20px; }
    .transfer-type-icon.upload { color: #0b57d0; }
    .transfer-type-icon.download { color: #0891b2; }
    .transfer-details { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .transfer-filename { font-size: 14px; font-weight: 500; color: #1e293b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .transfer-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #64748b; }
    .transfer-type-badge { background: #e2e8f0; padding: 2px 6px; border-radius: 4px; font-weight: 500; }
    .transfer-card.success .transfer-type-badge { background: #dcfce7; color: #166534; }
    .transfer-card.error .transfer-type-badge { background: #fee2e2; color: #991b1b; }
    .transfer-progress-bar-container { width: 100%; height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden; margin-top: 4px; }
    .transfer-progress-bar-fill { height: 100%; background: #1a73e8; border-radius: 3px; transition: width 150ms ease-out; }
    .transfer-error-msg { font-size: 11px; color: #dc2626; margin-top: 4px; font-weight: 500; }
    .transfer-card.paused { background: #fffbeb; border-color: #fde68a; }
    .transfer-card.paused .transfer-icon-area { background: #fef3c7; }
    .transfer-card.paused .transfer-type-icon { color: #d97706; }
    .transfer-card.paused .transfer-type-badge { background: #fef3c7; color: #b45309; }
    .transfer-control-btn { background: transparent; border: none; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #5f6368; transition: background 150ms; }
    .transfer-control-btn:hover { background: rgba(60, 64, 67, 0.08); color: #202124; }
    .transfer-control-btn.pause:hover, .transfer-control-btn.cancel:hover { background: #fee2e2; color: #dc2626; }
    .transfer-control-btn.resume:hover { background: #dcfce7; color: #166534; }
    .transfer-status-area { display: flex; align-items: center; flex-shrink: 0; }
    .status-indicator { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; }
    .status-indicator.processing { color: #0b57d0; }
    .status-indicator.success { color: #166534; }
    .status-indicator.error { color: #991b1b; }
    .status-indicator .material-symbols-outlined { font-size: 18px; }
    .spinner { width: 14px; height: 14px; border: 2px solid #e2e8f0; border-top-color: #1a73e8; border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

    :host-context(:root[data-theme='default']) {
      color: var(--default-workspace-text);
      font-family: 'Segoe UI', sans-serif;
    }
    :host-context(:root[data-theme='default']) .transfers-container { color: var(--default-workspace-text); }
    :host-context(:root[data-theme='default']) .transfers-header { border-color: var(--default-workspace-border); }
    :host-context(:root[data-theme='default']) .transfers-header h2 { color: var(--default-workspace-text); }
    :host-context(:root[data-theme='default']) .clear-completed-btn {
      background: var(--default-workspace-surface);
      border-color: var(--default-context-border);
      color: var(--default-workspace-text);
    }
    :host-context(:root[data-theme='default']) .clear-completed-btn:hover { background: var(--default-context-hover); border-color: var(--default-workspace-selected-border); }
    :host-context(:root[data-theme='default']) .transfer-card,
    :host-context(:root[data-theme='default']) .transfer-group { background: var(--default-workspace-surface); border-color: var(--default-workspace-border); }
    :host-context(:root[data-theme='default']) .transfer-card:hover { border-color: var(--default-workspace-selected-border); box-shadow: none; }
    :host-context(:root[data-theme='default']) .transfer-card.success,
    :host-context(:root[data-theme='default']) .transfer-group.terminal-group { background: #1e3024; border-color: #36583f; }
    :host-context(:root[data-theme='default']) .transfer-card.error { background: #351f21; border-color: #694044; }
    :host-context(:root[data-theme='default']) .transfer-card.paused { background: #332d1c; border-color: #62532a; }
    :host-context(:root[data-theme='default']) .transfer-filename,
    :host-context(:root[data-theme='default']) .transfer-group-header,
    :host-context(:root[data-theme='default']) .mini-group-header,
    :host-context(:root[data-theme='default']) .mini-filename { color: var(--default-workspace-text); }
    :host-context(:root[data-theme='default']) .transfer-meta,
    :host-context(:root[data-theme='default']) .transfer-group-count,
    :host-context(:root[data-theme='default']) .transfer-group-meta,
    :host-context(:root[data-theme='default']) .transfer-group-item-status,
    :host-context(:root[data-theme='default']) .mini-status,
    :host-context(:root[data-theme='default']) .mini-status-msg { color: var(--default-workspace-muted); }
    :host-context(:root[data-theme='default']) .transfer-type-badge,
    :host-context(:root[data-theme='default']) .transfer-icon-area,
    :host-context(:root[data-theme='default']) .mini-transfer-icon-wrapper { background: var(--default-context-hover); color: var(--default-workspace-muted); }
    :host-context(:root[data-theme='default']) .transfer-progress-bar-container,
    :host-context(:root[data-theme='default']) .mini-progress-track { background: var(--default-context-border); }
    :host-context(:root[data-theme='default']) .transfer-progress-bar-fill,
    :host-context(:root[data-theme='default']) .mini-progress-fill { background: var(--default-accent); }
    :host-context(:root[data-theme='default']) .transfer-control-btn { color: var(--default-workspace-muted); }
    :host-context(:root[data-theme='default']) .transfer-control-btn:hover { background: var(--default-context-hover); color: var(--default-workspace-text); }
    :host-context(:root[data-theme='default']) .transfers-popup-wrapper { background: var(--default-context-bg); border-color: var(--default-context-border); box-shadow: var(--default-context-shadow); }
    :host-context(:root[data-theme='default']) .transfers-popup-header { background: var(--default-workspace-surface); border-bottom: 1px solid var(--default-context-border); }
    :host-context(:root[data-theme='default']) .transfers-popup-header:hover { background: var(--default-context-hover); }
    :host-context(:root[data-theme='default']) .mini-transfer-group,
    :host-context(:root[data-theme='default']) .mini-transfer-item { background: var(--default-context-bg); border-color: var(--default-context-border); }
    :host-context(:root[data-theme='default']) .status-indicator.processing { color: var(--default-accent); }
    :host-context(:root[data-theme='default']) .spinner { border-color: var(--default-context-border); border-top-color: var(--default-accent); }
    :host-context(:root[data-theme='default']) .transfer-status-message,
    :host-context(:root[data-theme='default']) .transfer-speed,
    :host-context(:root[data-theme='default']) .transfer-eta { color: var(--default-workspace-muted) !important; }
    :host-context(:root[data-theme='default']) .transfer-progress-bar-fill[style],
    :host-context(:root[data-theme='default']) .mini-progress-fill[style] { background: var(--default-accent) !important; }
  `],
})
export class TransferPanelComponent {
  readonly currentView = input.required<DriveView>();
  readonly driveStore = inject(DriveStore);
  readonly isTransfersPopupMinimized = signal(false);
  readonly isTransfersPopupClosed = signal(false);
  readonly expandedGroups = signal(new Set<string>());

  togglePopup(): void {
    this.isTransfersPopupMinimized.update(value => !value);
  }

  closePopup(): void {
    this.isTransfersPopupClosed.set(true);
  }

  isGroupExpanded(id: string): boolean {
    return this.expandedGroups().has(id);
  }

  toggleGroup(id: string): void {
    this.expandedGroups.update(groups => {
      const next = new Set(groups);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  groupTransfers(group: { transferIds: readonly string[] }): TransferItem[] {
    const byId = new Map(this.driveStore.transfers().map(transfer => [transfer.id, transfer]));
    return group.transferIds.map(id => byId.get(id)).filter((transfer): transfer is TransferItem => !!transfer);
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${parseFloat((bytes / 1024 ** unit).toFixed(1))} ${units[unit]}`;
  }

  groupSourceLabel(source: string): string {
    return {
      'multiple-files': 'Múltiplos arquivos',
      'folder-upload': 'Upload de pasta',
      'drop-files': 'Arquivos arrastados',
      'drop-folders': 'Pastas arrastadas',
      'mixed-drop': 'Drop misto',
    }[source] ?? 'Transferência agrupada';
  }

  groupStatusLabel(status: string): string {
    return {
      queued: 'Na fila',
      active: 'Em andamento',
      paused: 'Pausado',
      success: 'Concluído',
      error: 'Falhou',
      partial: 'Parcial',
      cancelled: 'Cancelado',
    }[status] ?? status;
  }

  onRecoverFileSelected(event: Event, transfer: TransferItem): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      this.driveStore.recoverUpload(transfer.id, transfer.pendingData, file).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        alert('Falha ao recuperar upload: ' + message);
      });
    }
    input.value = '';
  }
}
