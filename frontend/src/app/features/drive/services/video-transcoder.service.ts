import { Injectable } from '@angular/core';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { environment } from '../../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class VideoTranscoderService {
  private ffmpeg: FFmpeg | null = null;

  async loadFFmpeg(): Promise<FFmpeg> {
    if (this.ffmpeg) {
      console.log('[VideoTranscoder] FFmpeg already loaded, returning instance.');
      return this.ffmpeg;
    }

    console.log('[VideoTranscoder] Starting FFmpeg load process...');
    if (environment.logs.ffmpeg) console.log('[VideoTranscoder] Starting FFmpeg load process...');
    const ffmpeg = new FFmpeg();
    
    ffmpeg.on('log', ({ message }) => {
      if (environment.logs.ffmpeg) console.log('[FFmpeg]', message);
    });

    try {
      if (environment.logs.ffmpeg) console.log('[VideoTranscoder] Fetching coreURL...');
      const coreURL = '/ffmpeg-core.js';
      if (environment.logs.ffmpeg) console.log('[VideoTranscoder] Fetched coreURL:', coreURL);
      
      if (environment.logs.ffmpeg) console.log('[VideoTranscoder] Fetching wasmURL...');
      const wasmURL = '/ffmpeg-core.wasm';
      if (environment.logs.ffmpeg) console.log('[VideoTranscoder] Fetched wasmURL:', wasmURL);

      if (environment.logs.ffmpeg) console.log('[VideoTranscoder] Fetching classWorkerURL...');
      // Use the raw ESM worker so the browser's native dynamic import() works
      // for loading the ESM version of ffmpeg-core, bypassing Webpack's 'Cannot find module' stub.
      const classWorkerURL = '/ffmpeg/worker.js';
      if (environment.logs.ffmpeg) console.log('[VideoTranscoder] classWorkerURL set to:', classWorkerURL);

      if (environment.logs.ffmpeg) console.log('[VideoTranscoder] Calling ffmpeg.load()...');
      await ffmpeg.load({
        coreURL,
        wasmURL,
        classWorkerURL
      });
      if (environment.logs.ffmpeg) console.log('[VideoTranscoder] ffmpeg.load() finished successfully!');

      this.ffmpeg = ffmpeg;
      return ffmpeg;
    } catch (e) {
      console.error('[VideoTranscoder] Error during loadFFmpeg:', e);
      throw e;
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
    onProgress?: (ratio: number, statusMessage: string) => void
  ): Promise<File> {
    if (environment.logs.ffmpeg) console.log('[VideoTranscoder] Transcoding started for:', inputFile.name);
    if (onProgress) onProgress(0, 'Carregando motor de vídeo...');
    const ffmpeg = await this.loadFFmpeg();

    const inputName = 'input_' + Math.random().toString(36).substring(7) + '_' + inputFile.name;
    const outputName = 'proxy_' + Math.random().toString(36).substring(7) + '.mp4';

    // Escreve o arquivo no sistema de arquivos em memoria do ffmpeg
    if (onProgress) onProgress(0, 'Copiando arquivo para memória (1/3)...');
    await ffmpeg.writeFile(inputName, await fetchFile(inputFile));

    // Ouve progresso se tiver callback
    const progressHandler = ({ progress, time }: { progress: number; time: number }) => {
      if (environment.logs.ffmpeg) console.log(`[VideoTranscoder] FFmpeg progress: ${Math.round(progress * 100)}% (time: ${time})`);
      if (onProgress) onProgress(progress * 0.99, `Comprimindo vídeo (2/3)... ${Math.round(progress * 100)}%`);
    };
    ffmpeg.on('progress', progressHandler);

    try {
      // Executa o transcode. 
      if (onProgress) onProgress(0, 'Comprimindo vídeo (2/3)...');
      await ffmpeg.exec([
        '-i', inputName,
        '-c:v', 'libx264',
        '-crf', '28',
        '-preset', 'veryfast',
        '-vf', `scale='trunc(oh*a/2)*2':'min(720,ih)'`,
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outputName
      ]);

      if (onProgress) onProgress(1, 'Finalizando otimização (3/3)...');
      const proxyData = await ffmpeg.readFile(outputName);
      
      const blob = new Blob([proxyData as any], { type: 'video/mp4' });
      // Remove a extensão original e põe .mp4
      const newName = inputFile.name.substring(0, inputFile.name.lastIndexOf('.')) + '_proxy.mp4';
      
      return new File([blob], newName, { type: 'video/mp4' });

    } finally {
      // Limpeza de recursos
      ffmpeg.off('progress', progressHandler);
      try {
        await ffmpeg.deleteFile(inputName);
        await ffmpeg.deleteFile(outputName);
      } catch (e) {
        console.warn('[VideoTranscoder] Erro limpando arquivos do ffmpeg', e);
      }
    }
  }

  isVideo(file: File): boolean {
    return file.type.startsWith('video/') || 
           file.name.toLowerCase().endsWith('.mp4') || 
           file.name.toLowerCase().endsWith('.mov') ||
           file.name.toLowerCase().endsWith('.mkv') ||
           file.name.toLowerCase().endsWith('.avi');
  }
}
