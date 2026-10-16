import { AfterViewInit, ApplicationRef, Component, ElementRef, inject, OnDestroy, provideZonelessChangeDetection, ViewChild, ViewContainerRef } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { VideoStreamService } from '../../src/app/features/drive/services/video-stream.service';
import { VideoPlayerComponent } from '../../src/app/features/drive/components/video-player/video-player.component';
import { KasumiCryptoService } from '../../src/app/core/crypto/kasumi-crypto.service';
import { CryptoService } from '../../src/app/core/crypto/crypto.service';
import { ShareService } from '../../src/app/features/drive/services/share.service';
import { DriveFile } from '../../src/app/features/drive/state/drive.store';
import { rangeAdapter, RangeCounters } from './range-adapter';
import { configureR8, r8Contracts, r8File, r8Providers } from './r8-integration';
import { runR11Stage } from '../../tools/ap06-r11-stage';
import { DriveService } from '../../src/app/features/drive/services/drive.service';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { map } from 'rxjs';
import { environment } from '../../src/environments/environment';
import { runR12Stage } from '../../tools/ap06-r12-stage';

interface Fixture { id: number; name: string; bytes: number; dataOffset: number; ciphertextBytes: number; }
type Mode = 'control' | 'service' | 'component' | 'store' | 'backend';
interface Observed extends RangeCounters { [name: string]: number; }
interface Session { fixture: number; mode: Mode; mountedMs: number; canplayMs: number | null;
  playbackMs: number | null; closeMs: number | null; maxCurrentTime: number; seeks: number;
  muted: boolean | null; volume: number | null; playbackRate: number | null; }
declare global {
  interface Window {
    r5Counters: { observed: Observed; sessions: Session[] };
    r7Ready: boolean; r7SessionActive: boolean;
    r7Configure: (fixtures: Fixture[], mode: Mode, runtime?: any) => Promise<void>;
    r7ReadEnvelope: (fixture: Fixture) => Promise<{ fdk: Uint8Array; baseNonce: Uint8Array }>;
    r7ControlFixture: (fixture: Fixture) => Promise<void>;
    r7WaitPlayback: (video: HTMLVideoElement, seconds: number, signal: AbortSignal) => Promise<void>;
    r7Contracts: () => Record<string, boolean>;
    r7Run: (fixture: Fixture) => Promise<void>;
    r7CancelSession: (() => void) | null;
  }
}
let currentFile: DriveFile | null = null;
let adapter: ReturnType<typeof rangeAdapter>;
let mode: Mode;
const observed = () => window.r5Counters.observed;
const forbidden = () => { throw new Error('FORBIDDEN_REAL_USER_DEPENDENCY'); };

@Component({ selector: 'r7-service-host', standalone: true, template: '<video #video playsinline [muted]="true"></video>' })
class ServiceHost implements AfterViewInit, OnDestroy {
  readonly stream = inject(VideoStreamService);
  @ViewChild('video', { static: true }) video!: ElementRef<HTMLVideoElement>;
  initialization: Promise<void> | null = null;
  ngAfterViewInit(): void { this.initialization = this.stream.initializeStream(this.video.nativeElement, currentFile!); }
  ngOnDestroy(): void { observed()['destroyCalls']++; this.stream.destroyStream(); }
}

@Component({ selector: 'r7-player-host', standalone: true, imports: [VideoPlayerComponent],
  template: '<app-video-player [file]="file" />' })
class PlayerHost {
  readonly file = currentFile!;
  @ViewChild(VideoPlayerComponent) player!: VideoPlayerComponent;
}

@Component({ selector: 'r7-root', standalone: true, template: '<ng-container #mount />' })
class Root {
  @ViewChild('mount', { read: ViewContainerRef, static: true }) mount!: ViewContainerRef;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 20000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(label);
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}

function driveFile(fixture: Fixture): DriveFile {
  if (![0, 1, 2].includes(fixture.id)) throw new Error('FORBIDDEN_FIXTURE_ID');
  return { id: fixture.id, isFolder: false, encryptedName: 'synthetic.mp4', decryptedName: fixture.name,
    type: 'video', mimeType: 'video/mp4', sizeBytes: fixture.ciphertextBytes, sizeFormatted: 'synthetic',
    modifiedAt: '2026-01-01T00:00:00Z', owner: 'synthetic', storageProvider: 'local', externalStorageId: null,
    forceOriginal: true, shareFdk: Uint8Array.from({ length: 32 }, (_, i) => (i + 1 + fixture.id * 37) % 256) };
}

async function start(app: ApplicationRef): Promise<void> {
  const root = app.components[0]!.instance as Root;
  const kasumi = app.injector.get(KasumiCryptoService);
  await kasumi.hashName('r7-startup-only');
  let stream: VideoStreamService | null = null;
  window.r7Configure = async (fixtures, selected, runtime) => {
    if (mode || !['control', 'service', 'component', 'store', 'backend'].includes(selected)) throw new Error('R7_ALREADY_CONFIGURED');
    mode = selected;
    adapter = rangeAdapter(fixtures, observed());
    await configureR8(app, fixtures, selected, runtime);
    if (mode !== 'control' && !(window as any).ap06R12Condition) stream = app.injector.get(VideoStreamService);
    await app.whenStable();
  };
  window.r7Contracts = () => ({ ...r8Contracts(), kasumiReal: kasumi instanceof KasumiCryptoService,
    streamReal: mode === 'control' || (window as any).ap06R12Condition ? stream === null : stream instanceof VideoStreamService,
    rootEmpty: root.mount.length === 0, localOnly: currentFile === null ||
      currentFile.storageProvider === 'local' && !currentFile.shareUuid && currentFile.forceOriginal === true });
  window.r7ReadEnvelope = async fixture => {
    const fdk = currentFile!.shareFdk!.slice();
    let baseNonce: Uint8Array | undefined;
    try {
      const blob = await new Promise<Blob>((resolve, reject) => adapter.downloadFileRange(fixture.id, 0,
        Math.min(128 * 1024, fixture.ciphertextBytes) - 1).subscribe({ next: resolve, error: reject }));
      const metadata = await kasumi.extractMetadata(blob, fdk, fixture.ciphertextBytes);
      if (metadata.expectedSize !== fixture.bytes || metadata.dataOffset !== fixture.dataOffset || !metadata.metadata) {
        throw new Error('R7_ENVELOPE_IDENTITY_MISMATCH');
      }
      baseNonce = await kasumi.extractBaseNonce(blob);
      return { fdk, baseNonce };
    } catch (error) { fdk.fill(0); baseNonce?.fill(0); throw error; }
  };
  window.r7Run = async fixture => {
    const c = observed();
    if (!mode || currentFile || root.mount.length || window.r7SessionActive) throw new Error('R7_SESSION_OVERLAP');
    const r12 = (window as any).ap06R12Condition;
    if (r12) {
      const file = r8File(fixture)!, controller = new AbortController();
      window.r7SessionActive = true; window.r7CancelSession = () => controller.abort();
      try {
        await runR12Stage(r12,fixture,file,app.injector.get(DriveService),kasumi,(start,end) =>
          app.injector.get(HttpClient).get(`${environment.apiUrl}/files/${file.id}/download`, {
            headers:new HttpHeaders().set('Range',`bytes=${start}-${end}`),observe:'response',responseType:'arraybuffer',withCredentials:true,
          }).pipe(map(response => { if (!response.body) throw new Error('R12_EMPTY_RESPONSE'); return response.body; })),
          (window as any).r12Counters,controller.signal);
      } finally { controller.abort();window.r7CancelSession=null;file.shareFdk?.fill(0);await app.whenStable();window.r7SessionActive=false; }
      return;
    }
    const r11 = (window as any).ap06R11Condition;
    if (r11 === 'r11.2' || r11 === 'r11.3') {
      const file = r8File(fixture)!;
      window.r7SessionActive = true;
      try { await runR11Stage(r11,fixture,file,app.injector.get(DriveService),kasumi,stream!); }
      finally { file.shareFdk?.fill(0); await app.whenStable(); window.r7SessionActive=false; }
      return;
    }
    currentFile = r8File(fixture) ?? driveFile(fixture); window.r7SessionActive = true; c['initializeAttempts']++;
    const session: Session = { fixture: fixture.id, mode, mountedMs: performance.now(), canplayMs: null,
      playbackMs: null, closeMs: null, maxCurrentTime: 0, seeks: 0, muted: null, volume: null, playbackRate: null };
    let started = false, initialized = false, completed = false;
    const event = (value: Event) => {
      const video = value.target;
      if (!(video instanceof HTMLVideoElement)) return;
      if (value.type === 'canplay') session.canplayMs ??= performance.now();
      if (value.type === 'play' && !started) {
        started = true; session.playbackMs = performance.now(); c['playbackStarted']++;
        session.muted = video.muted; session.volume = video.volume; session.playbackRate = video.playbackRate;
      }
      if (value.type === 'seeking') session.seeks++;
      session.maxCurrentTime = Math.max(session.maxCurrentTime, video.currentTime);
    };
    const types = ['canplay', 'play', 'timeupdate', 'seeking'];
    for (const type of types) { document.addEventListener(type, event, true); c['experimentalListeners']++; }
    let ref: ReturnType<ViewContainerRef['createComponent']> | null = null;
    let initialization: Promise<void> | null = null;
    const destroyHost = () => {
      if (!ref) return;
      ref.destroy(); root.mount.clear();
      c['componentsDestroyed'] += mode === 'service' ? 1 : 2;
      if (mode !== 'service') c['destroyCalls']++;
      ref = null;
    };
    window.r7CancelSession = destroyHost;
    try {
      if (mode === 'control') {
        await window.r7ControlFixture(fixture); initialized = true;
      } else {
        const count = mode === 'service' ? 1 : 2;
        ref = mode === 'service' ? root.mount.createComponent(ServiceHost) : root.mount.createComponent(PlayerHost);
        c['componentsMounted'] += count;
        ref.changeDetectorRef.detectChanges();
        if (mode === 'service') initialization = (ref.instance as ServiceHost).initialization;
        await waitFor(() => {
          if (!ref) throw new Error('R7_SESSION_CANCELLED');
          if (stream!.error()) throw new Error('R7_SERVICE_INITIALIZATION_FAILED');
          const video = ref!.location.nativeElement.querySelector('video') as HTMLVideoElement | null;
          return !!video && video.readyState >= 2 && video.buffered.length > 0 &&
            (mode === 'service' || !(ref!.instance as PlayerHost).player.isInitialLoad());
        }, 'R7_READINESS_TIMEOUT');
        if (initialization) await initialization;
        initialized = true;
        const video = ref.location.nativeElement.querySelector('video') as HTMLVideoElement;
        const controller = new AbortController();
        const progress = window.r7WaitPlayback(video, 1.5, controller.signal); progress.catch(() => {});
        try { if (mode === 'service') await video.play(); await progress; }
        catch (error) { controller.abort(); await progress.catch(() => {}); throw error; }
        if (stream!.error() || video.error || video.currentTime <= 1.5 || video.currentTime >= 10) throw new Error('R7_PLAYBACK_FAILED');
      }
      if (!started || session.maxCurrentTime <= 1.5 || session.maxCurrentTime >= 10 || session.seeks) throw new Error('R7_PLAYBACK_PROTOCOL_INVALID');
      c['playbackCompleted']++; completed = true;
    } finally {
      c['initializeSettled']++;
      if (!initialized) c['initializeFailures']++;
      if (!completed) c['playbackFailures']++;
      session.closeMs = performance.now();
      for (const type of types) { document.removeEventListener(type, event, true); c['experimentalListeners']--; }
      destroyHost(); window.r7CancelSession = null;
      if (mode === 'control') c['destroyCalls']++;
      currentFile?.shareFdk?.fill(0); currentFile = null;
      try {
        if (initialization) await initialization;
        await app.whenStable();
        await waitFor(() => c.pendingOperations === 0 && c['pendingAppends'] === 0 && c['timersLive'] === 0 &&
          c['workersCreated'] === c['workersTerminated'] && c['mediaSourcesCreated'] === c['mediaSourcesClosed'] &&
          c['sourceBuffersCreated'] === c['sourceBuffersReleased'] && c['objectUrlsCreated'] === c['objectUrlsRevoked'], 'R7_SETTLEMENT_TIMEOUT');
      } finally { window.r7SessionActive = false; window.r5Counters.sessions.push(session); }
    }
  };
  window.r7Ready = true;
}

void bootstrapApplication(Root, { providers: [provideZonelessChangeDetection(),
  ...r8Providers((id, start, end) => adapter.downloadFileRange(id, start, end)),
  { provide: CryptoService, useValue: { decryptName: forbidden, isVaultUnlocked: () => false } },
  { provide: ShareService, useValue: { downloadSharedFileRange: forbidden } },
] }).then(start).catch(error => { console.error(error); throw error; });
