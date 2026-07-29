import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DriveFile } from '../../state/drive.store';
import { DecryptedMediaLoaderService, DecryptedMediaResource } from '../../services/decrypted-media-loader.service';
import { AudioPlayerComponent } from './audio-player.component';

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
});
