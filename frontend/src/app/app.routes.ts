import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';
import { vaultGuard } from './core/crypto/vault.guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'login',
    pathMatch: 'full',
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./features/auth/pages/login/login.component').then(
        (m) => m.LoginComponent,
      ),
  },
  {
    path: 'verify',
    loadComponent: () =>
      import('./features/auth/pages/login/login.component').then(
        (m) => m.LoginComponent,
      ),
  },
  {
    path: 'auth/callback',
    loadComponent: () =>
      import('./features/auth/pages/callback/auth-callback.component').then(
        (m) => m.AuthCallbackComponent,
      ),
  },
  {
    path: 'share/:id',
    loadComponent: () =>
      import('./features/share/shared-file.component').then(
        (m) => m.SharedFileComponent
      ),
  },
  {
    path: 'drive',
    canActivate: [authGuard],
    children: [
      {
        path: '',
        redirectTo: 'home',
        pathMatch: 'full',
      },
      {
        path: 'home',
        loadComponent: () =>
          import('./features/drive/pages/home/vault-home.component').then(
            (m) => m.VaultHomeComponent,
          ),
        canActivate: [vaultGuard],
      },
      {
        path: 'setup',
        loadComponent: () =>
          import('./features/drive/pages/setup/setup.component').then(
            (m) => m.SetupComponent,
          ),
      },
    ],
  },
  {
    path: '**',
    redirectTo: 'login',
  },
];
