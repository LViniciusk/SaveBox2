import { Injectable, signal, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { KasumiCryptoService } from './kasumi-crypto.service';
import { AppStateService } from '../state/app-state.service';

export type SecurityPhraseErrorCode =
  | 'VAULT_LOCKED'
  | 'USER_CONTEXT_MISSING'
  | 'VAULT_NOT_INITIALIZED'
  | 'CURRENT_PHRASE_INCORRECT'
  | 'SESSION_EXPIRED'
  | 'NETWORK_UNAVAILABLE'
  | 'SERVER_UNAVAILABLE'
  | 'CRYPTO_OPERATION_FAILED'
  | 'VAULT_UPDATE_FAILED';

export class SecurityPhraseChangeError extends Error {
  constructor(readonly code: SecurityPhraseErrorCode) {
    super(code);
  }
}

const VAULT_KEY_SIZE_BYTES = 32;
type VaultVerificationResponse = { vault_verification?: unknown } | null;

/**
 * Cryptographic service utilizing a two-layer key architecture (Nanika).
 *
 * KEY ARCHITECTURE:
 * Passphrase -> Master Key (Argon2id, derived using normalized email as salt)
 * Master Key -> Encrypted Vault Key (Stored on Backend)
 * Vault Key (32-byte random key, private variable in RAM) -> File Data Keys (FDKs)
 *
 * SECURITY RULE:
 * The Master Key only exists as local variables in memory during the execution
 * of onboarding, unlock, and security phrase change. It is never saved on the class instance.
 * Only the decrypted Vault Key is held in RAM (this.vaultKey) while the vault is unlocked.
 */
@Injectable({ providedIn: 'root' })
export class CryptoService {
  /**
   * The decrypted 32-byte Vault Key.
   * Lives strictly in RAM. Wiped on lock/logout.
   */
  private vaultKey: Uint8Array | null = null;
  private unlockGeneration = 0;

  private readonly http = inject(HttpClient);
  private readonly kasumi = inject(KasumiCryptoService);
  private readonly appState = inject(AppStateService);

  /** Reactive signal for vault lock state. */
  private readonly _isUnlocked = signal(false);
  readonly isVaultUnlocked = this._isUnlocked.asReadonly();

  /**
   * Unlocks the vault by deriving the Master Key from the passphrase,
   * decrypting the Vault Key from the backend, and verifying the MAC.
   *
   * @param passphrase - The user's security phrase (plain text).
   */
  async unlockVault(passphrase: string): Promise<void> {
    // SECURITY: Normalize email to lowercase and trim whitespace to ensure deterministic salt derivation
    const email = this.appState.user()?.email;
    if (!email) throw new Error('Email do utilizador nao encontrado no estado.');
    const salt = email.trim().toLowerCase();
    const generation = ++this.unlockGeneration;

    let candidateMasterKey: Uint8Array | null = null;
    let candidateVaultKey: Uint8Array | null = null;
    try {
      candidateMasterKey = await this.kasumi.deriveVaultKey(passphrase, salt);
      this.assertCurrentUnlock(generation);
      const res = await lastValueFrom(
        this.http.get<VaultVerificationResponse>(`${environment.apiUrl}/api/vault/verification`, { withCredentials: true })
      );
      this.assertCurrentUnlock(generation);
      const vaultVerification = res?.vault_verification;
      if (typeof vaultVerification !== 'string' || !vaultVerification) {
        throw new Error('Drive nao inicializado');
      }

      let decrypted: string;
      try {
        // MAC Check: XChaCha20-Poly1305 verification fails and throws on wrong master key
        decrypted = await this.kasumi.decryptName(vaultVerification, candidateMasterKey);
      } catch {
        throw new Error('WRONG_PASSPHRASE');
      }
      candidateMasterKey.fill(0);
      candidateMasterKey = null;
      this.assertCurrentUnlock(generation);

      // Two-layer architecture: decrypted value is the base64-encoded Vault Key
      candidateVaultKey = this.decodeVaultKey(decrypted);
      this.assertCurrentUnlock(generation);

      const previousVaultKey = this.vaultKey;
      this.vaultKey = candidateVaultKey;
      candidateVaultKey = null;
      previousVaultKey?.fill(0);
      this._isUnlocked.set(true);
    } finally {
      candidateMasterKey?.fill(0);
      candidateVaultKey?.fill(0);
    }
  }

  private assertCurrentUnlock(generation: number): void {
    if (generation !== this.unlockGeneration) throw new Error('UNLOCK_CANCELLED');
  }

  private decodeVaultKey(encodedKey: string): Uint8Array {
    try {
      const binaryString = atob(encodedKey);
      if (binaryString.length !== VAULT_KEY_SIZE_BYTES) throw new Error('invalid vault key length');
      const key = new Uint8Array(VAULT_KEY_SIZE_BYTES);
      for (let i = 0; i < binaryString.length; i++) {
        key[i] = binaryString.charCodeAt(i);
      }
      return key;
    } catch {
      throw new Error('WRONG_PASSPHRASE');
    }
  }

  /**
   * Initializes a new vault (Onboarding).
   * Generates a random Vault Key, encrypts it with the derived Master Key,
   * and stores it on the backend.
   *
   * @param passphrase - The user's security phrase (plain text).
   */
  async initializeVault(passphrase: string): Promise<void> {
    // SECURITY: Normalize email to lowercase and trim whitespace to ensure deterministic salt derivation
    const email = this.appState.user()?.email;
    if (!email) throw new Error('Email do utilizador nao encontrado no estado.');
    const salt = email.trim().toLowerCase();

    // Generate a random 32-byte Vault Key
    const newVaultKey = window.crypto.getRandomValues(new Uint8Array(32));
    let masterKey: Uint8Array | null = null;
    try {
      masterKey = await this.kasumi.deriveVaultKey(passphrase, salt);

      // Encrypt the random Vault Key using the transient Master Key
      const vaultKeyBase64 = btoa(String.fromCharCode(...newVaultKey));
      const vaultVerification = await this.kasumi.encryptName(vaultKeyBase64, masterKey);

      // Store encrypted vault verification token on the backend
      await lastValueFrom(this.http.post(
        `${environment.apiUrl}/api/vault/init`,
        { vault_verification: vaultVerification },
        { withCredentials: true }
      ));

      this.vaultKey = newVaultKey;
      this._isUnlocked.set(true);
    } catch (error) {
      newVaultKey.fill(0);
      throw error;
    } finally {
      if (masterKey) masterKey.fill(0);
    }
  }

  /** Changes only the wrapping of the existing Vault Key. */
  async changeSecurityPhrase(oldPhrase: string, newPhrase: string): Promise<void> {
    if (!this.vaultKey) throw new SecurityPhraseChangeError('VAULT_LOCKED');

    const email = this.appState.user()?.email;
    if (!email) throw new SecurityPhraseChangeError('USER_CONTEXT_MISSING');
    const salt = email.trim().toLowerCase();
    await this.verifyCurrentSecurityPhrase(oldPhrase, salt);
    const newVaultVerification = await this.buildVaultVerification(newPhrase, salt);

    try {
      await lastValueFrom(this.http.post(
        `${environment.apiUrl}/api/vault/init`,
        { vault_verification: newVaultVerification },
        { withCredentials: true }
      ));
    } catch (error) {
      if (error instanceof HttpErrorResponse) throw this.classifyPhraseHttpError(error, true);
      throw new SecurityPhraseChangeError('CRYPTO_OPERATION_FAILED');
    }
  }

  private async verifyCurrentSecurityPhrase(phrase: string, salt: string): Promise<void> {
    let masterKey: Uint8Array | null = null;
    try {
      try {
        masterKey = await this.kasumi.deriveVaultKey(phrase, salt);
      } catch {
        throw new SecurityPhraseChangeError('CRYPTO_OPERATION_FAILED');
      }

      let response: { vault_verification?: unknown } | null;
      try {
        response = await lastValueFrom(this.http.get<{ vault_verification?: unknown } | null>(
          `${environment.apiUrl}/api/vault/verification`, { withCredentials: true }));
      } catch (error) {
        throw this.classifyPhraseHttpError(error);
      }

      const vaultVerification = response?.vault_verification;
      if (typeof vaultVerification !== 'string' || !vaultVerification) {
        throw new SecurityPhraseChangeError('VAULT_NOT_INITIALIZED');
      }

      try {
        await this.kasumi.decryptName(vaultVerification, masterKey);
      } catch {
        throw new SecurityPhraseChangeError('CURRENT_PHRASE_INCORRECT');
      }
    } finally {
      if (masterKey && masterKey !== this.vaultKey) masterKey.fill(0);
    }
  }

  private async buildVaultVerification(phrase: string, salt: string): Promise<string> {
    let masterKey: Uint8Array | null = null;
    try {
      masterKey = await this.kasumi.deriveVaultKey(phrase, salt);
      const vaultKeyBase64 = btoa(String.fromCharCode(...this.vaultKey!));
      return await this.kasumi.encryptName(vaultKeyBase64, masterKey);
    } catch {
      throw new SecurityPhraseChangeError('CRYPTO_OPERATION_FAILED');
    } finally {
      if (masterKey && masterKey !== this.vaultKey) masterKey.fill(0);
    }
  }

  private classifyPhraseHttpError(error: unknown, update = false): SecurityPhraseChangeError {
    const status = error instanceof HttpErrorResponse ? error.status : 0;
    if (status === 401) return new SecurityPhraseChangeError('SESSION_EXPIRED');
    if (status === 0) return new SecurityPhraseChangeError('NETWORK_UNAVAILABLE');
    if (status >= 500) return new SecurityPhraseChangeError('SERVER_UNAVAILABLE');
    if (!update && status === 404) return new SecurityPhraseChangeError('VAULT_NOT_INITIALIZED');
    return new SecurityPhraseChangeError('VAULT_UPDATE_FAILED');
  }

  /**
   * Locks the vault by wiping the decrypted Vault Key reference from RAM.
   */
  lockVault(): void {
    this.unlockGeneration++;
    this.vaultKey?.fill(0);
    this.vaultKey = null;
    this._isUnlocked.set(false);
  }

  /**
   * Returns the active Vault Key for encrypt/decrypt operations.
   */
  getVaultKey(): Uint8Array | null {
    return this.vaultKey;
  }

  /**
   * Decrypts a base64 ciphertext using the active Vault Key.
   */
  async decryptName(base64Ciphertext: string): Promise<string> {
    if (!this.vaultKey) {
      return base64Ciphertext;
    }
    try {
      return await this.kasumi.decryptName(base64Ciphertext, this.vaultKey);
    } catch {
      return '[Erro] Nome ilegivel';
    }
  }

  /**
   * Encrypts a plaintext name using the active Vault Key.
   */
  async encryptName(plaintext: string): Promise<string> {
    if (!this.vaultKey) throw new Error('Drive trancado');
    return this.kasumi.encryptName(plaintext, this.vaultKey);
  }

  /**
   * Hashes a plaintext name using Blake2b.
   */
  async hashName(plaintext: string): Promise<string> {
    return this.kasumi.hashName(plaintext);
  }
}
