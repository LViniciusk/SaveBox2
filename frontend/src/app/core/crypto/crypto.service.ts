import { Injectable, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';

import { KasumiCryptoService } from './kasumi-crypto.service';

/**
 * Cryptographic service using Kasumi Crypto (libsodium XChaCha20-Poly1305 and Argon2id).
 *
 * SECURITY — GOLDEN RULE:
 * The Vault Key and the passphrase used to derive it NEVER leave this service.
 * They are held exclusively in private variables (RAM) and are NEVER persisted
 * to localStorage, sessionStorage, cookies, or any other storage mechanism.
 */
@Injectable({ providedIn: 'root' })
export class CryptoService {
  /**
   * The decrypted 32-byte Vault Key (Argon2id).
   * Lives strictly in RAM. Wiped on lock/logout.
   */
  private vaultKey: Uint8Array | null = null;

  private readonly http = inject(HttpClient);
  private readonly kasumi = inject(KasumiCryptoService);

  /** Reactive signal for vault lock state. */
  private readonly _isUnlocked = signal(false);
  readonly isVaultUnlocked = this._isUnlocked.asReadonly();

  /**
   * Derives a 32-byte Vault Key from a passphrase via Argon2id (libsodium).
   *
   * The passphrase is consumed transiently and never stored.
   * In production, the salt should come from the backend (per-user).
   *
   * @param passphrase — The user's security phrase (plain text).
   */
  async deriveVaultKey(passphrase: string): Promise<void> {
    const salt = 'savebox-e2ee-salt-v1';
    this.vaultKey = await this.kasumi.deriveVaultKey(passphrase, salt);
    this._isUnlocked.set(true);
  }

  /**
   * Initializes a new vault (Onboarding).
   * Mocks saving the vault key hash to the backend.
   */
  async initializeVault(passphrase: string): Promise<void> {
    await this.deriveVaultKey(passphrase);
    
    // API Call para inicializar o drive no backend
    await lastValueFrom(this.http.post(`${environment.apiUrl}/api/vault/init`, {}, { withCredentials: true }));
  }

  /**
   * Locks the vault by wiping the CryptoKey reference from RAM.
   */
  lockVault(): void {
    this.vaultKey = null;
    this._isUnlocked.set(false);
  }

  /**
   * Returns the active Vault Key for encrypt/decrypt operations.
   * Returns null if the vault is locked.
   */
  getVaultKey(): Uint8Array | null {
    return this.vaultKey;
  }
  /**
  /**
   * Decrypts a Kasumi XChaCha20-Poly1305 encrypted base64 string.
   */
  async decryptName(base64Ciphertext: string): Promise<string> {
    if (!this.vaultKey) {
      return '[Trancado] ' + base64Ciphertext;
    }
    return this.kasumi.decryptName(base64Ciphertext, this.vaultKey);
  }

  /**
   * Encrypts a plaintext name into a Kasumi XChaCha20-Poly1305 base64 string.
   */
  async encryptName(plaintext: string): Promise<string> {
    if (!this.vaultKey) throw new Error('Vault is locked');
    return this.kasumi.encryptName(plaintext, this.vaultKey);
  }

  /**
   * Hashes a plaintext name into a Blake2b base64 string.
   */
  async hashName(plaintext: string): Promise<string> {
    return this.kasumi.hashName(plaintext);
  }
}
