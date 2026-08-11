import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { SharedFileComponent } from './shared-file.component';
import { ShareService } from '../drive/services/share.service';
import { KasumiCryptoService } from '../../core/crypto/kasumi-crypto.service';
import { ActivatedRoute } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';

function fdkBytes(fill = 0x5a): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function withLocationHash(hash: string, callback: () => void): void {
  const previousHash = window.location.hash;
  window.location.hash = hash ? `#${hash}` : '';
  try {
    callback();
  } finally {
    window.location.hash = previousHash;
  }
}

describe('SharedFileComponent', () => {
  let fixture: any;
  let component: SharedFileComponent;
  let shareSpy: jasmine.SpyObj<ShareService>;
  let kasumiSpy: jasmine.SpyObj<KasumiCryptoService>;

  beforeEach(async () => {
    shareSpy = jasmine.createSpyObj('ShareService', ['getSharedFileMetadata', 'downloadSharedFile', 'downloadSharedFileInRanges']);
    kasumiSpy = jasmine.createSpyObj('KasumiCryptoService', ['decryptName', 'decryptFile']);
    const mockRoute = {
      snapshot: { paramMap: { get: () => 'share-123' } }
    };

    await TestBed.configureTestingModule({
      imports: [SharedFileComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ShareService, useValue: shareSpy },
        { provide: KasumiCryptoService, useValue: kasumiSpy },
        { provide: ActivatedRoute, useValue: mockRoute }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(SharedFileComponent);
    component = fixture.componentInstance;
  });

  describe('share fragment validation', () => {
    it('rejects missing, malformed, noncanonical and wrong-size fragments without loading metadata', () => {
      const loadMetadata = spyOn(component, 'loadMetadata').and.resolveTo();
      const invalidFragments = [
        '',
        '-g',
        'P_8',
        'A'.repeat(42),
        `${'A'.repeat(42)}B`,
        `${'A'.repeat(42)}=`,
        `${'A'.repeat(42)}+`,
        `${'A'.repeat(42)}/`,
        `${'A'.repeat(42)} `,
        `${'A'.repeat(42)}%`,
      ];

      for (const fragment of invalidFragments) {
        component.fdkUint8 = null;
        withLocationHash(fragment, () => component.ngOnInit());
        expect(component.fdkUint8).toBeNull();
      }

      expect(loadMetadata).not.toHaveBeenCalled();
      expect(shareSpy.getSharedFileMetadata).not.toHaveBeenCalled();
      expect(component.securityError()).toContain('Link invalido');
    });

    it('accepts exactly one canonical 32-byte FDK from the fragment', () => {
      const root = fdkBytes(0xa0);
      const loadMetadata = spyOn(component, 'loadMetadata').and.resolveTo();

      withLocationHash(encodeBase64Url(root), () => component.ngOnInit());

      expect(component.fdkUint8).toEqual(root);
      expect(component.fdkUint8).not.toBe(root);
      expect(loadMetadata).toHaveBeenCalledTimes(1);
    });

    it('accepts every canonical final sextet for a 32-byte FDK', () => {
      const expectedEndings = 'AEIMQUYcgkosw048';

      for (let nibble = 0; nibble < 16; nibble++) {
        const root = new Uint8Array(32).fill(0xa0);
        root[31] = 0xa0 | nibble;
        const fragment = encodeBase64Url(root);

        expect(fragment.length).toBe(43);
        expect(fragment.at(-1)).toBe(expectedEndings[nibble]);

        const decoded = (component as any).decodeShareFdk(fragment);

        expect(decoded).not.toBe(root);
        expect(Array.from(decoded)).toEqual(Array.from(root));
      }
    });

    it('accepts a valid public-share FDK ending in o through ngOnInit', () => {
      const root = fdkBytes();
      const fragment = encodeBase64Url(root);
      const loadMetadata = spyOn(component, 'loadMetadata').and.resolveTo();

      expect(fragment.at(-1)).toBe('o');

      withLocationHash(fragment, () => component.ngOnInit());

      expect(component.securityError()).toBeNull();
      expect(component.fdkUint8).toEqual(root);
      expect(component.fdkUint8).not.toBe(root);
      expect(loadMetadata).toHaveBeenCalledTimes(1);
    });

    it('rejects every noncanonical final Base64URL sextet', () => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const canonical = new Set('AEIMQUYcgkosw048');

      for (const finalChar of alphabet) {
        if (canonical.has(finalChar)) continue;

        expect(() =>
          (component as any).decodeShareFdk(`${'A'.repeat(42)}${finalChar}`)
        ).toThrow();
      }
    });

    it('accepts URL-safe substitutions in valid encoded FDKs', () => {
      for (const fill of [0xfb, 0xff]) {
        const root = fdkBytes(fill);
        const fragment = encodeBase64Url(root);
        const decoded = (component as any).decodeShareFdk(fragment);

        expect(fragment).toMatch(/[-_]/);
        expect(Array.from(decoded)).toEqual(Array.from(root));
      }
    });
  });

  it('loads and decrypts shared metadata with the supplied FDK', async () => {
    const metadata = {
      encrypted_name: 'encrypted-name',
      size_bytes: 2048,
      storage_provider: 'local'
    } as any;
    component.shareId = 'share-123';
    const root = fdkBytes();
    component.fdkUint8 = root;
    shareSpy.getSharedFileMetadata.and.returnValue(of(metadata));
    let operationFdk!: Uint8Array;
    kasumiSpy.decryptName.and.callFake(async (_encryptedName: string, fdk: Uint8Array) => {
      operationFdk = fdk;
      expect(Array.from(fdk)).toEqual(Array.from(root));
      return 'photo.png';
    });

    await component.loadMetadata();

    expect(shareSpy.getSharedFileMetadata).toHaveBeenCalledWith('share-123');
    expect(kasumiSpy.decryptName).toHaveBeenCalledWith(metadata.encrypted_name, jasmine.any(Uint8Array));
    expect(operationFdk).not.toBe(root);
    expect(Array.from(operationFdk)).toEqual(new Array(32).fill(0));
    expect(Array.from(root)).toEqual(new Array(32).fill(0x5a));
    expect(component.metadata()).toBe(metadata);
    expect(component.decryptedName()).toBe('photo.png');
    expect(component.sizeBytes()).toBe(2048);
    expect(component.loading()).toBeFalse();
  });

  it('reports expired or missing shares without exposing decrypted state', async () => {
    component.shareId = 'missing';
    component.fdkUint8 = fdkBytes();
    shareSpy.getSharedFileMetadata.and.returnValue(
      throwError(() => ({ error: { error: 'Link expirado' } }))
    );

    await component.loadMetadata();

    expect(component.error()).toBe('Link expirado');
    expect(component.loading()).toBeFalse();
    expect(component.decryptedName()).toBe('');
  });

  it('rejects metadata loading when the FDK is absent', async () => {
    component.shareId = 'share-123';
    component.fdkUint8 = null;
    shareSpy.getSharedFileMetadata.and.returnValue(of({ encrypted_name: 'name' } as any));

    await component.loadMetadata();

    expect(component.error()).toContain('descriptografar os metadados');
    expect(component.loading()).toBeFalse();
    expect(kasumiSpy.decryptName).not.toHaveBeenCalled();
  });

  it('classifies shared files for the player', () => {
    component.decryptedName.set('photo.PNG');
    expect(component.isImage()).toBeTrue();

    component.decryptedName.set('movie.mp4');
    expect(component.isVideo()).toBeTrue();
  });

  it('wipes the page-owned FDK on destroy and keeps destroy idempotent', () => {
    const root = fdkBytes();
    component.fdkUint8 = root;

    (component as any).ngOnDestroy();
    (component as any).ngOnDestroy();

    expect(component.fdkUint8).toBeNull();
    expect(Array.from(root)).toEqual(new Array(32).fill(0));
  });

  it('unsubscribes pending metadata and does not publish state after destroy', async () => {
    const root = fdkBytes();
    component.fdkUint8 = root;
    let unsubscribed = false;
    shareSpy.getSharedFileMetadata.and.returnValue(new Observable(() => () => { unsubscribed = true; }));

    const pending = component.loadMetadata();
    await Promise.resolve();
    (component as any).ngOnDestroy();
    await pending;

    expect(unsubscribed).toBeTrue();
    expect(component.metadata()).toBeNull();
    expect(component.decryptedName()).toBe('');
  });

  it('wipes the temporary decrypt copy while preserving the page root', async () => {
    const root = fdkBytes();
    component.fdkUint8 = root;
    const metadata = { encrypted_name: 'encrypted-name', size_bytes: 2048, storage_provider: 'local' } as any;
    shareSpy.getSharedFileMetadata.and.returnValue(of(metadata));
    let resolveDecrypt!: (name: string) => void;
    let operationFdk!: Uint8Array;
    kasumiSpy.decryptName.and.callFake((_encryptedName: string, fdk: Uint8Array) => {
      operationFdk = fdk;
      return new Promise<string>(resolve => { resolveDecrypt = resolve; });
    });

    const pending = component.loadMetadata();
    await Promise.resolve();
    await Promise.resolve();
    (component as any).ngOnDestroy();
    expect(Array.from(root)).toEqual(new Array(32).fill(0));
    expect(Array.from(operationFdk)).toEqual(new Array(32).fill(0x5a));

    resolveDecrypt('stale.png');
    await pending;

    expect(Array.from(operationFdk)).toEqual(new Array(32).fill(0));
    expect(component.metadata()).toBeNull();
    expect(component.decryptedName()).toBe('');
    expect(component.sizeBytes()).toBe(0);
  });

  it('wipes a temporary decrypt copy when metadata decryption fails', async () => {
    const root = fdkBytes();
    component.fdkUint8 = root;
    shareSpy.getSharedFileMetadata.and.returnValue(of({ encrypted_name: 'encrypted-name', size_bytes: 10 } as any));
    let operationFdk!: Uint8Array;
    kasumiSpy.decryptName.and.callFake((_encryptedName: string, fdk: Uint8Array) => {
      operationFdk = fdk;
      return Promise.reject(new Error('bad decrypt'));
    });

    await component.loadMetadata();

    expect(Array.from(operationFdk)).toEqual(new Array(32).fill(0));
    expect(Array.from(root)).toEqual(new Array(32).fill(0x5a));
    expect(component.metadata()).toBeNull();
    expect(component.error()).toContain('descriptografar');
  });
});
