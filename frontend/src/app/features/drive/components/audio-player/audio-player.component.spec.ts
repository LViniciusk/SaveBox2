import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DriveFile } from '../../state/drive.store';
import { DecryptedMediaLoaderService, DecryptedMediaResource } from '../../services/decrypted-media-loader.service';
import { AudioPlayerComponent } from './audio-player.component';

function mediaEvent(options: {
  code?: number | null;
  networkState?: number;
  readyState?: number;
  canPlayType?: CanPlayTypeResult;
}) {
  const canPlayType = jasmine.createSpy('canPlayType').and.returnValue(options.canPlayType ?? '');
  const element = {
    error: options.code == null ? null : { code: options.code },
    networkState: options.networkState ?? 0,
    readyState: options.readyState ?? 0,
    canPlayType,
  } as unknown as HTMLMediaElement;

  return {
    event: { target: element } as unknown as Event,
    element,
    canPlayType,
  };
}

describe('AudioPlayerComponent', () => {
  let fixture: ComponentFixture<AudioPlayerComponent>;
  let component: AudioPlayerComponent;
  let loader: jasmine.SpyObj<DecryptedMediaLoaderService>;
  const file = { id: 1, isFolder: false, encryptedName: 'song', decryptedName: 'song.mp3', type: 'audio', sizeBytes: 1 } as DriveFile;

  beforeEach(async () => {
    loader = jasmine.createSpyObj('DecryptedMediaLoaderService', ['load']);
    loader.load.and.resolveTo({ url: 'blob:audio', mimeType: 'audio/mpeg', cleanup: jasmine.createSpy('cleanup') } as DecryptedMediaResource);
    await TestBed.configureTestingModule({
      imports: [AudioPlayerComponent],
      providers: [provideZonelessChangeDetection(), { provide: DecryptedMediaLoaderService, useValue: loader }],
    }).compileComponents();
    fixture = TestBed.createComponent(AudioPlayerComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('file', file);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('renders native audio controls without autoplay', () => {
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    expect(audio).not.toBeNull();
    expect(audio.controls).toBeTrue();
    expect(audio.preload).toBe('metadata');
    expect(audio.autoplay).toBeFalse();
    expect((audio.querySelector('source') as HTMLSourceElement).src).toContain('blob:audio');
    expect((audio.querySelector('source') as HTMLSourceElement).type).toBe('audio/mpeg');
  });

  it('cleans the previous blob resource on destroy', () => {
    const resource = loader.load.calls.mostRecent().returnValue as unknown as Promise<DecryptedMediaResource>;
    return resource.then(() => {
      const cleanup = (component as any).resource.cleanup as jasmine.Spy;
      component.ngOnDestroy();
      expect(cleanup).toHaveBeenCalled();
    });
  });

  it('shows an error when the native player rejects the media', () => {
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    audio.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(component.error()).toContain('reproduzir');
    expect(fixture.nativeElement.querySelector('.audio-player-download')).not.toBeNull();
  });

  it('reports an explicitly unsupported MIME type without autoplaying', () => {
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    spyOn(audio, 'canPlayType').and.returnValue('');
    (component as any).audioRef = { nativeElement: audio };

    expect(component.error()).toContain('não declara suporte');
    expect(audio.autoplay).toBeFalse();
  });

  it('aborts the media load when closed', () => {
    const signal = loader.load.calls.mostRecent().args[1] as AbortSignal;
    component.requestClose();
    expect(signal.aborted).toBeTrue();
  });

  for (const action of ['close', 'destroy'] as const) {
    it(`discards a resolved resource when ${action} revokes ownership before consumption`, async () => {
      let resolve!: (resource: DecryptedMediaResource) => void;
      const cleanup = jasmine.createSpy('late-cleanup');
      loader.load.and.returnValue(new Promise<DecryptedMediaResource>(complete => resolve = complete));
      const loading = (component as any).load(file);
      const signal = loader.load.calls.mostRecent().args[1] as AbortSignal;

      resolve({ url: 'blob:late', mimeType: 'audio/mpeg', cleanup });
      if (action === 'close') component.requestClose();
      else component.ngOnDestroy();
      await loading;

      expect(signal.aborted).toBeTrue();
      expect(component.audioUrl()).toBeNull();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect((component as any).resource).toBeNull();
    });
  }

  it('aborts the old file and keeps the new resource when the old load settles last', async () => {
    let resolve!: (resource: DecryptedMediaResource) => void;
    const oldCleanup = jasmine.createSpy('old-cleanup');
    const newCleanup = jasmine.createSpy('new-cleanup');
    loader.load.and.returnValue(new Promise<DecryptedMediaResource>(complete => resolve = complete));
    const oldLoad = (component as any).load(file);
    const oldSignal = loader.load.calls.mostRecent().args[1] as AbortSignal;
    loader.load.and.resolveTo({ url: 'blob:new', mimeType: 'audio/mpeg', cleanup: newCleanup });
    await (component as any).load({ ...file, id: 2 });

    resolve({ url: 'blob:old', mimeType: 'audio/mpeg', cleanup: oldCleanup });
    await oldLoad;

    expect(oldSignal.aborted).toBeTrue();
    expect(component.audioUrl()).toBe('blob:new');
    expect(oldCleanup).toHaveBeenCalledTimes(1);
    expect(newCleanup).not.toHaveBeenCalled();
    expect((component as any).loadController.signal.aborted).toBeFalse();
  });

  it('keeps private Google Drive playback without exposing a share action', async () => {
    const googleFile: DriveFile = { ...file, storageProvider: 'google_drive' };
    fixture.componentRef.setInput('file', googleFile);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(loader.load).toHaveBeenCalledWith(googleFile, jasmine.any(AbortSignal));
    expect(fixture.nativeElement.querySelector('[aria-label*="Compartilh"]')).toBeNull();
  });

  ([
    [1, 'A reprodução foi interrompida.'],
    [2, 'O áudio não pôde ser carregado pela rede.'],
    [3, 'O navegador não conseguiu decodificar este áudio.'],
    [4, 'O formato ou codec deste áudio não é suportado pelo navegador.'],
    [0, 'Não foi possível reproduzir este áudio.'],
    [99, 'Não foi possível reproduzir este áudio.'],
  ] as const).forEach(([code, expected]) => {
    it(`maps media error code ${code}`, () => {
      component.onMediaError(mediaEvent({ code }).event);

      expect(component.error()).toBe(expected);
    });
  });

  it('preserves all media diagnostics and the canPlayType result', () => {
    component.audioMimeType.set('audio/ogg');
    const { event, canPlayType } = mediaEvent({ code: 3, networkState: 2, readyState: 1, canPlayType: 'probably' });

    component.onMediaError(event);

    expect(component.diagnostics()).toEqual({
      code: 3,
      networkState: 2,
      readyState: 1,
      mimeType: 'audio/ogg',
      canPlayType: 'probably',
    });
    expect(canPlayType).toHaveBeenCalledTimes(1);
    expect(canPlayType).toHaveBeenCalledWith('audio/ogg');
  });

  it('does not call canPlayType when the audio MIME is empty', () => {
    component.audioMimeType.set(null);
    const { event, canPlayType } = mediaEvent({ code: 2, networkState: 1, readyState: 0, canPlayType: 'maybe' });

    component.onMediaError(event);

    expect(component.diagnostics()).toEqual({
      code: 2,
      networkState: 1,
      readyState: 0,
      mimeType: '',
      canPlayType: '',
    });
    expect(canPlayType).not.toHaveBeenCalled();
  });

  it('normalizes a null event target without losing the current MIME', () => {
    component.audioMimeType.set('audio/mpeg');

    component.onMediaError({ target: null } as unknown as Event);

    expect(component.diagnostics()).toEqual({
      code: 0,
      networkState: 0,
      readyState: 0,
      mimeType: 'audio/mpeg',
      canPlayType: '',
    });
    expect(component.error()).toBe('Não foi possível reproduzir este áudio.');
  });

  it('normalizes a null MediaError while preserving element states', () => {
    const { event } = mediaEvent({ code: null, networkState: 2, readyState: 1 });

    component.onMediaError(event);

    expect(component.diagnostics()).toEqual({
      code: 0,
      networkState: 2,
      readyState: 1,
      mimeType: 'audio/mpeg',
      canPlayType: '',
    });
  });

  it('keeps probably as declared support in the audio element setter', () => {
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    spyOn(audio, 'canPlayType').and.returnValue('probably');
    component.error.set(null);

    (component as any).audioRef = { nativeElement: audio };

    expect(component.error()).toBeNull();
  });

  it('preserves maybe as the browser canPlayType diagnostic', () => {
    component.audioMimeType.set('audio/ogg');
    const { event } = mediaEvent({ code: 4, canPlayType: 'maybe' });

    component.onMediaError(event);

    expect(component.diagnostics()?.canPlayType).toBe('maybe');
  });
});
