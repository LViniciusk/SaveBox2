import { spawn, execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { Page } from '@playwright/test';

export const VIDEO_CASES = [
  { name: 'classic faststart A/V', audio: true, movFlags: '+faststart', duration: 180, seekMode: 'worker-out-of-buffer' },
  { name: 'classic tail-moov video', audio: false, movFlags: null, duration: 180, seekMode: 'worker-out-of-buffer' },
  {
    name: 'fragmented A/V',
    audio: true,
    movFlags: '+empty_moov+frag_keyframe+default_base_moof',
    duration: 75,
    seekMode: 'native-buffered',
  },
] as const;

export async function seedReadinessCorpus(credentials: unknown, paths: string[], thumbnailMode = false, action?: string): Promise<any> {
  const child = execFile(process.execPath, [process.env['WAVE1_FIXTURE_BUNDLE']!], { env: process.env, windowsHide: true, maxBuffer: 1024 * 1024 });
  const completion = new Promise<any>((resolve, reject) => {
    let stdout = '';
    child.stdout!.on('data', chunk => stdout += chunk);
    child.on('error', () => reject(new Error('READINESS_FIXTURE_SEED_FAILED')));
    child.on('close', code => {
      if (code !== 0) { reject(new Error('READINESS_FIXTURE_SEED_FAILED')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('READINESS_FIXTURE_SEED_FAILED')); }
    });
  });
  child.stdin!.end(JSON.stringify({ credentials, paths, thumbnailMode, action }));
  return completion;
}

export async function generateVideo(path: string, audio: boolean, movFlags: string | null, duration: number, bitrateKbps = 1200): Promise<void> {
  if (![1200, 2400].includes(bitrateKbps)) throw new Error('INVALID_EXPERIMENTAL_FIXTURE_BITRATE');
  const ffmpeg = process.env['NANIKA_FFMPEG_PATH'] ?? 'ffmpeg';
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${bitrateKbps === 1200 ? '320x180' : '640x360'}:rate=24:duration=${duration}`,
  ];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${duration}`);
  args.push(
    '-map', '0:v:0',
    ...(audio ? ['-map', '1:a:0'] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2',
    '-b:v', `${bitrateKbps}k`, '-maxrate', `${bitrateKbps}k`, '-bufsize', `${bitrateKbps * 2}k`,
    '-g', '24', '-pix_fmt', 'yuv420p',
  );
  if (audio) args.push('-c:a', 'aac', '-b:a', '96k');
  if (movFlags) args.push('-movflags', movFlags);
  args.push(path);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', () => reject(new Error('FFmpeg is unavailable; set NANIKA_FFMPEG_PATH.')));
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg fixture generation failed (${code}): ${stderr.slice(-2000)}`));
    });
  });

  if ((await stat(path)).size <= 4 * 1024 * 1024) {
    throw new Error('Video fixture must exceed one 4 MiB Kasumi chunk to exercise an unbuffered seek.');
  }
}

export async function installMediaDiagnostics(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type EventRecord = { action: string; type?: string; generation?: number; mime?: string };
    const state = window as Window & { __nanikaMediaEvents?: EventRecord[]; __nanikaMseTypes?: string[] };
    state.__nanikaMediaEvents = [];
    state.__nanikaMseTypes = [];
    const events = state.__nanikaMediaEvents;
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        events.push({ action: 'create' });
        this.addEventListener('message', event => {
          const data = event.data as { type?: unknown; generation?: unknown } | null;
          if (typeof data?.type === 'string') {
            events.push({
              action: 'response',
              type: data.type,
              ...(typeof data.generation === 'number' ? { generation: data.generation } : {}),
            });
          }
        });
      }

      override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
        const data = message as { type?: unknown; generation?: unknown } | null;
        if (typeof data?.type === 'string') {
          events.push({
            action: 'request',
            type: data.type,
            ...(typeof data.generation === 'number' ? { generation: data.generation } : {}),
          });
        }
        super.postMessage(message, transfer as Transferable[]);
      }

      override terminate(): void {
        events.push({ action: 'terminate' });
        super.terminate();
      }
    };

    const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mimeType: string): SourceBuffer {
      state.__nanikaMseTypes?.push(mimeType);
      return addSourceBuffer.call(this, mimeType);
    };
  });
}
