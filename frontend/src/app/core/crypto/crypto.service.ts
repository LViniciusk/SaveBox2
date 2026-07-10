import { Injectable, signal } from '@angular/core';

/**
 * Cryptographic service using the Web Crypto API (window.crypto.subtle).
 *
 * SECURITY — GOLDEN RULE:
 * The Vault Key and the passphrase used to derive it NEVER leave this service.
 * They are held exclusively in private variables (RAM) and are NEVER persisted
 * to localStorage, sessionStorage, cookies, or any other storage mechanism.
 */
@Injectable({ providedIn: 'root' })
export class CryptoService {
  /**
   * The decrypted AES-GCM 256-bit Vault Key.
   * Lives strictly in RAM. Wiped on lock/logout.
   */
  private vaultKey: CryptoKey | null = null;

  /** Reactive signal for vault lock state. */
  private readonly _isUnlocked = signal(false);
  readonly isVaultUnlocked = this._isUnlocked.asReadonly();

  /**
   * Derives an AES-GCM 256-bit Vault Key from a passphrase via PBKDF2.
   *
   * The passphrase is consumed transiently and never stored.
   * In production, the salt should come from the backend (per-user).
   *
   * @param passphrase — The user's security phrase (plain text).
   */
  async deriveVaultKey(passphrase: string): Promise<void> {
    const encoder = new TextEncoder();

    // Step 1: Import the passphrase as raw key material for PBKDF2.
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    );

    // Step 2: Define salt. In production, this is a per-user value from the backend.
    const salt = encoder.encode('savebox-e2ee-salt-v1');

    // Step 3: Derive a non-extractable AES-GCM 256-bit key.
    this.vaultKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 600_000,
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false, // Non-extractable — cannot be exported from CryptoKey
      ['encrypt', 'decrypt'],
    );

    this._isUnlocked.set(true);
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
  getVaultKey(): CryptoKey | null {
    return this.vaultKey;
  }
}
