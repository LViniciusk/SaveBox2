import { Injectable, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { KasumiCryptoService } from './kasumi-crypto.service';
import { AppStateService } from '../state/app-state.service';

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

    const candidateMasterKey = await this.kasumi.deriveVaultKey(passphrase, salt);

    let vaultVerification: string | null = null;
    try {
      const res: any = await lastValueFrom(
        this.http.get(`${environment.apiUrl}/api/vault/verification`, { withCredentials: true })
      );
      vaultVerification = res?.vault_verification ?? null;
    } catch (e: any) {
      throw e;
    }

    if (!vaultVerification) {
      throw new Error('Drive nao inicializado');
    }

    let decrypted: string;
    try {
      // MAC Check: XChaCha20-Poly1305 verification fails and throws on wrong master key
      decrypted = await this.kasumi.decryptName(vaultVerification, candidateMasterKey);
    } catch {
      throw new Error('WRONG_PASSPHRASE');
    }

    // Two-layer architecture: decrypted value is the base64-encoded Vault Key
    try {
      const binaryString = atob(decrypted);
      const key = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        key[i] = binaryString.charCodeAt(i);
      }
      this.vaultKey = key;
    } catch {
      throw new Error('WRONG_PASSPHRASE');
    }

    this._isUnlocked.set(true);
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

    const masterKey = await this.kasumi.deriveVaultKey(passphrase, salt);

    // Generate a random 32-byte Vault Key
    const newVaultKey = window.crypto.getRandomValues(new Uint8Array(32));
    this.vaultKey = newVaultKey;

    // Encrypt the random Vault Key using the transient Master Key
    const vaultKeyBase64 = btoa(String.fromCharCode(...newVaultKey));
    const vaultVerification = await this.kasumi.encryptName(vaultKeyBase64, masterKey);

    // Store encrypted vault verification token on the backend
    await lastValueFrom(this.http.post(
      `${environment.apiUrl}/api/vault/init`,
      { vault_verification: vaultVerification },
      { withCredentials: true }
    ));

    this._isUnlocked.set(true);
  }

  /**
   * Changes the user's security phrase.
   * Derives the old Master Key to verify the phrase, decrypts the Vault Key,
   * derives the new Master Key, re-encrypts the Vault Key, updates the backend,
   * and forces the download of a recovery kit text file.
   *
   * @param oldPhrase - The user's current security phrase.
   * @param newPhrase - The user's new security phrase.
   */
  async changeSecurityPhrase(oldPhrase: string, newPhrase: string): Promise<void> {
    if (!this.vaultKey) throw new Error('Drive trancado');

    // SECURITY: Normalize email to lowercase and trim whitespace to ensure deterministic salt derivation
    const email = this.appState.user()?.email;
    if (!email) throw new Error('Email do utilizador nao encontrado no estado.');
    const salt = email.trim().toLowerCase();

    const oldMasterKey = await this.kasumi.deriveVaultKey(oldPhrase, salt);

    let vaultVerification: string;
    try {
      const res: any = await lastValueFrom(
        this.http.get(`${environment.apiUrl}/api/vault/verification`, { withCredentials: true })
      );
      vaultVerification = res?.vault_verification;
    } catch {
      throw new Error('Erro ao buscar verificacao do drive');
    }

    if (!vaultVerification) throw new Error('Drive nao inicializado');

    // Verify current security phrase using MAC authentication checks
    try {
      await this.kasumi.decryptName(vaultVerification, oldMasterKey);
    } catch {
      throw new Error('WRONG_PASSPHRASE');
    }

    const newMasterKey = await this.kasumi.deriveVaultKey(newPhrase, salt);
    const vaultKeyBase64 = btoa(String.fromCharCode(...this.vaultKey));
    const newVaultVerification = await this.kasumi.encryptName(vaultKeyBase64, newMasterKey);

    // Update backend verification token
    await lastValueFrom(this.http.post(
      `${environment.apiUrl}/api/vault/init`,
      { vault_verification: newVaultVerification },
      { withCredentials: true }
    ));

    // Force automatic download of recovery kit file
    const recoveryText = `=== NANIKA RECOVERY KEY ===\r\n` +
      `Guarde esta chave em um local seguro. Ela pode ser usada para recuperar seus arquivos.\r\n\r\n` +
      `Chave do Drive (Vault Key - Base64): ${vaultKeyBase64}\r\n` +
      `Chave do Drive (Vault Key - Hex): ${Array.from(this.vaultKey).map(b => b.toString(16).padStart(2, '0')).join('')}\r\n` +
      `============================`;

    const blob = new Blob([recoveryText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nanika-recovery.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Locks the vault by wiping the decrypted Vault Key reference from RAM.
   */
  lockVault(): void {
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
