import { Injectable, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';

import { KasumiCryptoService } from './kasumi-crypto.service';

/** Fixed plaintext we encrypt to create a verifiable "known-plaintext" token. */
const VAULT_CANARY = 'savebox-vault-canary-v1';

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
   * Unlocks the vault by deriving the key from the passphrase and verifying
   * it against the stored verification token from the backend.
   * Throws if passphrase is incorrect.
   *
   * @param passphrase — The user's security phrase (plain text).
   */
  async unlockVault(passphrase: string): Promise<void> {
    // Step 1: Derive candidate key
    const salt = 'savebox-e2ee-salt-v1';
    const candidateKey = await this.kasumi.deriveVaultKey(passphrase, salt);

    // Step 2: Fetch stored verification ciphertext from backend
    let vaultVerification: string | null = null;
    try {
      const res: any = await lastValueFrom(
        this.http.get(`${environment.apiUrl}/api/vault/verification`, { withCredentials: true })
      );
      vaultVerification = res?.vault_verification ?? null;
    } catch (e: any) {
      // If no verification token exists yet (404), accept any passphrase (legacy vault)
      // and silently store a verification token for future use
      if (e?.status === 404) {
        this.vaultKey = candidateKey;
        this._isUnlocked.set(true);
        await this._storeVerificationToken(candidateKey);
        return;
      }
      throw e;
    }

    if (!vaultVerification) {
      // No token stored; accept and migrate
      this.vaultKey = candidateKey;
      this._isUnlocked.set(true);
      await this._storeVerificationToken(candidateKey);
      return;
    }

    // Step 3: Attempt to decrypt the canary. If wrong key → decryptName throws/returns error marker
    let decrypted: string;
    try {
      decrypted = await this.kasumi.decryptName(vaultVerification, candidateKey);
    } catch {
      throw new Error('WRONG_PASSPHRASE');
    }

    if (decrypted !== VAULT_CANARY) {
      throw new Error('WRONG_PASSPHRASE');
    }

    // Step 4: Key is correct, store it
    this.vaultKey = candidateKey;
    this._isUnlocked.set(true);
  }

  /**
   * Initializes a new vault (Onboarding).
   * Encrypts a canary plaintext with the derived key and stores it on the backend.
   */
  async initializeVault(passphrase: string): Promise<void> {
    await this.deriveVaultKey(passphrase);

    // Create vault verification token: encrypt the known canary with our vault key
    const vaultVerification = await this.kasumi.encryptName(VAULT_CANARY, this.vaultKey!);

    // API Call para inicializar o drive no backend, sending verification token
    await lastValueFrom(this.http.post(
      `${environment.apiUrl}/api/vault/init`,
      { vault_verification: vaultVerification },
      { withCredentials: true }
    ));
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
   * Decrypts a Kasumi XChaCha20-Poly1305 encrypted base64 string.
   * Returns a placeholder string on error (for file name display).
   */
  async decryptName(base64Ciphertext: string): Promise<string> {
    if (!this.vaultKey) {
      return base64Ciphertext;
    }
    try {
      return await this.kasumi.decryptName(base64Ciphertext, this.vaultKey);
    } catch {
      return '[Erro] Nome ilegível';
    }
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

  /**
   * Silently stores a vault verification token for legacy vaults.
   * Fires-and-forgets; errors are non-fatal.
   */
  private async _storeVerificationToken(key: Uint8Array): Promise<void> {
    try {
      const vaultVerification = await this.kasumi.encryptName(VAULT_CANARY, key);
      await lastValueFrom(this.http.post(
        `${environment.apiUrl}/api/vault/init`,
        { vault_verification: vaultVerification },
        { withCredentials: true }
      ));
    } catch {
      // Non-fatal: will be retried next unlock
    }
  }
}
