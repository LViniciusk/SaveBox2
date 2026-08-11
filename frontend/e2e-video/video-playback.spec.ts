import { spawn } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect } from '../e2e/support/fixtures';
import {
  driveItem,
  loginAndUnlock,
  uniqueFileName,
  uploadLocalFile,
} from '../e2e/support/session';

const CASES = [
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

async function generateVideo(path: string, audio: boolean, movFlags: string | null, duration: number): Promise<void> {
  const ffmpeg = process.env['NANIKA_FFMPEG_PATH'] ?? 'ffmpeg';
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=24:duration=${duration}`,
  ];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=48000:duration=${duration}`);
  args.push(
    '-map', '0:v:0',
    ...(audio ? ['-map', '1:a:0'] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2',
    '-b:v', '1200k', '-maxrate', '1200k', '-bufsize', '2400k',
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

async function installMediaDiagnostics(page: Page): Promise<void> {
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

for (const videoCase of CASES) {
  const seekDescription = videoCase.seekMode === 'worker-out-of-buffer'
    ? 'worker out-of-buffer seek'
    : 'native buffered seek';
  test(`${videoCase.name}: browser playback, ${seekDescription}, and teardown`, async ({ page, credentials }, testInfo) => {
    const caseName = videoCase.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filename = uniqueFileName(`b89-video-${caseName}`, 'mp4');
    const filePath = testInfo.outputPath(filename);
    try {
      await generateVideo(filePath, videoCase.audio, videoCase.movFlags, videoCase.duration);
      await installMediaDiagnostics(page);
      await loginAndUnlock(page, credentials);
      await uploadLocalFile(page, filePath, filename);
      await driveItem(page, filename).dblclick();
      await expect(page.locator('app-image-player .play-overlay-btn')).toBeVisible();
      await page.locator('app-image-player .play-overlay-btn').click();

      const video = page.locator('app-image-player app-video-player video.video-node');
      await expect.poll(() => video.evaluate(element => element.readyState), { timeout: 15_000 })
        .toBeGreaterThanOrEqual(2);
      await expect.poll(async () => page.evaluate(() =>
        (window as Window & { __nanikaMediaEvents?: Array<{ action: string; type?: string }> })
          .__nanikaMediaEvents?.some(event => event.action === 'response' && event.type === 'BOOTSTRAP_COMPLETE') ?? false,
      )).toBe(true);
      await expect.poll(() => video.evaluate(element => element.currentTime), { timeout: 10_000 })
        .toBeGreaterThan(3);
      if (videoCase.seekMode === 'native-buffered') await video.evaluate(element => element.pause());

      const beforeSeek = await video.evaluate(element => ({
        duration: element.duration,
        bufferedEnd: element.buffered.length ? element.buffered.end(element.buffered.length - 1) : 0,
        error: element.error?.code ?? null,
      }));
      if (Number.isFinite(beforeSeek.duration)) expect(beforeSeek.duration).toBeGreaterThan(60);
      expect(beforeSeek.error).toBeNull();
      const currentTime = await video.evaluate(element => element.currentTime);
      const sliderMax = await page.locator('app-video-player .progress-slider')
        .evaluate(element => Number((element as HTMLInputElement).max));
      const target = videoCase.seekMode === 'worker-out-of-buffer'
        ? Math.min(beforeSeek.duration - 5, Math.max(beforeSeek.duration * 0.84, currentTime + 10))
        : Math.min(sliderMax - 2, beforeSeek.bufferedEnd - 2, Math.max(20, currentTime + 5));
      if (videoCase.seekMode === 'worker-out-of-buffer') {
        expect(beforeSeek.bufferedEnd).toBeLessThan(target - 1);
      } else {
        expect(beforeSeek.bufferedEnd).toBeGreaterThan(currentTime + 2);
        expect(target).toBeLessThan(beforeSeek.bufferedEnd);
      }
      expect(target).toBeLessThanOrEqual(sliderMax);
      const seekRequestsBefore = await page.evaluate(() =>
        (window as Window & { __nanikaMediaEvents?: Array<{ action: string; type?: string }> })
          .__nanikaMediaEvents?.filter(event => event.action === 'request' && event.type === 'SEEK').length ?? 0,
      );
      await page.locator('app-video-player .progress-slider').evaluate((element, value) => {
        const slider = element as HTMLInputElement;
        slider.value = String(value);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }, target);

      if (videoCase.seekMode === 'worker-out-of-buffer') {
        await expect.poll(async () => page.evaluate(() =>
          (window as Window & { __nanikaMediaEvents?: Array<{ action: string; type?: string }> })
            .__nanikaMediaEvents?.filter(event => event.action === 'request' && event.type === 'SEEK').length ?? 0,
        ), { timeout: 10_000 }).toBeGreaterThan(seekRequestsBefore);
        await expect.poll(async () => page.evaluate(() =>
          (window as Window & { __nanikaMediaEvents?: Array<{ action: string; type?: string }> })
            .__nanikaMediaEvents?.some(event => event.action === 'response' && event.type === 'SEEK_COMPLETE') ?? false,
        ), { timeout: 15_000 }).toBe(true);
      } else {
        await video.evaluate(element => element.play());
        const seekRequestsAfter = await page.evaluate(() =>
          (window as Window & { __nanikaMediaEvents?: Array<{ action: string; type?: string }> })
            .__nanikaMediaEvents?.filter(event => event.action === 'request' && event.type === 'SEEK').length ?? 0,
        );
        expect(seekRequestsAfter).toBe(seekRequestsBefore);
      }
      await expect.poll(() => video.evaluate(element => element.currentTime), { timeout: 15_000 })
        .toBeGreaterThan(target + 0.5);
      await expect(page.locator('app-image-player app-video-player .error-overlay')).toHaveCount(0);

      const diagnostics = await page.evaluate(() => ({
        events: (window as Window & { __nanikaMediaEvents?: Array<{ action: string; type?: string; generation?: number }> })
          .__nanikaMediaEvents ?? [],
        mimeTypes: (window as Window & { __nanikaMseTypes?: string[] }).__nanikaMseTypes ?? [],
      }));
      expect(diagnostics.mimeTypes.some(type => type.startsWith('video/mp4; codecs="avc1'))).toBe(true);
      if (videoCase.audio) {
        expect(diagnostics.mimeTypes.some(type => type.includes('mp4a'))).toBe(true);
      }

      await page.getByRole('button', { name: 'Voltar' }).click();
      await expect(page.locator('app-image-player app-video-player')).toHaveCount(0);
      await expect.poll(async () => page.evaluate(() =>
        (window as Window & { __nanikaMediaEvents?: Array<{ action: string }> })
          .__nanikaMediaEvents?.filter(event => event.action === 'terminate').length ?? 0,
      )).toBeGreaterThanOrEqual(2);
      await page.getByRole('button', { name: 'Voltar' }).click();
      await expect(page.locator('app-image-player')).toHaveCount(0);
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        video: (() => {
          const element = document.querySelector('app-image-player app-video-player video') as HTMLVideoElement | null;
          return element ? {
            currentTime: element.currentTime,
            duration: element.duration,
            readyState: element.readyState,
            errorCode: element.error?.code ?? null,
            bufferedEnd: element.buffered.length ? element.buffered.end(element.buffered.length - 1) : 0,
          } : null;
        })(),
        events: (window as Window & { __nanikaMediaEvents?: Array<{ action: string; type?: string; generation?: number }> })
          .__nanikaMediaEvents?.slice(-12) ?? [],
        overlay: document.querySelector('vite-error-overlay')?.textContent?.slice(0, 500) ?? null,
      })).catch(() => null);
      console.error(`B.89 video diagnostic (${videoCase.name}): ${JSON.stringify(diagnostics)}`);
      throw error;
    } finally {
      await rm(filePath, { force: true });
    }
  });
}
