import { Component, EventEmitter, Output, inject, signal, HostListener } from '@angular/core';
import { AppStateService } from '../../../../core/state/app-state.service';
import { AuthService } from '../../../../core/auth/auth.service';
import { CryptoService } from '../../../../core/crypto/crypto.service';
import { DriveStore } from '../../state/drive.store';
import { CommonModule } from '@angular/common';
import { DialogService } from '../../../../core/dialog/dialog.service';

@Component({
  selector: 'app-topbar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <header class="topbar">
      <div class="left-section">
        <div class="logo-area">
          <span class="material-symbols-outlined logo-icon">enhanced_encryption</span>
          <span class="logo-text">Nanika</span>
        </div>

        <div class="search-bar">
          <span class="material-symbols-outlined search-icon">search</span>
          <input type="text" placeholder="Pesquisar no Drive" class="search-input" />
        </div>
      </div>

      <div class="actions">
        @if (appState.isLocked()) {
          <button class="unlock-btn" (click)="onUnlockClick()">
            <span class="material-symbols-outlined">lock_open</span>
            Desbloquear Drive
          </button>
        } @else {
          <button class="lock-btn" (click)="lockVault()" title="Trancar Drive">
            <span class="material-symbols-outlined">lock</span>
          </button>
        }

        <div class="avatar-container">
          <button class="avatar-btn" (click)="toggleProfileMenu()">
            @if (appState.user()?.picture) {
              <img [src]="appState.user()?.picture" alt="Avatar" class="avatar-img" />
            } @else {
              <div class="avatar-fallback">{{ appState.user()?.name?.charAt(0) || 'U' }}</div>
            }
          </button>

          @if (isProfileMenuOpen()) {
            <div class="profile-dropdown" (click)="$event.stopPropagation()">
              <!-- Close Button -->
              <button class="profile-close-btn" (click)="isProfileMenuOpen.set(false)" title="Fechar">
                <span class="material-symbols-outlined">close</span>
              </button>

              <!-- User Email Header -->
              <div class="profile-email-header">
                {{ appState.user()?.email || 'user@example.com' }}
              </div>

              <!-- Main Avatar Section -->
              <div class="profile-main-section">
                <div class="profile-pic-ring">
                  <div class="profile-pic-wrapper">
                    @if (appState.user()?.picture) {
                      <img [src]="appState.user()?.picture" alt="Avatar" class="profile-pic-large" />
                    } @else {
                      <div class="profile-pic-fallback-large">{{ appState.user()?.name?.charAt(0) || 'U' }}</div>
                    }
                    <button class="profile-pic-camera-badge" title="Mudar foto de perfil">
                      <span class="material-symbols-outlined">photo_camera</span>
                    </button>
                  </div>
                </div>

                <div class="profile-greeting">
                  Olá, {{ appState.user()?.name || 'usuário' }}!
                </div>

                <button class="profile-manage-account-btn" (click)="openSettings()">
                  Gerenciar sua Conta Nanika
                </button>
              </div>

              <!-- Cards Section -->
              <div class="profile-cards-section">
                <!-- Linked Accounts Expandable -->
                @if (isAccountsExpanded()) {
                  <div class="profile-card-expanded-container">
                    <div class="profile-card-row" (click)="isAccountsExpanded.set(false)">
                      <span class="card-row-text">Ocultar contas vinculadas</span>
                      <span class="material-symbols-outlined bubble-chevron">expand_less</span>
                    </div>

                    @for (acc of driveStore.linkedAccounts(); track acc.id) {
                      <div class="profile-card-subrow" (click)="$event.stopPropagation()">
                        <span class="user-bubble {{ getBubbleColorClass(acc.account_email) }}">
                          {{ acc.account_email.charAt(0).toUpperCase() }}
                        </span>
                        <div class="subrow-details">
                          <span class="subrow-name">{{ getAccountName(acc.account_email) }}</span>
                          <span class="subrow-email">{{ acc.account_email }}</span>
                        </div>
                      </div>
                    }

                    <div class="profile-card-subrow action-row" (click)="linkGoogleDrive(); $event.stopPropagation()">
                      <span class="user-bubble bubble-add">
                        <span class="material-symbols-outlined">add</span>
                      </span>
                      <span class="action-row-text">Adicionar outra conta</span>
                    </div>
                  </div>
                } @else {
                  <div class="profile-card-row" (click)="isAccountsExpanded.set(true)">
                    <span class="card-row-text">Mostrar contas vinculadas</span>
                    <div class="card-row-bubbles">
                      @for (acc of driveStore.linkedAccounts().slice(0, 3); track acc.id) {
                        <span class="user-bubble {{ getBubbleColorClass(acc.account_email) }}">
                          {{ acc.account_email.charAt(0).toUpperCase() }}
                        </span>
                      }
                      @if (driveStore.linkedAccounts().length > 3) {
                        <span class="user-bubble bubble-blue">+{{ driveStore.linkedAccounts().length - 3 }}</span>
                      }
                      <span class="material-symbols-outlined bubble-chevron">expand_more</span>
                    </div>
                  </div>
                }

                <!-- Option 2: Actual Quota -->
                <div class="profile-card-row no-hover">
                  <div class="quota-card-content">
                    <span class="material-symbols-outlined quota-card-icon">cloud</span>
                    <span class="quota-card-text">
                      Você usou {{ getQuotaPercentFormatted() }}% de {{ getQuotaMaxFormatted() }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- Logout Button -->
              <button class="profile-logout-btn" (click)="logout()">
                <span class="material-symbols-outlined">logout</span>
                Sair da conta
              </button>

              <!-- Footer -->
              <div class="profile-dropdown-footer">
                Política de Privacidade • Termos de Serviço
              </div>
            </div>
          }
        </div>
      </div>

      <!-- Modal de Configurações -->
      @if (isSettingsOpen()) {
        <div class="modal-backdrop" [class.closing]="isSettingsClosing()" (click)="closeSettings()">
          <div class="modal-content settings-modal" [class.closing]="isSettingsClosing()" (click)="$event.stopPropagation()">
            <div class="modal-header">
              <h3>Configurações do Drive</h3>
              <button class="close-btn" (click)="closeSettings()">
                <span class="material-symbols-outlined">close</span>
              </button>
            </div>
            
            <div class="modal-body">
              <div class="settings-section">
                <h4 class="section-title">Destino de Armazenamento</h4>
                <p class="section-desc">Escolha onde guardar seus arquivos criptografados de ponta a ponta.</p>
                
                <!-- Seletor de Armazenamento -->
                <div class="storage-switch-container">
                  <button 
                    class="switch-option" 
                    [class.active]="driveStore.storageProvider() === 'local'"
                    (click)="driveStore.setStorageProvider('local')">
                    <span class="material-symbols-outlined option-icon">dns</span>
                    <div class="option-details">
                      <span class="option-name">Servidor Local</span>
                      <span class="option-sub">Armazenamento no Nanika</span>
                    </div>
                  </button>

                  <button 
                    class="switch-option" 
                    [class.active]="driveStore.storageProvider() === 'google_drive'"
                    (click)="driveStore.setStorageProvider('google_drive')">
                    <span class="material-symbols-outlined option-icon">cloud_queue</span>
                    <div class="option-details">
                      <span class="option-name">Google Drive</span>
                      <span class="option-sub">Criptografado na sua nuvem</span>
                    </div>
                  </button>
                </div>

                <!-- Contas Vinculadas do Google Drive -->
                @if (driveStore.storageProvider() === 'google_drive') {
                  <div class="gdrive-section fade-in">
                    <h4 class="section-title">Contas Google Drive vinculadas</h4>
                    
                    @if (driveStore.linkedAccounts().length === 0) {
                      <div class="warning-box">
                        <span class="material-symbols-outlined warning-icon">warning</span>
                        <p>Nenhuma conta vinculada. Para carregar arquivos via Google Drive, você precisa vincular sua conta do Google.</p>
                      </div>
                      
                      <button class="google-link-btn" (click)="linkGoogleDrive()">
                        <span class="material-symbols-outlined">link</span>
                        Vincular nova conta Google
                      </button>
                    } @else {
                      <div class="accounts-list">
                        @for (acc of driveStore.linkedAccounts(); track acc.id) {
                          <div class="account-item">
                            <div class="account-info">
                              <span class="material-symbols-outlined account-avatar-icon">account_circle</span>
                              <span class="account-email">{{ acc.account_email }}</span>
                            </div>
                            <button class="unlink-btn-item" (click)="unlinkAccount(acc.id)" title="Desvincular conta">
                              <span class="material-symbols-outlined text-danger">delete</span>
                            </button>
                          </div>
                        }
                      </div>

                      <button class="google-link-btn outline-btn" (click)="linkGoogleDrive()">
                        <span class="material-symbols-outlined">add</span>
                        Vincular outra conta Google
                      </button>
                    }
                  </div>
                }
              </div>

              <!-- Alterar Frase de Segurança -->
              <div class="settings-section" style="margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 16px;">
                <h4 class="section-title" style="margin-bottom: 4px;">Alterar Frase de Segurança</h4>
                <p class="section-desc" style="margin-bottom: 12px;">Atualize a frase utilizada para proteger seu drive.</p>
                
                <div class="phrase-form" style="display: flex; flex-direction: column; gap: 8px;">
                  <div class="form-group" style="display: flex; flex-direction: column; gap: 4px;">
                    <label style="font-size: 12px; font-weight: 500; color: #5f6368;">Frase Atual</label>
                    <input 
                      type="password" 
                      [value]="oldPhrase()" 
                      (input)="oldPhrase.set($any($event.target).value)"
                      style="padding: 8px 12px; border: 1px solid #dadce0; border-radius: 4px; font-size: 13px;"
                      placeholder="Introduza a frase atual"
                    />
                  </div>
                  
                  <div class="form-group" style="display: flex; flex-direction: column; gap: 4px;">
                    <label style="font-size: 12px; font-weight: 500; color: #5f6368;">Nova Frase</label>
                    <input 
                      type="password" 
                      [value]="newPhrase()" 
                      (input)="newPhrase.set($any($event.target).value)"
                      style="padding: 8px 12px; border: 1px solid #dadce0; border-radius: 4px; font-size: 13px;"
                      placeholder="Minimo 8 caracteres"
                    />
                  </div>
                  
                  <div class="form-group" style="display: flex; flex-direction: column; gap: 4px;">
                    <label style="font-size: 12px; font-weight: 500; color: #5f6368;">Confirmar Nova Frase</label>
                    <input 
                      type="password" 
                      [value]="confirmPhrase()" 
                      (input)="confirmPhrase.set($any($event.target).value)"
                      style="padding: 8px 12px; border: 1px solid #dadce0; border-radius: 4px; font-size: 13px;"
                      placeholder="Repita a nova frase"
                    />
                  </div>

                  @if (changePhraseError()) {
                    <div style="font-size: 12px; color: #d93025; font-weight: 500; margin-top: 4px;">
                      {{ changePhraseError() }}
                    </div>
                  }

                  @if (changePhraseSuccess()) {
                    <div style="font-size: 12px; color: #137333; font-weight: 500; margin-top: 4px;">
                      {{ changePhraseSuccess() }}
                    </div>
                  }

                  <button 
                    class="btn-primary" 
                    [disabled]="isChangingPhrase() || !cryptoService.isVaultUnlocked()"
                    (click)="changeSecurityPhrase()"
                    style="margin-top: 8px; align-self: flex-start; padding: 8px 16px; background-color: #1a73e8; color: white; border: none; border-radius: 4px; font-size: 13px; font-weight: 500; cursor: pointer;"
                  >
                    {{ isChangingPhrase() ? 'A processar...' : 'Atualizar Frase' }}
                  </button>
                </div>
              </div>

              <!-- Segurança da Conta: Logout Global -->
              <div class="settings-section" style="margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 16px;">
                <h4 class="section-title" style="color: #dc2626; margin-bottom: 4px;">Segurança da Conta</h4>
                <p class="section-desc" style="margin-bottom: 12px;">Encerre todas as sessões ativas e deslogue em todos os outros dispositivos conectados.</p>
                <button class="logout-global-btn" (click)="logoutGlobal()">
                  <span class="material-symbols-outlined">devices</span>
                  Sair de todos os dispositivos
                </button>
              </div>
            </div>
            
            <div class="modal-footer">
              <button class="btn-primary" (click)="closeSettings()">Salvar e Fechar</button>
            </div>
          </div>
        </div>
      }
    </header>
  `,
  styles: [
    `
      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 16px;
        height: 64px;
        background-color: #F8FAFD;
        border-bottom: none;
        box-sizing: border-box;
      }
      .left-section {
        display: flex;
        align-items: center;
        gap: 60px;
        flex: 1;
      }
      .logo-area {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 178px;
      }
      .logo-icon {
        font-size: 28px;
        color: #5f6368;
      }
      .logo-text {
        font-size: 22px;
        color: #3c4043;
        font-weight: 400;
      }
      .search-bar {
        flex: 1;
        max-width: 720px;
        height: 48px;
        background: #E9EEF6;
        border-radius: 24px;
        display: flex;
        align-items: center;
        padding: 0 16px;
        gap: 12px;
        transition: background 0.2s, box-shadow 0.2s;
      }
      .search-bar:focus-within {
        background: #ffffff;
        box-shadow: 0 1px 2px 0 rgba(60, 64, 67, 0.3), 0 1px 3px 1px rgba(60, 64, 67, 0.15);
      }
      .search-icon {
        color: #444746;
      }
      .search-input {
        flex: 1;
        border: none;
        background: transparent;
        font-size: 16px;
        color: #1f1f1f;
        outline: none;
      }
      .search-input::placeholder {
        color: #444746;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 16px;
      }
      .unlock-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        background: #d93025; /* Red warning color to stand out */
        color: white;
        border: none;
        border-radius: 4px;
        padding: 8px 16px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.2s;
      }
      .unlock-btn:hover {
        background: #b31412;
      }
      .lock-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        color: #5f6368;
        border: none;
        border-radius: 50%;
        width: 40px;
        height: 40px;
        cursor: pointer;
        transition: background 0.2s;
      }
      .lock-btn:hover {
        background: #f1f3f4;
      }
      .avatar-btn {
        background: none;
        border: none;
        padding: 4px;
        cursor: pointer;
        border-radius: 50%;
      }
      .avatar-img {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        object-fit: cover;
      }
      .avatar-fallback {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: #1a73e8;
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 500;
        font-size: 16px;
      }
      .avatar-container {
        position: relative;
      }
      .profile-dropdown {
        position: absolute;
        right: 0;
        top: 100%;
        margin-top: 8px;
        background: #e9eef6;
        border: none;
        border-radius: 28px;
        box-shadow: 0 4px 15px rgba(0,0,0,0.15), 0 1px 5px rgba(0,0,0,0.1);
        width: 360px;
        display: flex;
        flex-direction: column;
        z-index: 1000;
        padding: 24px;
        box-sizing: border-box;
      }

      .profile-close-btn {
        position: absolute;
        top: 16px;
        right: 16px;
        background: transparent;
        border: none;
        color: #1f1f1f;
        cursor: pointer;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 150ms;
      }

      .profile-close-btn:hover {
        background: rgba(0,0,0,0.06);
      }

      .profile-close-btn .material-symbols-outlined {
        font-size: 20px;
      }

      .profile-email-header {
        font-family: 'Roboto', sans-serif;
        font-size: 14px;
        font-weight: 500;
        color: #3c4043;
        text-align: center;
        margin-bottom: 20px;
        word-break: break-all;
      }

      .profile-main-section {
        display: flex;
        flex-direction: column;
        align-items: center;
        width: 100%;
      }

      .profile-pic-ring {
        background: transparent;
        padding: 0;
        border-radius: 50%;
        display: inline-block;
      }

      .profile-pic-wrapper {
        position: relative;
        width: 80px;
        height: 80px;
        border-radius: 50%;
        background: white;
        padding: 3px;
        box-sizing: border-box;
      }

      .profile-pic-large {
        width: 100%;
        height: 100%;
        border-radius: 50%;
        object-fit: cover;
      }

      .profile-pic-fallback-large {
        width: 100%;
        height: 100%;
        border-radius: 50%;
        background: #1a73e8;
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 32px;
        font-weight: 500;
        font-family: 'Roboto', sans-serif;
      }

      .profile-pic-camera-badge {
        position: absolute;
        bottom: -2px;
        right: -2px;
        width: 26px;
        height: 26px;
        border-radius: 50%;
        background: #ffffff;
        border: 1px solid #dadce0;
        box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
        color: #1f1f1f;
      }

      .profile-pic-camera-badge .material-symbols-outlined {
        font-size: 15px;
      }

      .profile-greeting {
        font-size: 20px;
        color: #1f1f1f;
        font-family: 'Roboto', sans-serif;
        margin-top: 14px;
        text-align: center;
      }

      .profile-manage-account-btn {
        background: transparent;
        border: 1px solid #747775;
        border-radius: 20px;
        padding: 8px 24px;
        font-size: 14px;
        font-weight: 500;
        color: #0b57d0;
        cursor: pointer;
        margin-top: 14px;
        transition: background 150ms;
        font-family: 'Roboto', sans-serif;
      }

      .profile-manage-account-btn:hover {
        background: rgba(11, 87, 208, 0.06);
      }

      .profile-cards-section {
        width: 100%;
        margin-top: 18px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .profile-card-row {
        background: #ffffff;
        border-radius: 20px;
        padding: 14px 20px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        box-sizing: border-box;
        cursor: pointer;
        transition: background 150ms;
        width: 100%;
      }

      .profile-card-row:hover:not(.no-hover) {
        background: #f8fafc;
      }

      .profile-card-row.no-hover {
        cursor: default;
      }

      .card-row-text {
        font-size: 14px;
        font-weight: 500;
        color: #1f1f1f;
        font-family: 'Roboto', sans-serif;
      }

      .card-row-bubbles {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .user-bubble {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: bold;
        color: white;
        font-family: 'Roboto', sans-serif;
      }

      .bubble-green { background: #137333; }
      .bubble-orange { background: #c93300; }
      .bubble-blue { background: #e8f0fe; color: #1a73e8; }

      .bubble-chevron {
        font-size: 18px;
        color: #5f6368;
        margin-left: 2px;
      }

      .quota-card-content {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
      }

      .quota-card-icon {
        font-size: 20px;
        color: #5f6368;
      }

      .quota-card-text {
        font-size: 13px;
        color: #3c4043;
        font-family: 'Roboto', sans-serif;
      }

      .profile-logout-btn {
        background: #ffffff;
        border: 1px solid #dadce0;
        border-radius: 20px;
        padding: 10px 24px;
        font-size: 14px;
        font-weight: 500;
        color: #3c4043;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        margin: 20px auto 0;
        width: fit-content;
        transition: background 150ms;
        font-family: 'Roboto', sans-serif;
      }

      .profile-logout-btn:hover {
        background: #f8f9fa;
      }

      .profile-logout-btn .material-symbols-outlined {
        font-size: 18px;
      }

      .profile-dropdown-footer {
        font-size: 11px;
        color: #5f6368;
        text-align: center;
        margin-top: 20px;
        font-family: 'Roboto', sans-serif;
      }

      .profile-card-expanded-container {
        background: #ffffff;
        border-radius: 20px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      .profile-card-expanded-container .profile-card-row {
        border-radius: 0;
      }

      .profile-card-subrow {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 20px;
        background: #ffffff;
        cursor: pointer;
        transition: background 150ms;
        box-sizing: border-box;
      }

      .profile-card-subrow:hover {
        background: #f8fafc;
      }

      .subrow-details {
        display: flex;
        flex-direction: column;
        font-family: 'Roboto', sans-serif;
        min-width: 0;
        text-align: left;
      }

      .subrow-name {
        font-size: 14px;
        font-weight: 500;
        color: #1f1f1f;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .subrow-email {
        font-size: 12px;
        color: #5f6368;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .bubble-add {
        background: #e8f0fe;
        color: #0b57d0;
      }

      .bubble-add .material-symbols-outlined {
        font-size: 18px;
      }

      .action-row-text {
        font-size: 14px;
        font-weight: 500;
        color: #0b57d0;
        font-family: 'Roboto', sans-serif;
      }

      .bubble-purple { background: #8e24aa; }
      .bubble-teal { background: #00897b; }

      .logout-global-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        background: #fdf2f2;
        border: 1px solid #fde8e8;
        border-radius: 8px;
        padding: 10px 16px;
        font-size: 14px;
        font-weight: 500;
        color: #de350b;
        cursor: pointer;
        transition: background 150ms, border-color 150ms;
        font-family: 'Roboto', sans-serif;
      }

      .logout-global-btn:hover {
        background: #fde8e8;
        border-color: #fbd5d5;
      }

      .logout-global-btn .material-symbols-outlined {
        font-size: 20px;
      }

      /* Modal de Configurações & Backdrop */
      .modal-backdrop {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(15, 23, 42, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2000;
        animation: fadeInBackdrop 250ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
        transition: opacity 200ms cubic-bezier(0.16, 1, 0.3, 1);
        transform: translate3d(0, 0, 0);
        will-change: opacity;
      }
      .modal-backdrop.closing {
        opacity: 0;
        pointer-events: none;
      }
      
      @keyframes fadeInBackdrop {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      .settings-modal {
        background: #ffffff;
        border-radius: 20px;
        width: 520px;
        max-width: 90%;
        max-height: 85vh;
        box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04);
        overflow: hidden;
        animation: slideUpModal 250ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
        display: flex;
        flex-direction: column;
        transition: transform 200ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms cubic-bezier(0.16, 1, 0.3, 1);
        transform: translate3d(0, 0, 0);
        will-change: transform, opacity;
      }
      .settings-modal.closing {
        transform: translate3d(0, 20px, 0);
        opacity: 0;
      }

      @media (max-width: 576px) {
        .settings-modal {
          width: 95%;
          max-width: 95%;
          max-height: 90vh;
          border-radius: 12px;
        }
        .modal-body {
          padding: 16px !important;
          gap: 16px !important;
        }
      }

      @keyframes slideUpModal {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }

      .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 20px 24px;
        border-bottom: 1px solid #f1f5f9;
      }

      .modal-header h3 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: #0f172a;
      }

      .close-btn {
        background: transparent;
        border: none;
        color: #64748b;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 4px;
        border-radius: 50%;
        transition: background-color 0.2s;
      }

      .close-btn:hover {
        background-color: #f1f5f9;
        color: #0f172a;
      }

      .modal-body {
        padding: 24px;
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 24px;
        scroll-behavior: auto !important;
      }

      .settings-section {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .section-title {
        font-size: 15px;
        font-weight: 600;
        color: #1e293b;
        margin: 0;
      }

      .section-desc {
        font-size: 13px;
        color: #64748b;
        margin: 0;
      }

      .storage-switch-container {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
        margin-top: 8px;
      }

      .switch-option {
        background: #f8fafc;
        border: 2px solid #e2e8f0;
        border-radius: 12px;
        padding: 16px;
        display: flex;
        align-items: flex-start;
        gap: 12px;
        cursor: pointer;
        text-align: left;
        transition: all 0.2s ease;
      }

      .switch-option:hover {
        border-color: #cbd5e1;
        background: #f1f5f9;
      }

      .switch-option.active {
        border-color: #2563eb;
        background: #eff6ff;
      }

      .option-icon {
        font-size: 24px;
        color: #64748b;
        margin-top: 2px;
      }

      .switch-option.active .option-icon {
        color: #2563eb;
      }

      .option-details {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .option-name {
        font-size: 14px;
        font-weight: 600;
        color: #0f172a;
      }

      .option-sub {
        font-size: 11px;
        color: #64748b;
      }

      .gdrive-section {
        border-top: 1px solid #f1f5f9;
        margin-top: 16px;
        padding-top: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .fade-in {
        animation: fadeIn 0.2s ease-out;
      }

      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .warning-box {
        background: #fffbeb;
        border: 1px solid #fde68a;
        border-radius: 8px;
        padding: 12px;
        display: flex;
        align-items: flex-start;
        gap: 10px;
      }

      .warning-icon {
        color: #d97706;
        font-size: 20px;
      }

      .warning-box p {
        margin: 0;
        font-size: 12px;
        color: #92400e;
        line-height: 1.5;
      }

      .google-link-btn {
        background: #2563eb;
        color: white;
        border: none;
        border-radius: 8px;
        padding: 10px 16px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        transition: background 0.2s;
      }

      .google-link-btn:hover {
        background: #1d4ed8;
      }

      .google-link-btn.outline-btn {
        background: transparent;
        color: #2563eb;
        border: 1px solid #dbeafe;
        margin-top: 8px;
      }

      .google-link-btn.outline-btn:hover {
        background: #f0f5ff;
        border-color: #bfdbfe;
      }

      .accounts-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .account-item {
        background: #f8fafc;
        border: 1px solid #f1f5f9;
        border-radius: 8px;
        padding: 10px 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .account-info {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .account-avatar-icon {
        color: #94a3b8;
        font-size: 20px;
      }

      .account-email {
        font-size: 13px;
        color: #334155;
        font-weight: 500;
      }

      .unlink-btn-item {
        background: transparent;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 4px;
        border-radius: 4px;
        transition: all 0.2s;
      }

      .unlink-btn-item:hover {
        background: #fee2e2;
        color: #ef4444;
      }
      
      .text-danger {
        color: inherit;
        font-size: 20px;
      }

      .modal-footer {
        padding: 16px 24px;
        border-top: 1px solid #f1f5f9;
        display: flex;
        justify-content: flex-end;
      }

      .btn-primary {
        background: #0f172a;
        color: white;
        border: none;
        border-radius: 8px;
        padding: 10px 20px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.2s;
      }

      .btn-primary:hover {
        background: #1e293b;
      }
    `,
  ],
})
export class TopbarComponent {
  protected readonly appState = inject(AppStateService);
  protected readonly driveStore = inject(DriveStore);
  private readonly authService = inject(AuthService);
  protected readonly cryptoService = inject(CryptoService);
  protected readonly dialogService = inject(DialogService);

  isProfileMenuOpen = signal(false);
  isSettingsOpen = signal(false);
  isSettingsClosing = signal(false);
  isAccountsExpanded = signal(false);

  oldPhrase = signal('');
  newPhrase = signal('');
  confirmPhrase = signal('');
  changePhraseError = signal('');
  changePhraseSuccess = signal('');
  isChangingPhrase = signal(false);

  @Output() unlockRequested = new EventEmitter<void>();

  toggleProfileMenu() {
    const nextState = !this.isProfileMenuOpen();
    this.isProfileMenuOpen.set(nextState);
    if (nextState) {
      this.isAccountsExpanded.set(false);
      this.driveStore.loadLinkedAccounts();
    }
  }

  getAccountName(email: string): string {
    const parts = email.split('@');
    if (parts.length === 0) return 'Conta Vinculada';
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  }

  getBubbleColorClass(email: string): string {
    const char = email.charAt(0).toLowerCase();
    const index = char.charCodeAt(0) % 5;
    const colors = ['bubble-green', 'bubble-orange', 'bubble-blue', 'bubble-purple', 'bubble-teal'];
    return colors[index];
  }

  onUnlockClick() {
    this.unlockRequested.emit();
  }

  lockVault() {
    // Wipe the key from RAM first
    this.cryptoService.lockVault();
    // Clear decrypted file names so they are not visible while locked
    this.driveStore.clearDecryptedNames();
    // Reset folder navigation to root
    this.driveStore.navigateTo(null);
    // Update app state
    this.appState.lock();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const isClickInside = target.closest('.avatar-container');
    if (!isClickInside) {
      this.isProfileMenuOpen.set(false);
    }
  }

  logout() {
    this.authService.logout();
  }

  logoutGlobal() {
    this.closeSettings();
    this.authService.logoutGlobal();
  }

  getQuotaPercentFormatted(): string {
    const q = this.driveStore.quota();
    if (!q || q.maxBytes === 0) return '0';
    return ((q.usedBytes / q.maxBytes) * 100).toFixed(0);
  }

  getQuotaMaxFormatted(): string {
    const q = this.driveStore.quota();
    if (!q) return '5 TB';
    return this.formatSize(q.maxBytes);
  }

  private formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(0)) + ' ' + sizes[i];
  }

  getQuotaPercent(): string {
    const q = this.driveStore.quota();
    if (!q || q.maxBytes === 0) return '0';
    return ((q.usedBytes / q.maxBytes) * 100).toFixed(1);
  }

  getQuotaFormatted(): string {
    const q = this.driveStore.quota();
    return this.formatBytes(q.usedBytes) + ' de ' + this.formatBytes(q.maxBytes);
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  openSettings() {
    this.isProfileMenuOpen.set(false);
    this.isSettingsOpen.set(true);
    this.driveStore.loadLinkedAccounts();
  }

  closeSettings() {
    this.isSettingsClosing.set(true);
    setTimeout(() => {
      this.isSettingsOpen.set(false);
      this.isSettingsClosing.set(false);
      this.oldPhrase.set('');
      this.newPhrase.set('');
      this.confirmPhrase.set('');
      this.changePhraseError.set('');
      this.changePhraseSuccess.set('');
    }, 200);
  }

  async changeSecurityPhrase() {
    this.changePhraseError.set('');
    this.changePhraseSuccess.set('');

    const oldVal = this.oldPhrase();
    const newVal = this.newPhrase();
    const confVal = this.confirmPhrase();

    if (!oldVal || !newVal || !confVal) {
      this.changePhraseError.set('Todos os campos sao obrigatorios.');
      return;
    }

    if (newVal !== confVal) {
      this.changePhraseError.set('A nova frase e a confirmacao nao coincidem.');
      return;
    }

    if (newVal.length < 8) {
      this.changePhraseError.set('A nova frase deve ter no minimo 8 caracteres.');
      return;
    }

    this.isChangingPhrase.set(true);
    try {
      await this.cryptoService.changeSecurityPhrase(oldVal, newVal);
      this.changePhraseSuccess.set('Frase de seguranca alterada com sucesso! O arquivo nanika-recovery.txt foi baixado.');
      this.oldPhrase.set('');
      this.newPhrase.set('');
      this.confirmPhrase.set('');
    } catch (e: any) {
      if (e?.message === 'WRONG_PASSPHRASE') {
        this.changePhraseError.set('A frase de seguranca atual esta incorreta.');
      } else {
        this.changePhraseError.set(e?.message || 'Erro ao alterar a frase de seguranca.');
      }
    } finally {
      this.isChangingPhrase.set(false);
    }
  }

  linkGoogleDrive() {
    this.driveStore.linkGoogleDrive();
  }

  async unlinkAccount(id: number) {
    const confirmed = await this.dialogService.confirm(
      'Desvincular conta?',
      'Deseja realmente desvincular esta conta do Google Drive? Todos os arquivos associados a ela deixarão de estar acessíveis.',
      'Desvincular',
      true
    );
    if (confirmed) {
      await this.driveStore.unlinkGoogleAccount(id);
    }
  }
}
