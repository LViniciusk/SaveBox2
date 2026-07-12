import { Injectable } from '@angular/core';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

@Injectable({ providedIn: 'root' })
export class VideoTranscoderService {
  private ffmpeg: FFmpeg | null = null;

  async loadFFmpeg(): Promise<FFmpeg> {
    if (this.ffmpeg) return this.ffmpeg;

    const ffmpeg = new FFmpeg();
    
    ffmpeg.on('log', ({ message }) => {
      console.log('[FFmpeg]', message);
    });

    const coreURL = await toBlobURL('/ffmpeg-core.js', 'text/javascript');
    const wasmURL = await toBlobURL('/ffmpeg-core.wasm', 'application/wasm');

    await ffmpeg.load({
      coreURL,
      wasmURL
    });

    this.ffmpeg = ffmpeg;
    return ffmpeg;
  }

  /**
   * Converte um File de video pesadíssimo para uma versão otimizada H.264 720p em MP4.
   * Utiliza ffmpeg.wasm single-threaded.
   */
  async transcodeToProxy(
    inputFile: File,
    onProgress?: (ratio: number) => void
  ): Promise<File> {
    const ffmpeg = await this.loadFFmpeg();

    const inputName = 'input_' + Math.random().toString(36).substring(7) + '_' + inputFile.name;
    const outputName = 'proxy_' + Math.random().toString(36).substring(7) + '.mp4';

    // Escreve o arquivo no sistema de arquivos em memoria do ffmpeg
    await ffmpeg.writeFile(inputName, await fetchFile(inputFile));

    // Ouve progresso se tiver callback
    const progressHandler = ({ progress, time }: { progress: number; time: number }) => {
      if (onProgress) onProgress(progress);
    };
    ffmpeg.on('progress', progressHandler);

    try {
      // Executa o transcode. 
      // -vf scale: Max 720p de altura mantendo proporção
      // -c:v libx264: H.264 CPU encoder
      // -crf 28: Qualidade aceitável para streaming leve web
      // -preset ultrafast: Melhor desempenho single thread
      // -c:a aac -b:a 128k: Áudio compactado
      // -movflags +faststart: Move a atom MOOV pro começo, obrigatório para stream!
      await ffmpeg.exec([
        '-i', inputName,
        '-vf', 'scale=-2:\'min(720,ih)\'',
        '-c:v', 'libx264',
        '-crf', '28',
        '-preset', 'ultrafast',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        outputName
      ]);

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
