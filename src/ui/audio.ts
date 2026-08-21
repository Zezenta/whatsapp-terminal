import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface AudioState {
  msgId: string;
  filePath: string;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  speed: number;
}

export class AudioPlayer {
  private mpvProcess: ChildProcess | null = null;
  private ipcSocket: net.Socket | null = null;
  private socketPath: string = '';
  private currentMsgId: string | null = null;
  private currentFilePath: string | null = null;
  private isPlaying: boolean = false;
  private currentTime: number = 0;
  private duration: number = 0;
  private speed: number = 1.0;
  private onStateChange: ((state: AudioState | null) => void) | null = null;

  private readonly SPEED_STEPS = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0];

  constructor(onStateChange?: (state: AudioState | null) => void) {
    if (onStateChange) this.onStateChange = onStateChange;
  }

  public isActive(): boolean {
    return this.currentMsgId !== null;
  }

  public getActiveMsgId(): string | null {
    return this.currentMsgId;
  }

  public getState(): AudioState | null {
    if (!this.currentMsgId || !this.currentFilePath) return null;
    return {
      msgId: this.currentMsgId,
      filePath: this.currentFilePath,
      isPlaying: this.isPlaying,
      currentTime: this.currentTime,
      duration: this.duration,
      speed: this.speed
    };
  }

  public async play(filePath: string, msgId: string) {
    if (this.currentMsgId === msgId) {
      this.togglePause();
      return;
    }

    this.stop();

    this.currentMsgId = msgId;
    this.currentFilePath = filePath;
    this.isPlaying = true;
    this.currentTime = 0;
    this.duration = 0;
    this.socketPath = path.join(os.tmpdir(), `mpv_wa_${Date.now()}_${Math.random().toString(36).slice(2)}.sock`);

    try { fs.unlinkSync(this.socketPath); } catch {}

    this.mpvProcess = spawn('mpv', [
      '--no-video',
      '--no-terminal',
      `--input-ipc-server=${this.socketPath}`,
      `--speed=${this.speed}`,
      filePath
    ], { stdio: 'ignore' });

    this.mpvProcess.on('error', () => {
      this.stop();
    });

    this.mpvProcess.on('close', () => {
      this.stop();
    });

    setTimeout(() => {
      if (!this.currentMsgId) return;
      this.connectIPC();
    }, 150);

    this.notifyState();
  }

  private connectIPC() {
    if (!fs.existsSync(this.socketPath)) return;

    this.ipcSocket = net.createConnection(this.socketPath, () => {
      this.sendIpcCommand(['observe_property', 1, 'time-pos']);
      this.sendIpcCommand(['observe_property', 2, 'duration']);
      this.sendIpcCommand(['observe_property', 3, 'pause']);
      this.sendIpcCommand(['observe_property', 4, 'speed']);
    });

    let buffer = '';
    this.ipcSocket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim());
          if (msg.event === 'property-change') {
            if (msg.name === 'time-pos' && typeof msg.data === 'number') {
              this.currentTime = msg.data;
              this.notifyState();
            } else if (msg.name === 'duration' && typeof msg.data === 'number') {
              this.duration = msg.data;
              this.notifyState();
            } else if (msg.name === 'pause' && typeof msg.data === 'boolean') {
              this.isPlaying = !msg.data;
              this.notifyState();
            } else if (msg.name === 'speed' && typeof msg.data === 'number') {
              this.speed = msg.data;
              this.notifyState();
            }
          } else if (msg.event === 'end-file' || msg.event === 'shutdown') {
            this.stop();
            return;
          }
        } catch {}
      }
    });

    this.ipcSocket.on('error', () => {
      // Socket disconnected
    });
  }

  private sendIpcCommand(command: any[]) {
    if (!this.ipcSocket || this.ipcSocket.destroyed) return;
    try {
      this.ipcSocket.write(JSON.stringify({ command }) + '\n');
    } catch {}
  }

  public togglePause() {
    if (!this.currentMsgId) return;
    this.sendIpcCommand(['cycle', 'pause']);
  }

  public seek(seconds: number) {
    if (!this.currentMsgId) return;
    this.sendIpcCommand(['seek', seconds, 'relative']);
  }

  public adjustSpeed(direction: 'up' | 'down') {
    if (!this.currentMsgId) return;
    let currentIndex = this.SPEED_STEPS.findIndex(s => Math.abs(s - this.speed) < 0.05);
    if (currentIndex === -1) currentIndex = 1; // default 1.0

    if (direction === 'up') {
      if (currentIndex < this.SPEED_STEPS.length - 1) {
        currentIndex++;
      }
    } else {
      if (currentIndex > 0) {
        currentIndex--;
      }
    }

    this.speed = this.SPEED_STEPS[currentIndex];
    this.sendIpcCommand(['set_property', 'speed', this.speed]);
  }

  public stop() {
    if (this.ipcSocket) {
      try { this.ipcSocket.destroy(); } catch {}
      this.ipcSocket = null;
    }
    if (this.mpvProcess) {
      try { this.mpvProcess.kill(); } catch {}
      this.mpvProcess = null;
    }
    if (this.socketPath) {
      try { fs.unlinkSync(this.socketPath); } catch {}
      this.socketPath = '';
    }
    this.currentMsgId = null;
    this.currentFilePath = null;
    this.isPlaying = false;
    this.currentTime = 0;
    this.duration = 0;
    this.notifyState();
  }

  private notifyState() {
    this.onStateChange?.(this.getState());
  }
}

export function extractCleanTranscription(rawOutput: string): string {
  if (!rawOutput) return '';
  const plain = rawOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const lines = plain.split('\n');

  const contentLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('Loading audio file:')) continue;
    if (trimmed.startsWith('Audio format:')) continue;
    if (trimmed.startsWith('Processing ')) continue;
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) continue;
    if (trimmed.includes('INFO') || trimmed.includes('WARN') || trimmed.includes('ERROR')) continue;
    contentLines.push(trimmed);
  }

  let result = contentLines.join('\n').trim();

  if (!result) {
    const match = plain.match(/Transcription completed in [^:]+:\s*"([\s\S]+?)"\s*$/m);
    if (match) {
      result = match[1].trim();
    }
  }

  return result;
}

export async function transcribeAudioWithVoxtype(audioPath: string, model: string = 'tiny'): Promise<string> {
  const tempWav = path.join(os.tmpdir(), `voxtype_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tempWav], {
        stdio: 'ignore'
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg conversion failed (${code})`));
      });
      proc.on('error', reject);
    });

    return await new Promise<string>((resolve, reject) => {
      const proc = spawn('voxtype', ['--model', model, '--language', 'es', 'transcribe', tempWav]);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) {
          const result = extractCleanTranscription(stdout);
          resolve(result);
        } else {
          reject(new Error(stderr || `voxtype error code ${code}`));
        }
      });
      proc.on('error', reject);
    });
  } finally {
    try { fs.unlinkSync(tempWav); } catch {}
  }
}
