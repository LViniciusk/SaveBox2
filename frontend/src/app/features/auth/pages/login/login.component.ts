import { Component, inject, afterNextRender, signal, OnInit } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { AuthService } from '../../../../core/auth/auth.service';
import { AppStateService, AppStatus } from '../../../../core/state/app-state.service';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule, CommonModule],
  template: `
    <div class="login-page">
      <div class="login-card" [class.slide-up]="cardVisible()">
        
        <!-- Logo -->
        <div class="logo">
          <span class="material-symbols-outlined logo-icon">enhanced_encryption</span>
          <h1>Nanika</h1>
        </div>
        <p class="subtitle">Armazenamento seguro com criptografia ponta-a-ponta</p>

        <div class="divider"></div>

        <!-- Error Banner -->
        @if (authService.error() || localError()) {
          <div class="error-banner">
            <span class="material-symbols-outlined">error</span>
            {{ authService.error() || localError() }}
          </div>
        }

        <!-- LOGIN CREDENTIALS VIEW -->
        @if (view() === 'login') {
          <h2 class="form-title">Entrar</h2>
          
          <div class="input-group">
            <span class="material-symbols-outlined input-icon">person</span>
            <input type="text" [(ngModel)]="username" placeholder="E-mail ou Usuário" />
          </div>

          <div class="input-group">
            <span class="material-symbols-outlined input-icon">lock</span>
            <input type="password" [(ngModel)]="password" placeholder="Senha" (keyup.enter)="doLogin()" />
          </div>

          <button class="primary-btn" (click)="doLogin()" [disabled]="authService.loading() || !username() || !password()">
            Fazer Login
          </button>

          <button class="google-signin-btn" (click)="signInWithGoogle()" [disabled]="authService.loading()" style="margin-top: 12px;">
            <svg class="google-logo" viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Entrar com Google
          </button>

          <p class="link-text" style="margin-top: 16px;">
            Não possui uma conta? <a href="javascript:void(0)" (click)="view.set('register')">Cadastre-se</a>
          </p>
        }

        <!-- REGISTER VIEW -->
        @if (view() === 'register') {
          <h2 class="form-title">Criar Conta</h2>
          
          <div class="input-group">
            <span class="material-symbols-outlined input-icon">person</span>
            <input type="text" [(ngModel)]="username" placeholder="Nome de usuário" />
          </div>

          <div class="input-group">
            <span class="material-symbols-outlined input-icon">mail</span>
            <input type="email" [(ngModel)]="email" placeholder="E-mail" />
          </div>

          <div class="input-group">
            <span class="material-symbols-outlined input-icon">lock</span>
            <input type="password" [(ngModel)]="password" placeholder="Senha" />
          </div>

          <button class="primary-btn" (click)="doRegister()" [disabled]="!username() || !email() || !password() || authService.loading()">
            Próximo
          </button>

          <p class="link-text" style="margin-top: 16px;">
            Já possui uma conta? <a href="javascript:void(0)" (click)="view.set('login')">Faça login</a>
          </p>
        }

        <!-- AVATAR SELECTION VIEW -->
        @if (view() === 'avatar') {
          <h2 class="form-title">Escolha um Perfil</h2>
          <p class="subtitle" style="margin-bottom: 16px;">Selecione uma foto do seu dispositivo (opcional)</p>
          
          <div class="avatar-upload-container">
            <input type="file" id="avatarUpload" accept="image/*" (change)="onAvatarSelected($event)" style="display: none;" />
            <label for="avatarUpload" class="avatar-upload-label" [class.has-image]="selectedAvatar()">
              @if (selectedAvatar()) {
                <img [src]="selectedAvatar()" alt="Avatar" />
              } @else {
                <span class="material-symbols-outlined icon">add_a_photo</span>
                <span class="upload-text">Selecionar Foto</span>
              }
            </label>
          </div>

          <button class="primary-btn" (click)="finishAvatarUpload()" [disabled]="authService.loading() || isLoading()">
            Finalizar Cadastro
          </button>

          <p class="link-text" style="margin-top: 16px;">
            <a href="javascript:void(0)" (click)="finishAvatarUpload()">Pular esta etapa</a>
          </p>
        }

        <!-- VERIFY VIEW -->
        @if (view() === 'verify') {
          <h2 class="form-title">Verificação</h2>
          <p class="subtitle" style="margin-bottom: 16px;">Insira o código de 6 caracteres enviado para o seu e-mail.</p>
          
          <div class="input-group code-input-group">
            <input type="text" class="code-input" [(ngModel)]="verificationCode" placeholder="ABCDEF" maxlength="6" (keyup.enter)="doVerify()" />
          </div>

          <button class="primary-btn" (click)="doVerify()" [disabled]="authService.loading() || verificationCode().length < 6">
            Ativar Conta
          </button>

          <p class="link-text" style="margin-top: 16px;">
            <a href="javascript:void(0)" (click)="view.set('login')">Ir para Login</a>
          </p>
        }

        <!-- Loading Bar -->
        @if (authService.loading() || isLoading()) {
          <div class="loading-bar">
            <div class="loading-bar-inner"></div>
          </div>
        }

        <!-- Footer -->
        <p class="footer-text">
          <span class="material-symbols-outlined shield-icon">shield</span>
          Zero-Knowledge · E2EE · Os seus dados, apenas seus.
        </p>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 100vh;
      }

      .login-page {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(160deg, #eef2ff 0%, #fafbff 40%, #f5f3ff 100%);
        padding: 24px;
      }

      .login-card {
        background: white;
        border-radius: 24px;
        padding: 48px 40px;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.04);
        max-width: 420px;
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        opacity: 0;
        transform: translateY(24px);
        transition: opacity 600ms cubic-bezier(0.4, 0, 0.2, 1), transform 600ms cubic-bezier(0.4, 0, 0.2, 1);
      }

      .login-card.slide-up {
        opacity: 1;
        transform: translateY(0);
      }

      .logo {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
      }
      .logo-icon {
        font-size: 52px;
        color: #1a73e8;
        font-variation-settings: 'FILL' 1;
      }
      .logo h1 {
        font-size: 28px;
        font-weight: 600;
        color: #202124;
        margin: 0;
        letter-spacing: -0.5px;
        font-family: 'Outfit', sans-serif;
      }

      .subtitle {
        font-size: 14px;
        color: #5f6368;
        text-align: center;
        line-height: 1.5;
        margin: 0;
      }

      .form-title {
        font-size: 20px;
        font-weight: 500;
        color: #202124;
        margin: 8px 0;
        font-family: 'Outfit', sans-serif;
      }

      .divider {
        width: 100%;
        height: 1px;
        background: #e0e0e0;
        margin: 12px 0;
      }

      .signin-text {
        font-size: 15px;
        color: #202124;
        font-weight: 400;
        margin: 0 0 12px;
      }

      /* Buttons */
      .google-signin-btn, .email-signin-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        width: 100%;
        max-width: 320px;
        height: 48px;
        padding: 0 24px;
        background: white;
        border: 1px solid #dadce0;
        border-radius: 12px;
        font-size: 15px;
        font-weight: 500;
        font-family: 'Outfit', sans-serif;
        color: #3c4043;
        cursor: pointer;
        transition: all 200ms ease;
      }

      .google-signin-btn:hover:not(:disabled), .email-signin-btn:hover:not(:disabled) {
        background: #F8FAFD;
        box-shadow: 0 1px 3px rgba(60, 64, 67, 0.1);
        border-color: #c6c9cd;
        transform: translateY(-1px);
      }

      .primary-btn {
        width: 100%;
        max-width: 320px;
        height: 48px;
        border: none;
        border-radius: 12px;
        background: linear-gradient(135deg, #1a73e8, #4285f4);
        color: white;
        font-size: 16px;
        font-weight: 500;
        font-family: 'Outfit', sans-serif;
        cursor: pointer;
        transition: all 200ms ease;
        margin-top: 8px;
      }

      .primary-btn:hover:not(:disabled) {
        box-shadow: 0 4px 12px rgba(26, 115, 232, 0.3);
        transform: translateY(-1px);
      }

      .primary-btn:disabled, .google-signin-btn:disabled, .email-signin-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
        transform: none;
      }

      /* Inputs */
      .input-group {
        display: flex;
        align-items: center;
        width: 100%;
        max-width: 320px;
        background: #f1f3f4;
        border-radius: 12px;
        padding: 0 16px;
        margin-bottom: 12px;
        border: 2px solid transparent;
        transition: border-color 200ms ease, background 200ms ease;
      }

      .input-group:focus-within {
        background: white;
        border-color: #1a73e8;
      }

      .input-icon {
        color: #5f6368;
        font-size: 20px;
        margin-right: 12px;
      }

      .input-group input {
        flex: 1;
        height: 48px;
        border: none;
        background: transparent;
        outline: none;
        font-size: 15px;
        font-family: 'Outfit', sans-serif;
        color: #202124;
      }

      .code-input-group {
        justify-content: center;
        padding: 0;
      }
      .code-input {
        text-align: center;
        letter-spacing: 4px;
        font-size: 24px !important;
        text-transform: uppercase;
        font-weight: 600;
      }

      /* Avatar Upload */
      .avatar-upload-container {
        display: flex;
        justify-content: center;
        margin-bottom: 24px;
        width: 100%;
      }
      
      .avatar-upload-label {
        width: 120px;
        height: 120px;
        border-radius: 50%;
        background: #f1f3f4;
        border: 2px dashed #bdc1c6;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 200ms ease;
        overflow: hidden;
        color: #5f6368;
      }

      .avatar-upload-label:hover {
        background: #e8f0fe;
        border-color: #1a73e8;
        color: #1a73e8;
      }

      .avatar-upload-label.has-image {
        border-style: solid;
        border-color: #1a73e8;
      }

      .avatar-upload-label img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .avatar-upload-label .icon {
        font-size: 32px;
        margin-bottom: 4px;
      }

      .avatar-upload-label .upload-text {
        font-size: 12px;
        font-weight: 500;
      }

      /* Typography */
      .link-text {
        font-size: 14px;
        color: #5f6368;
        margin: 0;
      }

      .link-text a {
        color: #1a73e8;
        text-decoration: none;
        font-weight: 500;
        transition: color 200ms ease;
      }

      .link-text a:hover {
        color: #1557b0;
        text-decoration: underline;
      }

      /* Error Banner */
      .error-banner {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 16px;
        background: #fce8e6;
        color: #d93025;
        border-radius: 12px;
        font-size: 14px;
        font-weight: 500;
        width: 100%;
        max-width: 320px;
        animation: fadeIn 250ms ease;
        margin-bottom: 12px;
      }

      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
      }

      /* Loading Bar */
      .loading-bar {
        width: 100%;
        height: 3px;
        background: #e8eaed;
        border-radius: 2px;
        overflow: hidden;
        margin-top: 16px;
      }

      .loading-bar-inner {
        width: 30%;
        height: 100%;
        background: #1a73e8;
        border-radius: 2px;
        animation: loadingSlide 1.5s ease-in-out infinite;
      }

      @keyframes loadingSlide {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(400%); }
      }

      /* Footer */
      .footer-text {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: #9aa0a6;
        margin-top: 12px;
      }
      .shield-icon {
        font-size: 16px;
        color: #34a853;
      }
    `
  ]
})
export class LoginComponent implements OnInit {
  protected readonly authService = inject(AuthService);
  private readonly appState = inject(AppStateService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly cardVisible = signal(false);
  
  view = signal<'login' | 'register' | 'avatar' | 'verify'>('login');
  isLoading = signal(false);
  
  username = signal('');
  email = signal('');
  password = signal('');
  verificationCode = signal('');
  selectedAvatar = signal('');
  selectedAvatarFile = signal<File | null>(null);
  
  localError = signal<string | null>(null);

  constructor() {
    if (this.appState.isAuthenticated()) {
      this.router.navigate(['/drive']);
      return;
    }

    afterNextRender(() => {
      requestAnimationFrame(() => this.cardVisible.set(true));
    });
  }

  ngOnInit() {
    this.route.queryParams.subscribe(params => {
      if (params['token']) {
        this.verificationCode.set(params['token']);
        this.view.set('verify');
        this.doVerify();
      }
    });
  }

  signInWithGoogle(): void {
    this.authService.loginWithGoogle();
  }
  
  onAvatarSelected(event: any) {
    const file = event.target.files?.[0];
    if (!file) return;

    // Check size limit? 2MB
    if (file.size > 2 * 1024 * 1024) {
      this.localError.set('A imagem deve ter no máximo 2MB.');
      return;
    }

    this.selectedAvatarFile.set(file);
    const reader = new FileReader();
    reader.onload = (e) => {
      this.selectedAvatar.set(e.target?.result as string);
      this.localError.set(null);
    };
    reader.readAsDataURL(file);
  }

  finishAvatarUpload() {
    this.localError.set(null);
    const file = this.selectedAvatarFile();
    
    if (!file) {
      const isVaultInit = this.appState.status() !== AppStatus.Onboarding;
      this.router.navigate([isVaultInit ? '/drive/home' : '/drive/setup']);
      return;
    }
    
    this.isLoading.set(true);
    this.authService.uploadProfilePic(file).subscribe({
      next: () => {
        this.isLoading.set(false);
        const isVaultInit = this.appState.status() !== AppStatus.Onboarding;
        this.router.navigate([isVaultInit ? '/drive/home' : '/drive/setup']);
      },
      error: (err) => {
        this.isLoading.set(false);
        this.localError.set(err.error?.error || 'Erro ao enviar foto.');
      }
    });
  }

  doRegister() {
    this.localError.set(null);
    this.isLoading.set(true);
    this.authService.register(this.username(), this.email(), this.password()).subscribe({
      next: () => {
        this.isLoading.set(false);
        this.view.set('verify');
      },
      error: (err) => {
        this.isLoading.set(false);
        this.localError.set(err.error?.error || 'Erro ao registrar.');
        this.view.set('register');
      }
    });
  }

  doVerify() {
    this.localError.set(null);
    if (!this.verificationCode()) return;
    this.isLoading.set(true);
    this.authService.verifyEmail(this.verificationCode()).subscribe({
      next: () => {
        if (this.username() && this.password()) {
          this.authService.loginWithCredentials(this.username(), this.password()).subscribe({
            next: () => {
              this.isLoading.set(false);
              this.view.set('avatar');
            },
            error: () => {
              this.isLoading.set(false);
              this.view.set('login');
            }
          });
        } else {
          this.isLoading.set(false);
          this.view.set('login');
          this.localError.set('Conta ativada com sucesso! Por favor, faça login.');
        }
      },
      error: (err) => {
        this.isLoading.set(false);
        this.localError.set(err.error?.error || 'Código inválido ou expirado.');
      }
    });
  }

  doLogin() {
    this.localError.set(null);
    if (!this.username() || !this.password()) return;
    
    this.isLoading.set(true);
    this.authService.loginWithCredentials(this.username(), this.password()).subscribe({
      next: () => {
        this.isLoading.set(false);
        const isVaultInit = this.appState.status() !== AppStatus.Onboarding;
        this.router.navigate([isVaultInit ? '/drive/home' : '/drive/setup']);
      },
      error: (err) => {
        this.isLoading.set(false);
        if (err.status === 403) {
          this.localError.set('Conta não verificada. Insira o código enviado pro e-mail.');
          this.view.set('verify');
        } else {
          this.localError.set(err.error?.error || 'Credenciais inválidas.');
        }
      }
    });
  }
}
