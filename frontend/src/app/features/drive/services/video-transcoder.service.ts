import { Injectable } from '@angular/core';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { environment } from '../../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class VideoTranscoderService {
  private ffmpeg: FFmpeg | null = null;
  private ffmpegLoadPromise: Promise<FFmpeg> | null = null;
  private transcodeTail: Promise<void> = Promise.resolve();

  private createFFmpeg(): FFmpeg {
    return new FFmpeg();
  }

  async loadFFmpeg(): Promise<FFmpeg> {
    if (this.ffmpeg) return this.ffmpeg;

    if (this.ffmpegLoadPromise) return this.ffmpegLoadPromise;

    const loadPromise = (async () => {
      if (environment.logs.ffmpeg) console.log('[VideoTranscoder] Starting FFmpeg load process...');
      const ffmpeg = this.createFFmpeg();

      ffmpeg.on('log', ({ message }) => {
        if (environment.logs.ffmpeg) console.log('[FFmpeg]', message);
      });

      try {
        const coreURL = '/ffmpeg-core.js';
        const wasmURL = '/ffmpeg-core.wasm';
        // Use the raw ESM worker so the browser's native dynamic import() works
        // for loading the ESM version of ffmpeg-core, bypassing Webpack's 'Cannot find module' stub.
        const classWorkerURL = '/ffmpeg/worker.js';
        await ffmpeg.load({
          coreURL,
          wasmURL,
          classWorkerURL
        });
        this.ffmpeg = ffmpeg;
        return ffmpeg;
      } catch (e) {
        this.terminateFFmpeg(ffmpeg);
        console.error('[VideoTranscoder] Error during loadFFmpeg:', e);
        throw e;
      }
    })();

    this.ffmpegLoadPromise = loadPromise;
    try {
      return await loadPromise;
    } finally {
      if (this.ffmpegLoadPromise === loadPromise) {
        this.ffmpegLoadPromise = null;
      }
    }
  }

  /**
   * Obtém a duração de um vídeo localmente via navegador (sem ffmpeg).
   * @param file Arquivo de vídeo
   * @returns Duração em segundos, ou null se não for possível.
   */
  getVideoDuration(file: File): Promise<number | null> {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      const url = URL.createObjectURL(file);
      
      const onMetadataLoaded = () => {
        URL.revokeObjectURL(url);
        video.removeEventListener('loadedmetadata', onMetadataLoaded);
        video.removeEventListener('error', onError);
        resolve(isFinite(video.duration) ? video.duration : null);
      };
      
      const onError = () => {
        URL.revokeObjectURL(url);
        video.removeEventListener('loadedmetadata', onMetadataLoaded);
        video.removeEventListener('error', onError);
        resolve(null);
      };

      video.addEventListener('loadedmetadata', onMetadataLoaded);
      video.addEventListener('error', onError);
      video.src = url;
    });
  }

  /**
   * Converte um File de video pesadíssimo para uma versão otimizada H.264 720p em MP4.
   * Utiliza ffmpeg.wasm single-threaded.
   */
  async transcodeToProxy(
    inputFile: File,
    mode: 'pure' | 'compressed',
    onProgress?: (ratio: number, statusMessage: string) => void,
    signal?: AbortSignal,
  ): Promise<File> {
    this.throwIfAborted(signal);
    const operation = this.transcodeTail.then(() =>
      this.transcodeToProxyExclusive(inputFile, mode, onProgress, signal)
    );
    this.transcodeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async transcodeToProxyExclusive(
    inputFile: File,
    mode: 'pure' | 'compressed',
    onProgress?: (ratio: number, statusMessage: string) => void,
    signal?: AbortSignal,
  ): Promise<File> {
    this.throwIfAborted(signal);
    if (environment.logs.ffmpeg) console.log('[VideoTranscoder] Transcoding started for:', inputFile.name);
    if (onProgress) onProgress(0, 'Carregando motor de vídeo...');
    this.throwIfAborted(signal);
    const ffmpeg = await this.loadFFmpeg();
    this.throwIfAborted(signal);

    const inputName = 'input_' + Math.random().toString(36).substring(7) + '_' + inputFile.name;
    const outputName = 'proxy_' + Math.random().toString(36).substring(7) + '.mp4';
    let terminated = false;
    const onAbort = () => {
      terminated = true;
      this.terminateFFmpeg(ffmpeg);
    };

    // Ouve progresso se tiver callback
    const progressHandler = ({ progress }: { progress: number; time: number }) => {
      if (signal?.aborted) return;
      if (onProgress) onProgress(progress * 0.99, `Comprimindo vídeo (2/3)... ${Math.round(progress * 100)}%`);
    };
    ffmpeg.on('progress', progressHandler);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      // Escreve o arquivo no sistema de arquivos em memoria do ffmpeg
      if (onProgress) onProgress(0, 'Copiando arquivo para memória (1/3)...');
      this.throwIfAborted(signal);
      const inputData = await fetchFile(inputFile);
      this.throwIfAborted(signal);
      await ffmpeg.writeFile(inputName, inputData);
      this.throwIfAborted(signal);

      // Executa o transcode baseado no modo
      if (onProgress) onProgress(0, 'Convertendo vídeo (2/3)...');
      const args = [
        '-i', inputName,
        '-c:v', 'libx264'
      ];

      if (mode === 'compressed') {
        args.push('-crf', '28', '-preset', 'veryfast', '-vf', `scale='trunc(oh*a/2)*2':'min(720,ih)'`);
      } else {
        // pure mode (high quality, original size)
        args.push('-crf', '18', '-preset', 'fast');
      }

      args.push('-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputName);

      this.throwIfAborted(signal);
      await ffmpeg.exec(args);
      this.throwIfAborted(signal);

      if (onProgress) onProgress(1, 'Finalizando otimização (3/3)...');
      this.throwIfAborted(signal);
      const proxyData = await ffmpeg.readFile(outputName);
      this.throwIfAborted(signal);
      
      const blob = new Blob([proxyData as any], { type: 'video/mp4' });
      // Remove a extensão original e põe .mp4
      const newName = inputFile.name.substring(0, inputFile.name.lastIndexOf('.')) + '_proxy.mp4';
      
      return new File([blob], newName, { type: 'video/mp4' });

    } catch (e) {
      this.throwIfAborted(signal);
      throw e;
    } finally {
      // Limpeza de recursos
      ffmpeg.off('progress', progressHandler);
      try {
        if (!terminated) await ffmpeg.deleteFile(inputName);
        if (!terminated) await ffmpeg.deleteFile(outputName);
      } catch (e) {
        if (!terminated) console.warn('[VideoTranscoder] Erro limpando arquivos do ffmpeg', e);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      this.throwIfAborted(signal);
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DOMException('Transcode cancelled', 'AbortError');
  }

  private terminateFFmpeg(ffmpeg: FFmpeg): void {
    if (this.ffmpeg === ffmpeg) this.ffmpeg = null;
    try {
      ffmpeg.terminate();
    } catch {
      console.warn('[VideoTranscoder] Failed to terminate FFmpeg');
    }
  }

  isVideo(file: File): boolean {
    return file.type.startsWith('video/') || 
           file.name.toLowerCase().endsWith('.mp4') || 
           file.name.toLowerCase().endsWith('.webm') ||
           file.name.toLowerCase().endsWith('.mov') ||
           file.name.toLowerCase().endsWith('.mkv') ||
           file.name.toLowerCase().endsWith('.avi') ||
           file.name.toLowerCase().endsWith('.mpg');
  }

  isStreamingFormatSupported(file: File): boolean {
    const ext = file.name.toLowerCase().split('.').pop();
    if (!ext) return false;
    return ext === 'mp4';
  }
}
