import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ShareModalComponent } from './share-modal.component';
import { DriveService } from '../../services/drive.service';
import { CryptoService } from '../../../../core/crypto/crypto.service';
import { KasumiCryptoService } from '../../../../core/crypto/kasumi-crypto.service';
import { of, throwError } from 'rxjs';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ShareModalComponent', () => {
  const validFdkBytes = new Uint8Array(32).fill(0x5a);
  const validFdkBase64 = btoa(String.fromCharCode(...validFdkBytes));
  const validFdkFragment = validFdkBase64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  let fixture: any;
  let component: ShareModalComponent;
  let cryptoSpy: any;
  let driveSpy: any;
  let kasumiSpy: any;

  beforeEach(async () => {
    cryptoSpy = jasmine.createSpyObj('CryptoService', ['decryptName']);
    driveSpy = jasmine.createSpyObj('DriveService', ['listShares', 'createShareLink', 'revokeShare']);
    kasumiSpy = jasmine.createSpyObj('KasumiCryptoService', ['encryptName']);

    driveSpy.listShares.and.returnValue(of([])); // Default to no shares

    await TestBed.configureTestingModule({
      imports: [ShareModalComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: DriveService, useValue: driveSpy },
        { provide: CryptoService, useValue: cryptoSpy },
        { provide: KasumiCryptoService, useValue: kasumiSpy }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ShareModalComponent);
    component = fixture.componentInstance;
  });

  it('renders only the unavailable state and performs no work for Google files', async () => {
    fixture.componentRef.setInput('file', {
      id: 7,
      isFolder: false,
      storageProvider: 'google_drive',
      encryptedFdk: 'encrypted-fdk',
      encryptedName: 'ciphertext',
    } as any);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain('Compartilhamento indisponível');
    expect(fixture.nativeElement.querySelector('.generate-btn')).toBeNull();
    expect(driveSpy.listShares).not.toHaveBeenCalled();

    await component.generateLink();
    await component.buildShareUrl('share-token');
    expect(cryptoSpy.decryptName).not.toHaveBeenCalled();
    expect(kasumiSpy.encryptName).not.toHaveBeenCalled();
    expect(driveSpy.createShareLink).not.toHaveBeenCalled();
    expect(component.generatedLink()).toBeNull();
  });

  describe('buildShareUrl', () => {
    it('should convert standard Base64 FDK into Base64 URL-Safe format without padding', async () => {
      // Arrange
      const standardBase64 = '+vv/+vv/WlpaAAEC+vv/ECAwQFBgcICQoLDA0ODwESI=';
      
      const mockFile = { 
        id: 1, 
        encryptedName: 'enc', 
        decryptedName: 'dec', 
        isFolder: false, 
        encryptedFdk: 'encrypted_fdk_string' 
      } as any;

      fixture.componentRef.setInput('file', mockFile);
      cryptoSpy.decryptName.and.returnValue(Promise.resolve(standardBase64));

      // Act
      await component.buildShareUrl('share-123');

      // Assert
      const generated = component.generatedLink();
      expect(generated).toContain('#-vv_-vv_WlpaAAEC-vv_ECAwQFBgcICQoLDA0ODwESI');
      
      const fragment = new URL(generated as string).hash;
      expect(fragment).not.toContain('+');
      expect(fragment).not.toContain('/');
      expect(fragment).not.toContain('=');
    });

    it('preserves Base64 URL conversion for slash and already-safe input', async () => {
      const values = [
        '+vv/+vv/WlpaAAEC+vv/ECAwQFBgcICQoLDA0ODwESI=',
        validFdkBase64,
      ];
      fixture.componentRef.setInput('file', {
        id: 1,
        encryptedName: 'enc',
        encryptedFdk: 'encrypted_fdk_string',
      } as any);
      cryptoSpy.decryptName.and.callFake(() => Promise.resolve(values.shift()));

      await component.buildShareUrl('share-slash');
      expect(component.generatedLink()).toContain('#-vv_-vv_WlpaAAEC-vv_ECAwQFBgcICQoLDA0ODwESI');
      await component.buildShareUrl('share-safe');
      expect(component.generatedLink()).toContain(`#${validFdkFragment}`);
    });

    it('fails closed when decrypted material is not a canonical FDK', async () => {
      fixture.componentRef.setInput('file', { id: 1, encryptedFdk: 'fdk', encryptedName: 'enc' } as any);
      cryptoSpy.decryptName.and.returnValue(Promise.resolve('[Erro] Nome ilegivel'));

      await component.buildShareUrl('share-invalid');

      expect(component.generatedLink()).toBeNull();
      expect(component.error()).toBeTruthy();
      expect(component.error()).not.toContain('Nome ilegivel');
    });

    it('rejects wrong-sized and malformed FDK material', async () => {
      fixture.componentRef.setInput('file', { id: 1, encryptedFdk: 'fdk', encryptedName: 'enc' } as any);

      for (const invalid of ['not-base64', btoa('fdk')]) {
        cryptoSpy.decryptName.and.returnValue(Promise.resolve(invalid));
        component.generatedLink.set(null);
        component.error.set(null);

        await component.buildShareUrl('share-invalid');

        expect(component.generatedLink()).toBeNull();
        expect(component.error()).toBeTruthy();
      }
    });

    it('should report missing FDK and decryption failures', async () => {
      fixture.componentRef.setInput('file', { id: 1, encryptedName: 'enc' } as any);
      await component.buildShareUrl('share-1');
      expect(component.error()).toContain('ausente');

      fixture.componentRef.setInput('file', { id: 1, encryptedFdk: 'fdk', encryptedName: 'enc' } as any);
      cryptoSpy.decryptName.and.returnValue(Promise.reject(new Error('bad fdk')));
      await component.buildShareUrl('share-1');
      expect(component.error()).toBe('bad fdk');
    });
  });

  it('should load active shares and rebuild the first link', async () => {
    fixture.componentRef.setInput('file', { id: 7, encryptedFdk: 'fdk', encryptedName: 'enc' } as any);
    driveSpy.listShares.and.returnValue(of([{ id: 1, share_id: 'share-1', created_at: 'today' }]));
    cryptoSpy.decryptName.and.returnValue(Promise.resolve(validFdkBase64));

    await component.loadActiveShares();

    expect(component.activeShares().length).toBe(1);
    expect(component.generatedLink()).toContain(`/share/share-1#${validFdkFragment}`);
    expect(component.loading()).toBeFalse();
  });

  it('should show a useful error when loading shares fails', async () => {
    fixture.componentRef.setInput('file', { id: 7, encryptedName: 'enc' } as any);
    driveSpy.listShares.and.returnValue(throwError(() => ({ error: { error: 'list failed' } })));

    await component.loadActiveShares();

    expect(component.error()).toBe('list failed');
    expect(component.loading()).toBeFalse();

    driveSpy.listShares.and.returnValue(throwError(() => ({})));
    await component.loadActiveShares();
    expect(component.error()).toContain('Nao foi possivel carregar');
  });

  it('should clear the link when no shares are active', async () => {
    fixture.componentRef.setInput('file', { id: 7, encryptedName: 'enc' } as any);
    component.generatedLink.set('old-link');
    driveSpy.listShares.and.returnValue(of([]));

    await component.loadActiveShares();

    expect(component.generatedLink()).toBeNull();
  });

  describe('generateLink', () => {
    it('should create a share, rebuild its URL and refresh the list', async () => {
      fixture.componentRef.setInput('file', {
        id: 7,
        encryptedFdk: 'fdk',
        decryptedName: 'arquivo.txt',
        encryptedName: 'enc'
      } as any);
      cryptoSpy.decryptName.and.returnValue(Promise.resolve(validFdkBase64));
      kasumiSpy.encryptName.and.returnValue(Promise.resolve('encrypted-name'));
      driveSpy.createShareLink.and.returnValue(of({ share_id: 'share-2' }));
      driveSpy.listShares.and.returnValue(of([{ id: 2, share_id: 'share-2', created_at: 'now' }]));

      await component.generateLink();

      expect(driveSpy.createShareLink).toHaveBeenCalledWith(7, 'encrypted-name');
      expect(component.generatedLink()).toContain(`/share/share-2#${validFdkFragment}`);
      expect(component.activeShares()[0].share_id).toBe('share-2');
      expect(component.loading()).toBeFalse();
      expect(cryptoSpy.decryptName).toHaveBeenCalledTimes(1);
    });

    it('wipes the temporary FDK before starting share API work', async () => {
      fixture.componentRef.setInput('file', {
        id: 7,
        encryptedFdk: 'fdk',
        decryptedName: 'arquivo.txt',
        encryptedName: 'enc',
      } as any);
      const fdkBase64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(0x5a)));
      let capturedFdk!: Uint8Array;
      let fdkAtApiCall!: number[];
      cryptoSpy.decryptName.and.returnValue(Promise.resolve(fdkBase64));
      kasumiSpy.encryptName.and.callFake(async (_name: string, fdk: Uint8Array) => {
        capturedFdk = fdk;
        return 'encrypted-name';
      });
      driveSpy.createShareLink.and.callFake(() => {
        fdkAtApiCall = Array.from(capturedFdk);
        return of({ share_id: 'share-a16' });
      });
      driveSpy.listShares.and.returnValue(of([]));

      await component.generateLink();

      expect(fdkAtApiCall).toEqual(new Array(32).fill(0));
      expect(Array.from(capturedFdk)).toEqual(new Array(32).fill(0));
    });

    it('wipes the temporary FDK when share-name encryption fails', async () => {
      fixture.componentRef.setInput('file', {
        id: 7,
        encryptedFdk: 'fdk',
        decryptedName: 'arquivo.txt',
        encryptedName: 'enc',
      } as any);
      const fdkBase64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(0x5a)));
      let capturedFdk!: Uint8Array;
      cryptoSpy.decryptName.and.returnValue(Promise.resolve(fdkBase64));
      kasumiSpy.encryptName.and.callFake(async (_name: string, fdk: Uint8Array) => {
        capturedFdk = fdk;
        throw new Error('A16_ENCRYPT_NAME_FAILURE');
      });

      await component.generateLink();

      expect(component.error()).toBe('A16_ENCRYPT_NAME_FAILURE');
      expect(Array.from(capturedFdk)).toEqual(new Array(32).fill(0));
    });

    it('keeps the temporary FDK wiped when share creation and refresh fail', async () => {
      fixture.componentRef.setInput('file', {
        id: 7,
        encryptedFdk: 'fdk',
        decryptedName: 'arquivo.txt',
        encryptedName: 'enc',
      } as any);
      const fdkBase64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(0x5a)));
      let capturedFdk!: Uint8Array;
      cryptoSpy.decryptName.and.returnValue(Promise.resolve(fdkBase64));
      kasumiSpy.encryptName.and.callFake(async (_name: string, fdk: Uint8Array) => {
        capturedFdk = fdk;
        return 'encrypted-name';
      });
      driveSpy.createShareLink.and.returnValue(throwError(() => ({ error: { error: 'create failed' } })));

      await component.generateLink();

      expect(component.error()).toBe('create failed');
      expect(Array.from(capturedFdk)).toEqual(new Array(32).fill(0));

      driveSpy.createShareLink.and.returnValue(of({ share_id: 'share-a16-refresh' }));
      driveSpy.listShares.and.returnValue(throwError(() => new Error('refresh failed')));
      await component.generateLink();

      expect(component.generatedLink()).toContain('/share/share-a16-refresh#Wlpa');
      expect(component.loading()).toBeFalse();
      expect(Array.from(capturedFdk)).toEqual(new Array(32).fill(0));
    });

    it('should handle a missing FDK and API errors', async () => {
      fixture.componentRef.setInput('file', { id: 7, encryptedName: 'enc' } as any);
      await component.generateLink();
      expect(component.error()).toContain('ausente');

      fixture.componentRef.setInput('file', { id: 7, encryptedFdk: 'fdk', encryptedName: 'enc' } as any);
      cryptoSpy.decryptName.and.returnValue(Promise.resolve(validFdkBase64));
      kasumiSpy.encryptName.and.returnValue(Promise.resolve('encrypted-name'));
      driveSpy.createShareLink.and.returnValue(throwError(() => ({ error: { error: 'create failed' } })));
      await component.generateLink();

      expect(component.error()).toBe('create failed');
      expect(component.loading()).toBeFalse();

      fixture.componentRef.setInput('file', { id: 7, encryptedFdk: 'fdk', encryptedName: 'fallback.txt' } as any);
      driveSpy.createShareLink.and.returnValue(of({ share_id: 'share-3' }));
      driveSpy.listShares.and.returnValue(throwError(() => new Error('refresh failed')));
      await component.generateLink();
      expect(component.generatedLink()).toContain('/share/share-3');
      expect(component.loading()).toBeFalse();
    });
  });

  it('should revoke shares and handle revoke failures', async () => {
    component.activeShares.set([
      { id: 1, share_id: 'share-1', created_at: 'today' },
      { id: 2, share_id: 'share-2', created_at: 'today' }
    ]);
    component.generatedLink.set('http://link');
    driveSpy.revokeShare.and.returnValue(of({}));

    await component.revokeShare('share-1');

    expect(component.activeShares().map(s => s.share_id)).toEqual(['share-2']);
    expect(component.generatedLink()).toBeNull();
    expect(component.revokingId()).toBeNull();

    driveSpy.revokeShare.and.returnValue(throwError(() => ({ error: { error: 'revoke failed' } })));
    await component.revokeShare('share-2');
    expect(component.error()).toBe('revoke failed');
    expect(component.revokingId()).toBeNull();

    driveSpy.revokeShare.and.returnValue(throwError(() => ({})));
    await component.revokeShare('share-2');
    expect(component.error()).toContain('Nao foi possivel revogar');
  });

  it('should copy the generated link and use fallback error text', async () => {
    fixture.componentRef.setInput('file', { id: 1, encryptedFdk: 'fdk', encryptedName: 'enc' } as any);
    cryptoSpy.decryptName.and.returnValue(Promise.reject({}));
    await component.buildShareUrl('share-1');
    expect(component.error()).toContain('Falha ao descriptografar');

    const input = document.createElement('input');
    input.value = 'https://share';
    spyOn(navigator.clipboard, 'writeText').and.returnValue(Promise.resolve());
    component.copyToClipboard(input);
    await Promise.resolve();
    expect(component.copySuccess()).toBeTrue();
  });

  it('A19-LOCK-C03/C04 does not publish a share URL after the owner is destroyed', async () => {
    fixture.componentRef.setInput('file', { id: 1, encryptedFdk: 'fdk', encryptedName: 'enc' } as any);
    const pendingFdk = deferred<string>();
    cryptoSpy.decryptName.and.returnValue(pendingFdk.promise);

    const operation = component.buildShareUrl('share-stale');
    fixture.destroy();
    pendingFdk.resolve(validFdkBase64);
    await operation;

    expect(component.generatedLink()).toBeNull();
  });

  it('should use fallback messages for preparation and creation failures', async () => {
    fixture.componentRef.setInput('file', { id: 1, encryptedFdk: 'fdk', encryptedName: 'enc' } as any);
    cryptoSpy.decryptName.and.returnValue(Promise.reject({}));
    await component.generateLink();
    expect(component.error()).toContain('Falha ao descriptografar');

    cryptoSpy.decryptName.and.returnValue(Promise.resolve(validFdkBase64));
    kasumiSpy.encryptName.and.returnValue(Promise.resolve('encrypted-name'));
    driveSpy.createShareLink.and.returnValue(throwError(() => ({})));
    await component.generateLink();
    expect(component.error()).toContain('Nao foi possivel gerar');
  });

  it('should emit close for the close button and backdrop only', () => {
    const close = jasmine.createSpy('close');
    component.close.subscribe(close);

    component.onBackdropClick({ target: document.createElement('div') } as unknown as MouseEvent);
    expect(close).not.toHaveBeenCalled();
    component.closeModal();
    expect(close).toHaveBeenCalledTimes(1);

    const backdrop = document.createElement('div');
    backdrop.classList.add('modal-backdrop');
    component.onBackdropClick({ target: backdrop } as unknown as MouseEvent);
    expect(close).toHaveBeenCalledTimes(2);
  });
});
