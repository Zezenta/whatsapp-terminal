import blessed from 'blessed';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { patchBlessedUnicode } from './unicode-patch.js';
import { renderQRToUnicode } from './qr.js';
import { Chat, Message, ConnectionStatus } from '../types/index.js';
import { LocalDatabase } from '../db/index.js';
import { WhatsAppService } from '../whatsapp/client.js';
import { prepareImageForKitty, createKittyPlacement, clearAllKittyImages, PreparedImage } from './media.js';
import { AudioPlayer, AudioState, transcribeAudioWithVoxtype } from './audio.js';

function formatTimestamp24h(timestamp: number): string {
  if (!timestamp || timestamp <= 0) return '';
  const d = new Date(timestamp * 1000);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month} ${hours}:${minutes}`;
}

function formatSeconds(sec: number): string {
  const total = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function sanitizeTextForTui(text: string): string {
  if (!text) return '';
  return text
    .replace(/[\uFE00-\uFE0F]/g, '')
    .replace(/[\u200B-\u200F\uFEFF]/g, '');
}

function blescape(str: string): string {
  return blessed.escape(str || '');
}

interface VisibleMedia {
  msgId: string;
  prepared: PreparedImage;
}

const REACTION_MAP: Record<string, string> = {
  '1': '👍',
  '2': '❤️',
  '3': '😂',
  '4': '😮',
  '5': '😢',
  '6': '🙏'
};

export class TerminalUI {
  private screen: blessed.Widgets.Screen;
  private header: blessed.Widgets.BoxElement;
  private chatList: blessed.Widgets.ListElement;
  private chatHeader: blessed.Widgets.BoxElement;
  private messageBox: blessed.Widgets.BoxElement;
  private audioBar: blessed.Widgets.BoxElement;
  private inputBox: blessed.Widgets.TextboxElement;
  private qrBox: blessed.Widgets.BoxElement;
  private menuBox: blessed.Widgets.ListElement;

  private db: LocalDatabase;
  private waService: WhatsAppService;
  private audioPlayer: AudioPlayer;

  private isMenuOpen = false;
  private voxtypeModel: 'tiny' | 'base' | 'small' = 'tiny';

  private chats: Chat[] = [];
  private selectedChat: Chat | null = null;
  private activePanel: 'chats' | 'messages' | 'input' = 'chats';
  private chatMessageLimits = new Map<string, number>();
  private isLoadingOlder = false;
  private isTranscribing = false;
  private mediaReloadTimer: NodeJS.Timeout | null = null;
  private visibleMediaList: VisibleMedia[] = [];
  private lastRenderedKittyState = '';

  private currentMessages: Message[] = [];
  private selectedMessageIndex = -1;
  private replyingTo: Message | null = null;

  constructor(database: LocalDatabase, whatsapp: WhatsAppService) {
    patchBlessedUnicode();

    this.db = database;
    this.waService = whatsapp;

    const savedModel = this.db.getSetting('voxtype_model', 'tiny');
    if (savedModel === 'base' || savedModel === 'small' || savedModel === 'tiny') {
      this.voxtypeModel = savedModel;
    }

    this.screen = blessed.screen({
      smartCSR: true,
      title: 'WhatsApp Terminal',
      fullUnicode: true,
      cursor: {
        artificial: true,
        shape: 'line',
        blink: true,
        color: 'green'
      }
    });

    this.audioPlayer = new AudioPlayer((state) => {
      this.renderAudioBar(state);
    });

    this.header = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      content: ' {bold}{green-fg}● WhatsApp Terminal{/} | {yellow-fg}Connecting...{/} | {gray-fg}[Tab] Switch | [↑/↓] Select | [P] Audio | [T] Voxtype | [Enter] Reply{/}',
      style: {
        bg: 'black',
        fg: 'white',
        transparent: false
      }
    });

    this.chatList = blessed.list({
      top: 1,
      left: 0,
      width: '32%',
      height: '100%-1',
      tags: true,
      keys: false,
      vi: false,
      mouse: true,
      border: {
        type: 'line'
      },
      style: {
        bg: 'black',
        transparent: false,
        border: {
          fg: '#00E676'
        },
        selected: {
          bg: '#1E3326',
          fg: '#00E676',
          bold: true
        },
        item: {
          bg: 'black',
          fg: 'white'
        }
      },
      scrollbar: {
        ch: '│',
        style: {
          fg: '#555555'
        }
      }
    });

    this.chatHeader = blessed.box({
      top: 1,
      left: '32%',
      width: '68%',
      height: 3,
      tags: true,
      content: ' {bold}Select a chat from the left panel{/}',
      border: {
        type: 'line'
      },
      style: {
        bg: 'black',
        transparent: false,
        border: {
          fg: '#555555'
        },
        fg: 'white'
      }
    });

    this.messageBox = blessed.box({
      top: 4,
      left: '32%',
      width: '68%',
      height: '100%-7',
      tags: true,
      wrap: true,
      scrollable: true,
      alwaysScroll: false,
      mouse: true,
      border: {
        type: 'line'
      },
      style: {
        bg: 'black',
        transparent: false,
        border: {
          fg: '#555555'
        },
        fg: 'white'
      },
      scrollbar: {
        ch: '│',
        style: {
          fg: '#555555'
        }
      }
    });

    this.audioBar = blessed.box({
      top: '100%-6',
      left: '32%',
      width: '68%',
      height: 3,
      tags: true,
      hidden: true,
      border: {
        type: 'line'
      },
      style: {
        bg: 'black',
        transparent: false,
        border: {
          fg: '#25D366'
        },
        fg: 'white'
      }
    });

    this.inputBox = blessed.textbox({
      top: '100%-3',
      left: '32%',
      width: '68%',
      height: 3,
      tags: true,
      inputOnFocus: true,
      label: ' {gray-fg}Type a message (Press [i/Enter] to type){/} ',
      border: {
        type: 'line'
      },
      style: {
        bg: 'black',
        transparent: false,
        border: {
          fg: '#555555'
        },
        fg: 'white',
        label: {
          fg: 'white'
        }
      }
    });

    this.qrBox = blessed.box({
      top: 'center',
      left: 'center',
      width: 66,
      height: 36,
      tags: false,
      wrap: false,
      hidden: true,
      border: {
        type: 'line'
      },
      style: {
        border: {
          fg: '#25D366'
        },
        bg: 'black',
        fg: 'white'
      },
      align: 'center'
    });

    this.menuBox = blessed.list({
      top: 'center',
      left: 'center',
      width: 58,
      height: 10,
      tags: true,
      hidden: true,
      border: {
        type: 'line'
      },
      label: ' {bold}{green-fg}⚙️ Configuración / Modelo de Voxtype{/} ',
      style: {
        bg: 'black',
        fg: 'white',
        border: {
          fg: '#00E676'
        },
        selected: {
          bg: '#1E3326',
          fg: '#00E676',
          bold: true
        },
        item: {
          bg: 'black',
          fg: 'white'
        }
      },
      keys: false,
      mouse: true
    });

    this.screen.append(this.header);
    this.screen.append(this.chatList);
    this.screen.append(this.chatHeader);
    this.screen.append(this.messageBox);
    this.screen.append(this.audioBar);
    this.screen.append(this.inputBox);
    this.screen.append(this.qrBox);
    this.screen.append(this.menuBox);

    this.setupKeybindings();
    this.loadCachedChats();
    this.chatList.focus();

    this.screen.on('render', () => {
      this.renderKittyImages();
    });

    this.screen.render();
  }

  private setupKeybindings() {
    this.screen.key(['C-c'], () => {
      this.audioPlayer.stop();
      this.waService.disconnect();
      process.stdout.write(clearAllKittyImages());
      return process.exit(0);
    });

    this.screen.key(['m', 'M'], () => {
      if (this.activePanel !== 'input') {
        if (this.isMenuOpen) {
          this.closeMenu();
        } else {
          this.openMenu();
        }
      }
    });

    this.screen.key(['tab'], () => {
      if (this.activePanel === 'input' || this.isMenuOpen) return;

      if (this.activePanel === 'chats') {
        this.setFocus('messages');
      } else {
        this.setFocus('chats');
      }
    });

    this.screen.key(['up', 'k'], () => {
      if (this.isMenuOpen) {
        (this.menuBox as any).up(1);
        this.screen.render();
        return;
      }
      if (this.activePanel === 'chats') {
        (this.chatList as any).up(1);
        this.onChatSelectionChanged();
      } else if (this.activePanel === 'messages') {
        if (this.audioPlayer.isActive()) {
          this.audioPlayer.adjustSpeed('up');
        } else {
          this.selectPreviousMessage();
        }
      }
    });

    this.screen.key(['down', 'j'], () => {
      if (this.isMenuOpen) {
        (this.menuBox as any).down(1);
        this.screen.render();
        return;
      }
      if (this.activePanel === 'chats') {
        (this.chatList as any).down(1);
        this.onChatSelectionChanged();
      } else if (this.activePanel === 'messages') {
        if (this.audioPlayer.isActive()) {
          this.audioPlayer.adjustSpeed('down');
        } else {
          this.selectNextMessage();
        }
      }
    });

    this.screen.key(['left', 'h'], () => {
      if (this.isMenuOpen) return;
      if (this.activePanel === 'messages' && this.audioPlayer.isActive()) {
        this.audioPlayer.seek(-5);
      }
    });

    this.screen.key(['right', 'l'], () => {
      if (this.isMenuOpen) return;
      if (this.activePanel === 'messages' && this.audioPlayer.isActive()) {
        this.audioPlayer.seek(5);
      }
    });

    // Play/Pause audio with 'P' / 'p'
    this.screen.key(['p', 'P'], async () => {
      if (this.isMenuOpen) return;
      if (this.activePanel === 'messages' && this.selectedChat) {
        await this.handleAudioToggle();
      }
    });

    // Transcribe audio with 'T' / 't' via local voxtype
    this.screen.key(['t', 'T'], async () => {
      if (this.isMenuOpen) return;
      if (this.activePanel === 'messages' && this.selectedChat) {
        await this.handleAudioTranscribe();
      }
    });

    this.screen.key(['pageup'], async () => {
      if (this.isMenuOpen) return;
      if (this.activePanel === 'messages') {
        if (this.currentMessages.length > 0) {
          const step = 8;
          if (this.selectedMessageIndex <= step) {
            this.selectedMessageIndex = 0;
            await this.loadMoreOlderMessages();
          } else {
            this.selectedMessageIndex -= step;
            await this.loadMessagesForSelectedChat(true);
          }
          this.scrollToSelectedMessage();
        } else {
          await this.handleMessageScrollUp(25);
        }
      }
    });

    this.screen.key(['pagedown'], async () => {
      if (this.isMenuOpen) return;
      if (this.activePanel === 'messages') {
        if (this.currentMessages.length > 0) {
          const step = 8;
          this.selectedMessageIndex = Math.min(this.currentMessages.length - 1, this.selectedMessageIndex + step);
          await this.loadMessagesForSelectedChat(true);
          this.scrollToSelectedMessage();
        } else {
          this.messageBox.scroll(25);
          this.screen.render();
        }
      }
    });

    this.messageBox.on('wheelup', () => {
      if (this.isMenuOpen) return;
      if (this.activePanel === 'messages') {
        this.selectPreviousMessage();
      }
    });

    this.messageBox.on('wheeldown', () => {
      if (this.isMenuOpen) return;
      if (this.activePanel === 'messages') {
        this.selectNextMessage();
      }
    });

    // 1-6 reaction shortcuts on selected message or 1-3 in menu
    for (const key of ['1', '2', '3', '4', '5', '6']) {
      this.screen.key([key], async () => {
        if (this.isMenuOpen) {
          if (key === '1') this.selectVoxtypeModel('tiny');
          else if (key === '2') this.selectVoxtypeModel('base');
          else if (key === '3') this.selectVoxtypeModel('small');
          return;
        }
        if (this.activePanel === 'messages' && this.selectedChat && this.selectedMessageIndex >= 0) {
          const msg = this.currentMessages[this.selectedMessageIndex];
          if (msg) {
            const emoji = REACTION_MAP[key];
            const ok = await this.waService.sendReaction(this.selectedChat.id, msg, emoji);
            if (ok) {
              msg.reaction = emoji;
              this.updateHeader();
              await this.loadMessagesForSelectedChat(true);
            }
          }
        }
      });
    }

    // Open image/video/media
    this.screen.key(['o', 'O', 'v', 'V'], async () => {
      if (this.isMenuOpen) return;
      if (this.activePanel !== 'input' && this.selectedChat) {
        const selectedMsg = (this.selectedMessageIndex >= 0 && this.selectedMessageIndex < this.currentMessages.length)
          ? this.currentMessages[this.selectedMessageIndex]
          : null;
        await this.openMedia(selectedMsg);
      }
    });

    this.screen.key(['enter', 'r'], () => {
      if (this.isMenuOpen) {
        const idx = (this.menuBox as any).selected;
        if (idx === 0) this.selectVoxtypeModel('tiny');
        else if (idx === 1) this.selectVoxtypeModel('base');
        else if (idx === 2) this.selectVoxtypeModel('small');
        else this.closeMenu();
        return;
      }
      if (this.activePanel === 'messages' && this.selectedChat) {
        if (this.selectedMessageIndex >= 0 && this.selectedMessageIndex < this.currentMessages.length) {
          this.replyingTo = this.currentMessages[this.selectedMessageIndex];
        } else {
          this.replyingTo = null;
        }
        this.setFocus('input');
        this.inputBox.setValue('');
        this.inputBox.readInput();
      } else if (this.activePanel === 'chats' && this.selectedChat) {
        this.setFocus('input');
        this.inputBox.setValue('');
        this.inputBox.readInput();
      }
    });

    this.screen.key(['i'], () => {
      if (this.isMenuOpen) return;
      if (this.activePanel !== 'input' && this.selectedChat) {
        this.replyingTo = null;
        this.setFocus('input');
        this.inputBox.setValue('');
        this.inputBox.readInput();
      }
    });

    this.screen.key(['escape', 'Esc'], () => {
      if (this.isMenuOpen) {
        this.closeMenu();
        return;
      }
      if (this.audioPlayer.isActive()) {
        this.audioPlayer.stop();
        return;
      }
    });

    this.screen.key(['q'], () => {
      if (this.isMenuOpen) {
        this.closeMenu();
        return;
      }
      if (this.activePanel !== 'input') {
        if (this.audioPlayer.isActive()) {
          this.audioPlayer.stop();
          return;
        }
        this.waService.disconnect();
        process.stdout.write(clearAllKittyImages());
        return process.exit(0);
      }
    });

    this.inputBox.on('submit', async (text) => {
      const trimmed = text.trim();
      const replyTarget = this.replyingTo;
      this.replyingTo = null;
      this.inputBox.setValue('');
      this.inputBox.clearValue();
      this.setFocus('messages');
      this.screen.realloc();
      this.screen.render();

      if (trimmed && this.selectedChat) {
        try {
          if (replyTarget) {
            await this.waService.sendReplyMessage(this.selectedChat.id, trimmed, replyTarget);
          } else {
            await this.waService.sendMessage(this.selectedChat.id, trimmed);
          }
          await this.loadMessagesForSelectedChat(false);
        } catch (err: any) {
          this.updateStatus('error', err?.message || 'Send failed');
        }
      }
      this.screen.realloc();
      this.screen.render();
    });

    this.inputBox.on('cancel', () => {
      this.replyingTo = null;
      this.inputBox.setValue('');
      this.inputBox.clearValue();
      this.setFocus('messages');
      this.screen.realloc();
      this.screen.render();
    });
  }

  private resolveAudioFile(msgId: string, mediaPath?: string): string | null {
    if (mediaPath && fs.existsSync(mediaPath)) return mediaPath;
    const mediaDir = this.waService.getMediaDir();
    for (const ext of ['ogg', 'mp3', 'm4a', 'wav', 'aac', 'opus', 'jpg']) {
      const candidate = path.join(mediaDir, `${msgId}.${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  private async handleAudioToggle() {
    const selectedMsg = (this.selectedMessageIndex >= 0 && this.selectedMessageIndex < this.currentMessages.length)
      ? this.currentMessages[this.selectedMessageIndex]
      : null;

    if (selectedMsg && selectedMsg.kind === 'audio') {
      if (this.audioPlayer.getActiveMsgId() === selectedMsg.id) {
        this.audioPlayer.togglePause();
        return;
      }

      let audioFile = this.resolveAudioFile(selectedMsg.id, selectedMsg.mediaPath);

      if (!audioFile) {
        this.header.setContent(' {bold}{yellow-fg}● Downloading audio from WhatsApp...{/}');
        this.screen.render();
        const dl = await this.waService.downloadMediaForMessage(selectedMsg.id);
        if (dl && fs.existsSync(dl)) {
          audioFile = dl;
        }
      }

      if (audioFile && fs.existsSync(audioFile)) {
        await this.audioPlayer.play(audioFile, selectedMsg.id);
      } else {
        this.header.setContent(' {bold}{red-fg}● Could not download or play audio{/}');
        this.screen.render();
      }
    } else if (this.audioPlayer.isActive()) {
      this.audioPlayer.togglePause();
    }
  }

  private async handleAudioTranscribe() {
    if (this.isTranscribing) return;

    const selectedMsg = (this.selectedMessageIndex >= 0 && this.selectedMessageIndex < this.currentMessages.length)
      ? this.currentMessages[this.selectedMessageIndex]
      : null;

    if (!selectedMsg || selectedMsg.kind !== 'audio') {
      this.header.setContent(' {bold}{yellow-fg}● Select an audio message to transcribe with [T]{/}');
      this.screen.render();
      return;
    }

    let audioFile = this.resolveAudioFile(selectedMsg.id, selectedMsg.mediaPath);

    if (!audioFile) {
      this.header.setContent(' {bold}{yellow-fg}● Downloading audio for transcription...{/}');
      this.screen.render();
      const dl = await this.waService.downloadMediaForMessage(selectedMsg.id);
      if (dl && fs.existsSync(dl)) {
        audioFile = dl;
      }
    }

    if (!audioFile || !fs.existsSync(audioFile)) {
      this.header.setContent(' {bold}{red-fg}● Could not download audio for transcription{/}');
      this.screen.render();
      return;
    }

    this.isTranscribing = true;
    this.header.setContent(` {bold}{yellow-fg}● Transcribiendo audio con Voxtype (${this.voxtypeModel.toUpperCase()})...{/}`);
    this.screen.render();

    try {
      const transcribed = await transcribeAudioWithVoxtype(audioFile, this.voxtypeModel);
      if (transcribed && transcribed.trim() !== '') {
        selectedMsg.transcription = transcribed.trim();
        this.db.saveMessage(selectedMsg);
        this.header.setContent(` {bold}{green-fg}● Transcripción completada (${this.voxtypeModel}): "${transcribed.trim().slice(0, 35)}..."{/}`);
        await this.loadMessagesForSelectedChat(true);
        if (this.audioPlayer.isActive()) {
          this.renderAudioBar(this.audioPlayer.getState());
        }
      } else {
        this.header.setContent(' {bold}{yellow-fg}● Transcripción finalizada: No se detectó voz{/}');
        this.screen.render();
      }
    } catch (err: any) {
      this.header.setContent(` {bold}{red-fg}● Error al transcribir: ${err?.message || 'voxtype error'}{/}`);
      this.screen.render();
    } finally {
      this.isTranscribing = false;
    }
  }

  private openMenu() {
    if (this.isMenuOpen) return;
    this.isMenuOpen = true;
    this.renderMenuItems();
    this.menuBox.show();
    this.menuBox.focus();
    this.screen.render();
  }

  private renderMenuItems() {
    const isTiny = this.voxtypeModel === 'tiny';
    const isBase = this.voxtypeModel === 'base';
    const isSmall = this.voxtypeModel === 'small';

    const check = (active: boolean) => active ? ' {bold}{green-fg}[✓ Activo]{/}' : ' {gray-fg}[ ]{/}';

    const items = [
      ` 1. Tiny Multi  (74 MB  - Ultra Rápido)${check(isTiny)}`,
      ` 2. Base Multi  (141 MB - Balanceado)${check(isBase)}`,
      ` 3. Small Multi (465 MB - Mayor Precisión)${check(isSmall)}`,
      ` {gray-fg}─── [Esc / q] Cerrar Menú ───{/}`
    ];

    this.menuBox.setItems(items);
    const activeIdx = isTiny ? 0 : (isBase ? 1 : 2);
    (this.menuBox as any).select(activeIdx);
  }

  private selectVoxtypeModel(model: 'tiny' | 'base' | 'small') {
    this.voxtypeModel = model;
    this.db.setSetting('voxtype_model', model);
    const names: Record<string, string> = {
      tiny: 'Tiny Multi (74 MB)',
      base: 'Base Multi (141 MB)',
      small: 'Small Multi (465 MB)'
    };
    this.closeMenu();
    this.header.setContent(` {bold}{green-fg}● Modelo de Voxtype cambiado a: ${names[model]}{/}`);
    this.screen.render();
  }

  private closeMenu() {
    if (!this.isMenuOpen) return;
    this.isMenuOpen = false;
    this.menuBox.hide();
    this.setFocus(this.activePanel);
    this.screen.render();
  }

  private renderAudioBar(state: AudioState | null) {
    if (!state) {
      this.audioBar.hide();
      this.messageBox.height = '100%-7';
      this.updateHeader();
      this.screen.render();
      return;
    }

    const msg = this.currentMessages.find(m => m.id === state.msgId);
    const sender = msg ? msg.senderName : 'Audio';

    const progress = state.duration > 0 ? Math.min(1, state.currentTime / state.duration) : 0;
    const barWidth = 24;
    const filled = Math.round(progress * barWidth);
    const bar = '━'.repeat(filled) + '●' + '─'.repeat(Math.max(0, barWidth - filled));

    const curTime = formatSeconds(state.currentTime);
    const durTime = formatSeconds(state.duration);
    const statusIcon = state.isPlaying ? '{green-fg}▶ Playing{/}' : '{yellow-fg}⏸ Paused{/}';
    const controls = ` ${statusIcon} {bold}@${sender}{/} {cyan-fg}[${bar}]{/} {bold}${curTime}{/}/{gray-fg}${durTime}{/} {magenta-fg}[${state.speed}x]{/} | {gray-fg}[P] Pause [←/→] ±5s [↑/↓] Speed [T] Transcribe [Esc] Close{/}`;

    if (msg?.transcription) {
      this.audioBar.height = 4;
      this.messageBox.height = '100%-11';
      const transSnippet = sanitizeTextForTui(msg.transcription).replace(/\n/g, ' ');
      const content = `${controls}\n {yellow-fg}🎤 "${blescape(transSnippet)}"{/}`;
      this.audioBar.setContent(content);
    } else {
      this.audioBar.height = 3;
      this.messageBox.height = '100%-10';
      this.audioBar.setContent(controls);
    }

    this.audioBar.show();
    this.updateHeader();
    this.screen.render();
  }

  private async selectPreviousMessage() {
    if (this.currentMessages.length === 0) return;

    if (this.selectedMessageIndex <= 0) {
      await this.loadMoreOlderMessages();
    } else {
      this.selectedMessageIndex--;
      await this.loadMessagesForSelectedChat(true);
      this.scrollToSelectedMessage();
    }
  }

  private async selectNextMessage() {
    if (this.currentMessages.length === 0) return;

    if (this.selectedMessageIndex < this.currentMessages.length - 1) {
      this.selectedMessageIndex++;
      await this.loadMessagesForSelectedChat(true);
      this.scrollToSelectedMessage();
    }
  }

  private scrollToSelectedMessage() {
    if (this.selectedMessageIndex < 0 || this.selectedMessageIndex >= this.currentMessages.length) return;
    const msg = this.currentMessages[this.selectedMessageIndex];
    if (!msg) return;

    const clines = (this.messageBox as any)._clines || [];
    const tag = `__MSG_${msg.id}__`;
    const lineIdx = clines.findIndex((l: string) => l.includes(tag));
    if (lineIdx === -1) return;

    const childBase = (this.messageBox as any).childBase || 0;
    const visibleHeight = (this.messageBox as any).height - 2;

    if (lineIdx < childBase) {
      (this.messageBox as any).childBase = lineIdx;
      this.messageBox.scrollTo(lineIdx);
      this.screen.render();
    } else if (lineIdx >= childBase + visibleHeight - 2) {
      const target = Math.max(0, lineIdx - visibleHeight + 3);
      (this.messageBox as any).childBase = target;
      this.messageBox.scrollTo(target);
      this.screen.render();
    }
  }

  private async handleMessageScrollUp(lines: number) {
    if (!this.selectedChat) return;

    const currentScroll = (this.messageBox as any).childBase || 0;
    if (currentScroll <= 1 && !this.isLoadingOlder) {
      await this.loadMoreOlderMessages();
    } else {
      this.messageBox.scroll(-lines);
      this.screen.render();
    }
  }

  private async loadMoreOlderMessages() {
    if (!this.selectedChat || this.isLoadingOlder) return;
    this.isLoadingOlder = true;

    const chatId = this.selectedChat.id;
    const currentLimit = this.chatMessageLimits.get(chatId) || 50;
    const countInDb = this.db.getMessageCount(chatId);

    const topMsgId = this.currentMessages[0]?.id;

    if (currentLimit >= countInDb) {
      this.updateSyncProgress('Loading older messages from WhatsApp...');
      await this.waService.fetchOlderMessages(chatId, 50);
    }

    this.chatMessageLimits.set(chatId, currentLimit + 50);

    await this.loadMessagesForSelectedChat(true);

    if (topMsgId) {
      const newIdx = this.currentMessages.findIndex(m => m.id === topMsgId);
      if (newIdx !== -1) {
        this.selectedMessageIndex = Math.max(0, newIdx - 1);
      }
    }

    this.scrollToSelectedMessage();
    this.isLoadingOlder = false;
  }

  private async openMedia(targetMsg?: Message | null) {
    if (!this.selectedChat) return;
    try {
      let mediaMsg: Message | undefined;

      if (targetMsg && (targetMsg.kind === 'image' || targetMsg.kind === 'sticker' || targetMsg.kind === 'video')) {
        mediaMsg = targetMsg;
      } else {
        const msgs = this.db.getMessages(this.selectedChat.id, 50);
        const mediaMsgs = msgs.slice().reverse().filter(m => m.kind === 'image' || m.kind === 'sticker' || m.kind === 'video');

        if (mediaMsgs.length === 0) {
          this.header.setContent(' {bold}{yellow-fg}● No media found in this chat{/}');
          this.screen.render();
          return;
        }
        mediaMsg = mediaMsgs[0];
      }

      let targetPath: string | undefined;

      if (mediaMsg.mediaPath && fs.existsSync(mediaMsg.mediaPath)) {
        targetPath = mediaMsg.mediaPath;
      } else {
        const checkJpg = path.join(this.waService.getMediaDir(), `${mediaMsg.id}.jpg`);
        const checkWebp = path.join(this.waService.getMediaDir(), `${mediaMsg.id}.webp`);
        const checkMp4 = path.join(this.waService.getMediaDir(), `${mediaMsg.id}.mp4`);
        if (fs.existsSync(checkJpg)) targetPath = checkJpg;
        else if (fs.existsSync(checkWebp)) targetPath = checkWebp;
        else if (fs.existsSync(checkMp4)) targetPath = checkMp4;
      }

      if (!targetPath) {
        this.header.setContent(` {bold}{yellow-fg}● Downloading media for ${mediaMsg.senderName}...{/}`);
        this.screen.render();

        if (mediaMsg.rawMsg) {
          const dl = await this.waService.downloadMediaForMessage(mediaMsg.id);
          if (dl && fs.existsSync(dl)) {
            targetPath = dl;
          }
        }

        if (!targetPath) {
          await this.waService.resyncRecentChatHistory(this.selectedChat.id, 30);
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 200));
            const checkJpg = path.join(this.waService.getMediaDir(), `${mediaMsg.id}.jpg`);
            const checkWebp = path.join(this.waService.getMediaDir(), `${mediaMsg.id}.webp`);
            const checkMp4 = path.join(this.waService.getMediaDir(), `${mediaMsg.id}.mp4`);
            if (fs.existsSync(checkJpg)) {
              targetPath = checkJpg;
              break;
            }
            if (fs.existsSync(checkWebp)) {
              targetPath = checkWebp;
              break;
            }
            if (fs.existsSync(checkMp4)) {
              targetPath = checkMp4;
              break;
            }
          }
        }
      }

      if (targetPath && fs.existsSync(targetPath)) {
        try {
          const viewer = fs.existsSync('/usr/bin/imv') ? 'imv' : 'xdg-open';
          const child = spawn(viewer, [targetPath], { detached: true, stdio: 'ignore' });
          child.on('error', (err) => {
            this.header.setContent(` {bold}{red-fg}● Viewer error: ${err?.message || 'failed to spawn'}{/}`);
            this.screen.render();
          });
          child.unref();
          this.header.setContent(` {bold}{green-fg}● Opened ${mediaMsg.kind} (${mediaMsg.senderName}) in ${viewer}:{/} {gray-fg}${path.basename(targetPath)}{/}`);
          this.screen.render();
        } catch {
          // Ignored
        }
      } else {
        this.header.setContent(' {bold}{red-fg}● Could not download image from WhatsApp{/}');
        this.screen.render();
      }
    } catch {
      // Ignored
    }
  }

  private setFocus(panel: 'chats' | 'messages' | 'input') {
    this.activePanel = panel;

    this.chatList.style.border.fg = panel === 'chats' ? '#00E676' : '#555555';
    this.messageBox.style.border.fg = panel === 'messages' ? '#00E676' : '#555555';
    this.inputBox.style.border.fg = panel === 'input' ? '#00E676' : '#555555';

    if (panel === 'chats') {
      this.chatList.focus();
    } else if (panel === 'messages') {
      this.messageBox.focus();
    } else if (panel === 'input') {
      this.inputBox.focus();
    }

    this.updateHeader();
    this.screen.realloc();
    this.screen.render();
  }

  private updateHeader() {
    if (this.activePanel === 'input') {
      if (this.replyingTo) {
        const snippet = this.replyingTo.text.replace(/\n/g, ' ').slice(0, 35);
        this.header.setContent(` {bold}{cyan-fg}● Replying to ${this.replyingTo.senderName}:{/} "${snippet}..." | {gray-fg}[Enter] Send | [Esc] Cancel{/}`);
        this.inputBox.setLabel(` {bold}{cyan-fg}Replying to @${this.replyingTo.senderName}:{/} {gray-fg}"${blescape(snippet)}..." [Esc cancel]{/} `);
      } else {
        this.header.setContent(' {bold}{green-fg}● Type Message{/} | {gray-fg}[Enter] Send | [Esc] Cancel{/}');
        this.inputBox.setLabel(' {bold}{green-fg}Type a message{/} {gray-fg}[Enter send | Esc cancel]{/} ');
      }
    } else if (this.activePanel === 'messages') {
      const selectedMsg = this.selectedMessageIndex >= 0 ? this.currentMessages[this.selectedMessageIndex] : null;
      const isAudio = selectedMsg?.kind === 'audio';
      const audioTip = isAudio ? ` | {magenta-fg}[P] Audio [T] Voxtype (${this.voxtypeModel}){/}` : ` | {gray-fg}[T] Voxtype (${this.voxtypeModel}){/}`;
      const reactionInfo = selectedMsg ? ' | [1-6] React' : '';
      this.header.setContent(` {bold}{green-fg}● Mensajes{/} | [m] Menú${audioTip}${reactionInfo} | {gray-fg}[Enter/r] Responder | [Tab] Chats | [q] Salir{/}`);
      this.inputBox.setLabel(' {gray-fg}Presiona [i/Enter] para escribir{/} ');
    } else {
      this.header.setContent(` {bold}{green-fg}● WhatsApp Terminal{/} | [m] Menú | {gray-fg}[Tab] Mensajes | [↑/↓] Seleccionar Chat | [i/Enter] Escribir | [q] Salir{/}`);
      this.inputBox.setLabel(' {gray-fg}Presiona [i/Enter] para escribir{/} ');
    }
    this.screen.render();
  }

  private loadCachedChats() {
    this.chats = this.db.getChats();
    this.renderChatList();
  }

  public updateChats(chats: Chat[]) {
    this.chats = chats;
    this.renderChatList();
  }

  private renderChatList() {
    const items = this.chats.map((c) => {
      const isGrp = c.isGroup ? '{blue-fg}[G]{/} ' : '';
      const unread = c.unread > 0 ? ` {yellow-fg}(${c.unread}){/}` : '';
      const timeStr = c.lastMessageTime > 0 ? ` {gray-fg}${formatTimestamp24h(c.lastMessageTime)}{/}` : '';
      const sanitizedName = sanitizeTextForTui(c.name);
      const escapedName = blessed.escape(sanitizedName);
      return `${isGrp}${escapedName}${unread}${timeStr}`;
    });

    this.chatList.setItems(items);

    if (this.chats.length > 0) {
      const currentSelectedId = this.selectedChat?.id;
      let newIdx = 0;
      if (currentSelectedId) {
        const found = this.chats.findIndex(c => c.id === currentSelectedId);
        if (found !== -1) newIdx = found;
      }
      (this.chatList as any).select(newIdx);

      if (!this.selectedChat) {
        this.selectedChat = this.chats[newIdx];
        this.loadMessagesForSelectedChat(false);
      } else {
        this.selectedChat = this.chats[newIdx];
      }
    }

    this.screen.render();
  }

  private onChatSelectionChanged() {
    const selectedIdx = (this.chatList as any).selected;
    if (selectedIdx >= 0 && selectedIdx < this.chats.length) {
      this.selectedChat = this.chats[selectedIdx];
      this.screen.realloc();
      this.loadMessagesForSelectedChat(false);
      this.waService.syncChatMedia(this.selectedChat.id);
    }
  }

  public async loadMessagesForSelectedChat(preserveScroll = false) {
    try {
      if (!this.selectedChat) {
        this.chatHeader.setContent(' {bold}Select a chat from the left panel{/}');
        this.messageBox.setContent('No conversation selected');
        this.visibleMediaList = [];
        this.currentMessages = [];
        this.selectedMessageIndex = -1;
        this.lastRenderedKittyState = '';
        process.stdout.write(clearAllKittyImages());
        this.screen.render();
        return;
      }

      const isGrp = this.selectedChat.isGroup ? 'Group' : 'Direct';
      const sanitizedChatName = sanitizeTextForTui(this.selectedChat.name);
      const escapedChatName = blessed.escape(sanitizedChatName);
      this.chatHeader.setContent(` {bold}${escapedChatName}{/} {gray-fg}(${isGrp} - ${this.selectedChat.id}){/}`);

      const limit = this.chatMessageLimits.get(this.selectedChat.id) || 50;
      const msgs = this.db.getMessages(this.selectedChat.id, limit);

      const previouslySelectedMsgId = (this.selectedMessageIndex >= 0 && this.selectedMessageIndex < this.currentMessages.length)
        ? this.currentMessages[this.selectedMessageIndex]?.id
        : null;
      const prevChildBase = (this.messageBox as any).childBase || 0;

      this.currentMessages = msgs;

      if (msgs.length === 0) {
        this.selectedMessageIndex = -1;
        this.messageBox.setContent(' {gray-fg}~~~ No messages in this conversation yet. Press [i] or [Enter] to send a message. ~~~{/}');
        this.visibleMediaList = [];
        (this.messageBox as any).parseContent();
      } else {
        if (!preserveScroll || this.selectedMessageIndex === -1) {
          this.selectedMessageIndex = Math.max(0, msgs.length - 1);
        } else if (previouslySelectedMsgId) {
          const foundIdx = msgs.findIndex(m => m.id === previouslySelectedMsgId);
          if (foundIdx !== -1) {
            this.selectedMessageIndex = foundIdx;
          } else {
            this.selectedMessageIndex = Math.min(msgs.length - 1, Math.max(0, this.selectedMessageIndex));
          }
        } else {
          this.selectedMessageIndex = Math.min(msgs.length - 1, Math.max(0, this.selectedMessageIndex));
        }

        const renderedLines: string[] = [];
        const newMediaList: VisibleMedia[] = [];

        for (let i = 0; i < msgs.length; i++) {
          const m = msgs[i];
          const isSelected = this.activePanel === 'messages' && i === this.selectedMessageIndex;

          const timeStr = formatTimestamp24h(m.timestamp);
          const senderColor = m.fromMe ? 'cyan-fg' : 'green-fg';
          const senderName = m.fromMe ? 'Me' : m.senderName;
          const sanitizedSender = sanitizeTextForTui(senderName);
          const sanitizedText = sanitizeTextForTui(m.text);
          const escapedSender = blessed.escape(sanitizedSender);
          const escapedText = blessed.escape(sanitizedText);
          const reactionBadge = m.reaction ? ` {yellow-fg}[${m.reaction}]{/}` : '';

          // Add invisible message anchor tag for precise scrolling
          renderedLines.push(`{black-fg}__MSG_${m.id}__{/}`);

          // If message is a reply to another message, show quoted preview block
          if (m.quotedText) {
            const qSender = m.quotedSender ? `@${sanitizeTextForTui(m.quotedSender)}: ` : '';
            const qText = sanitizeTextForTui(m.quotedText).replace(/\n/g, ' ').slice(0, 45);
            renderedLines.push(`  {gray-fg}┌─ ${blescape(qSender)}${blescape(qText)}{/}`);
          }

          let out: string;
          if (isSelected) {
            out = `{white-bg}{black-fg} ► (${timeStr}) ${escapedSender}: ${escapedText}${reactionBadge} {/}`;
          } else {
            out = `  {gray-fg}(${timeStr}){/} {${senderColor}}{bold}${escapedSender}:{/} ${escapedText}${reactionBadge}`;
          }
          renderedLines.push(out);

          if (m.transcription) {
            const sanitizedTrans = sanitizeTextForTui(m.transcription);
            const escapedTrans = blessed.escape(sanitizedTrans);
            renderedLines.push(`    {yellow-fg}🎤 Transcripción:{/} "${escapedTrans}"`);
          }

          const isSticker = m.kind === 'sticker';
          const isMedia = m.kind === 'image' || isSticker;

          if (isMedia) {
            let mediaFile = m.mediaPath;
            if (!mediaFile || !fs.existsSync(mediaFile)) {
              const checkJpg = path.join(this.waService.getMediaDir(), `${m.id}.jpg`);
              const checkWebp = path.join(this.waService.getMediaDir(), `${m.id}.webp`);
              if (fs.existsSync(checkJpg)) mediaFile = checkJpg;
              else if (fs.existsSync(checkWebp)) mediaFile = checkWebp;
            }

            if (!mediaFile || !fs.existsSync(mediaFile)) {
              if (m.rawMsg) {
                this.waService.downloadMediaForMessage(m.id).then((dl) => {
                  if (dl) {
                    if (this.mediaReloadTimer) clearTimeout(this.mediaReloadTimer);
                    this.mediaReloadTimer = setTimeout(() => {
                      this.loadMessagesForSelectedChat(true);
                    }, 400);
                  }
                });
              }
            }

            if (mediaFile && fs.existsSync(mediaFile)) {
              // Stickers occupy 25% less width and height (75% size of regular images: 26 cols x 8 rows)
              const maxCols = isSticker ? 26 : 34;
              const maxRows = isSticker ? 8 : 11;

              const prepared = await prepareImageForKitty(mediaFile, maxCols, maxRows);
              if (prepared) {
                newMediaList.push({
                  msgId: m.id,
                  prepared
                });

                // Tag line serves as an exact wrapped line anchor in Blessed _clines
                renderedLines.push(`{black-fg}__MEDIA_${m.id}__{/}`);
                for (let r = 1; r < prepared.rows; r++) {
                  renderedLines.push(' ');
                }
              }
            }
          }
        }

        this.visibleMediaList = newMediaList;
        this.messageBox.setContent(renderedLines.join('\n'));
        (this.messageBox as any).parseContent();

        if (!preserveScroll) {
          this.messageBox.setScrollPerc(100);
        } else {
          (this.messageBox as any).childBase = prevChildBase;
          this.messageBox.scrollTo(prevChildBase);
        }
      }

      this.updateHeader();
      this.screen.render();
    } catch {
      // Ignored
    }
  }

  private renderKittyImages() {
    try {
      if (!this.selectedChat || this.visibleMediaList.length === 0) {
        if (this.lastRenderedKittyState !== 'empty') {
          process.stdout.write(clearAllKittyImages());
          this.lastRenderedKittyState = 'empty';
        }
        return;
      }

      const boxTop = (this.messageBox as any).atop || 4;
      const boxLeft = (this.messageBox as any).aleft || 25;
      const boxHeight = (this.messageBox as any).height || 17;
      const scrollOffset = (this.messageBox as any).childBase || 0;

      const contentTop = boxTop + 2;
      const contentLeft = boxLeft + 2;
      const contentHeight = boxHeight - 2;

      const topBound = contentTop;
      const bottomBound = contentTop + contentHeight - 1;

      const clines = (this.messageBox as any)._clines || [];

      const placements: Array<{ item: PreparedImage; screenX: number; screenY: number }> = [];
      const placementKeys: string[] = [];

      for (const item of this.visibleMediaList) {
        const tag = `__MEDIA_${item.msgId}__`;
        const actualLineIdx = clines.findIndex((l: string) => l.includes(tag));
        if (actualLineIdx === -1) continue;

        const relLine = actualLineIdx - scrollOffset;
        const screenY = contentTop + relLine;
        const screenX = contentLeft + 1;
        const screenBottom = screenY + item.prepared.rows - 1;

        // Only draw when the image fits inside the visible box area (no text overlap, no squashing)
        if (screenY >= topBound && screenBottom <= bottomBound) {
          placements.push({ item: item.prepared, screenX, screenY });
          placementKeys.push(`${item.msgId}@${screenX},${screenY}`);
        }
      }

      const newState = `${this.selectedChat.id}:${scrollOffset}:${placementKeys.join(';')}`;
      if (newState === this.lastRenderedKittyState) {
        return; // State has not changed — do NOT clear or redraw (eliminates flickering)
      }

      this.lastRenderedKittyState = newState;
      process.stdout.write(clearAllKittyImages());

      for (const p of placements) {
        const cmd = createKittyPlacement(p.item, p.screenX, p.screenY);
        process.stdout.write(cmd);
      }
    } catch {
      // Ignored
    }
  }

  public showQR(qrCodeStr: string) {
    try {
      const { qr, width, height } = renderQRToUnicode(qrCodeStr);
      const title = '  Scan QR Code with WhatsApp  \n  (Linked Devices -> Link a Device)  \n\n';
      this.qrBox.setContent(`${title}${qr}`);
      this.qrBox.width = width + 6;
      this.qrBox.height = height + 6;
      this.qrBox.show();
      this.screen.render();
    } catch {
      // Ignored
    }
  }

  public hideQR() {
    this.qrBox.hide();
    this.screen.render();
  }

  public updateStatus(status: ConnectionStatus, detail?: string) {
    if (status === 'connected') {
      this.hideQR();
      const user = detail ? ` | ${detail.split('@')[0]}` : '';
      this.header.setContent(` {bold}{green-fg}● Online{/}${user} | {gray-fg}[Tab] Switch | [↑/↓] Select | [P] Audio | [T] Voxtype | [Enter] Reply | [q] Quit{/}`);
    } else if (status === 'qr') {
      this.header.setContent(' {bold}{yellow-fg}● Scan QR Code{/} | {gray-fg}Waiting for phone scan...{/}');
    } else if (status === 'connecting') {
      this.header.setContent(' {bold}{yellow-fg}● Connecting...{/}');
    } else {
      const err = detail ? ` (${detail})` : '';
      this.header.setContent(` {bold}{red-fg}● Offline${err}{/} | {gray-fg}Reconnecting...{/}`);
    }
    this.screen.render();
  }

  public updateSyncProgress(info: string) {
    this.header.setContent(` {bold}{green-fg}● Online{/} | {yellow-fg}${info}{/} | {gray-fg}[Tab] Switch | [↑/↓] Select | [P] Audio | [Enter] Reply | [q] Quit{/}`);
    this.screen.render();
  }

  public onNewIncomingMessage(msg: Message) {
    if (this.selectedChat && this.selectedChat.id === msg.chatId) {
      this.loadMessagesForSelectedChat(true);
    }
  }
}
