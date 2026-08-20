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

function formatTimestamp24h(timestamp: number): string {
  if (!timestamp || timestamp <= 0) return '';
  const d = new Date(timestamp * 1000);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}/${month} ${hours}:${minutes}`;
}

function sanitizeTextForTui(text: string): string {
  if (!text) return '';
  return text
    .replace(/[\uFE00-\uFE0F]/g, '')
    .replace(/[\u200B-\u200F\uFEFF]/g, '');
}

interface VisibleMedia {
  msgId: string;
  prepared: PreparedImage;
  lineOffset: number;
}

export class TerminalUI {
  private screen: blessed.Widgets.Screen;
  private header: blessed.Widgets.BoxElement;
  private chatList: blessed.Widgets.ListElement;
  private chatHeader: blessed.Widgets.BoxElement;
  private messageBox: blessed.Widgets.BoxElement;
  private inputBox: blessed.Widgets.TextboxElement;
  private qrBox: blessed.Widgets.BoxElement;

  private db: LocalDatabase;
  private waService: WhatsAppService;
  private chats: Chat[] = [];
  private selectedChat: Chat | null = null;
  private activePanel: 'chats' | 'messages' | 'input' = 'chats';
  private chatMessageLimits = new Map<string, number>();
  private isLoadingOlder = false;
  private visibleMediaList: VisibleMedia[] = [];

  constructor(database: LocalDatabase, whatsapp: WhatsAppService) {
    patchBlessedUnicode();

    this.db = database;
    this.waService = whatsapp;

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

    this.header = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      content: ' {bold}{green-fg}● WhatsApp Terminal{/} | {yellow-fg}Connecting...{/} | {gray-fg}[Tab] Switch | [o] Fullscreen Image | [i/Enter] Type | [q] Quit{/}',
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
      scrollable: true,
      alwaysScroll: true,
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

    this.inputBox = blessed.textbox({
      top: '100%-3',
      left: '32%',
      width: '68%',
      height: 3,
      tags: true,
      inputOnFocus: true,
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

    this.screen.append(this.header);
    this.screen.append(this.chatList);
    this.screen.append(this.chatHeader);
    this.screen.append(this.messageBox);
    this.screen.append(this.inputBox);
    this.screen.append(this.qrBox);

    this.setupKeybindings();
    this.loadCachedChats();
    this.chatList.focus();

    // Hook screen render event to redraw Kitty graphics on every frame
    this.screen.on('render', () => {
      this.renderKittyImages();
    });

    this.screen.render();
  }

  private setupKeybindings() {
    this.screen.key(['C-c'], () => {
      this.waService.disconnect();
      process.stdout.write(clearAllKittyImages());
      return process.exit(0);
    });

    this.screen.key(['tab'], () => {
      if (this.activePanel === 'input') return;

      if (this.activePanel === 'chats') {
        this.setFocus('messages');
      } else {
        this.setFocus('chats');
      }
    });

    this.screen.key(['up', 'k'], () => {
      if (this.activePanel === 'chats') {
        (this.chatList as any).up(1);
        this.onChatSelectionChanged();
      } else if (this.activePanel === 'messages') {
        this.handleMessageScrollUp(2);
      }
    });

    this.screen.key(['down', 'j'], () => {
      if (this.activePanel === 'chats') {
        (this.chatList as any).down(1);
        this.onChatSelectionChanged();
      } else if (this.activePanel === 'messages') {
        this.messageBox.scroll(2);
        this.screen.render();
      }
    });

    this.screen.key(['pageup'], () => {
      if (this.activePanel === 'messages') {
        this.handleMessageScrollUp(10);
      }
    });

    this.screen.key(['pagedown'], () => {
      if (this.activePanel === 'messages') {
        this.messageBox.scroll(10);
        this.screen.render();
      }
    });

    this.messageBox.on('wheelup', () => {
      if (this.activePanel === 'messages') {
        this.handleMessageScrollUp(3);
      }
    });

    this.messageBox.on('wheeldown', () => {
      if (this.activePanel === 'messages') {
        this.messageBox.scroll(3);
        this.screen.render();
      }
    });

    this.screen.key(['o', 'v'], async () => {
      if (this.activePanel !== 'input' && this.selectedChat) {
        await this.openLatestMedia();
      }
    });

    this.screen.key(['i', 'enter'], () => {
      if (this.activePanel !== 'input' && this.selectedChat) {
        this.setFocus('input');
        this.inputBox.setValue('');
        this.inputBox.readInput();
      }
    });

    this.screen.key(['q'], () => {
      if (this.activePanel !== 'input') {
        this.waService.disconnect();
        process.stdout.write(clearAllKittyImages());
        return process.exit(0);
      }
    });

    this.inputBox.on('submit', async (text) => {
      const trimmed = text.trim();
      if (trimmed && this.selectedChat) {
        try {
          await this.waService.sendMessage(this.selectedChat.id, trimmed);
          await this.loadMessagesForSelectedChat(false);
        } catch (err: any) {
          this.updateStatus('error', err?.message || 'Send failed');
        }
      }
      this.inputBox.setValue('');
      this.setFocus('chats');
    });

    this.inputBox.on('cancel', () => {
      this.inputBox.setValue('');
      this.setFocus('chats');
    });
  }

  private async handleMessageScrollUp(lines: number) {
    if (!this.selectedChat) return;

    const currentScroll = this.messageBox.getScroll();
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

    if (currentLimit >= countInDb) {
      this.updateSyncProgress('Loading older messages from WhatsApp...');
      await this.waService.fetchOlderMessages(chatId, 50);
    }

    this.chatMessageLimits.set(chatId, currentLimit + 50);

    const prevScrollHeight = (this.messageBox as any).getScrollHeight();
    await this.loadMessagesForSelectedChat(true);
    const newScrollHeight = (this.messageBox as any).getScrollHeight();

    const delta = newScrollHeight - prevScrollHeight;
    if (delta > 0) {
      this.messageBox.setScroll(delta);
    } else {
      this.messageBox.setScroll(0);
    }

    this.screen.render();
    this.isLoadingOlder = false;
  }

  private async openLatestMedia() {
    if (!this.selectedChat) return;
    const msgs = this.db.getMessages(this.selectedChat.id, 50);
    const mediaMsgs = msgs.slice().reverse().filter(m => m.kind === 'image' || m.kind === 'sticker' || m.kind === 'video');

    if (mediaMsgs.length === 0) {
      this.header.setContent(' {bold}{yellow-fg}● No media found in this chat{/}');
      this.screen.render();
      return;
    }

    let targetPath: string | undefined;

    for (const m of mediaMsgs) {
      if (m.mediaPath && fs.existsSync(m.mediaPath)) {
        targetPath = m.mediaPath;
        break;
      }
      const checkJpg = path.join(this.waService.getMediaDir(), `${m.id}.jpg`);
      const checkWebp = path.join(this.waService.getMediaDir(), `${m.id}.webp`);
      if (fs.existsSync(checkJpg)) {
        targetPath = checkJpg;
        break;
      }
      if (fs.existsSync(checkWebp)) {
        targetPath = checkWebp;
        break;
      }
    }

    if (!targetPath) {
      this.header.setContent(' {bold}{yellow-fg}● Downloading media from WhatsApp...{/}');
      this.screen.render();

      for (const m of mediaMsgs) {
        if (m.rawMsg) {
          const dl = await this.waService.downloadMediaForMessage(m.id);
          if (dl && fs.existsSync(dl)) {
            targetPath = dl;
            break;
          }
        }
      }

      if (!targetPath) {
        await this.waService.resyncRecentChatHistory(this.selectedChat.id, 30);
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 200));
          for (const m of mediaMsgs) {
            const checkJpg = path.join(this.waService.getMediaDir(), `${m.id}.jpg`);
            const checkWebp = path.join(this.waService.getMediaDir(), `${m.id}.webp`);
            if (fs.existsSync(checkJpg)) {
              targetPath = checkJpg;
              break;
            }
            if (fs.existsSync(checkWebp)) {
              targetPath = checkWebp;
              break;
            }
          }
          if (targetPath) break;
        }
      }
    }

    if (targetPath && fs.existsSync(targetPath)) {
      try {
        const viewer = fs.existsSync('/usr/bin/imv') ? 'imv' : 'xdg-open';
        const child = spawn(viewer, [targetPath], { detached: true, stdio: 'ignore' });
        child.unref();
        this.header.setContent(` {bold}{green-fg}● Opened image in ${viewer}:{/} {gray-fg}${targetPath}{/}`);
        this.screen.render();
      } catch {
        // Ignored
      }
    } else {
      this.header.setContent(' {bold}{red-fg}● Could not download image from WhatsApp{/}');
      this.screen.render();
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
      this.selectedChat = this.chats[newIdx];
      this.loadMessagesForSelectedChat(false);
    }

    this.screen.render();
  }

  private onChatSelectionChanged() {
    const selectedIdx = (this.chatList as any).selected;
    if (selectedIdx >= 0 && selectedIdx < this.chats.length) {
      this.selectedChat = this.chats[selectedIdx];
      this.loadMessagesForSelectedChat(false);
      this.waService.syncChatMedia(this.selectedChat.id);
    }
  }

  public async loadMessagesForSelectedChat(preserveScroll = false) {
    if (!this.selectedChat) {
      this.chatHeader.setContent(' {bold}Select a chat from the left panel{/}');
      this.messageBox.setContent('No conversation selected');
      this.visibleMediaList = [];
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

    if (msgs.length === 0) {
      this.messageBox.setContent(' {gray-fg}~~~ No messages in this conversation yet. Press [i] or [Enter] to send a message. ~~~{/}');
      this.visibleMediaList = [];
    } else {
      const renderedLines: string[] = [];
      const newMediaList: VisibleMedia[] = [];
      let currentLineCount = 0;

      for (const m of msgs) {
        const timeStr = formatTimestamp24h(m.timestamp);
        const senderColor = m.fromMe ? 'cyan-fg' : 'green-fg';
        const senderName = m.fromMe ? 'Me' : m.senderName;
        const sanitizedSender = sanitizeTextForTui(senderName);
        const sanitizedText = sanitizeTextForTui(m.text);
        const escapedSender = blessed.escape(sanitizedSender);
        const escapedText = blessed.escape(sanitizedText);

        let out = `{gray-fg}(${timeStr}){/} {${senderColor}}{bold}${escapedSender}:{/} ${escapedText}`;
        renderedLines.push(out);
        currentLineCount++;

        const isMedia = m.kind === 'image' || m.kind === 'sticker';
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
                  this.loadMessagesForSelectedChat(true);
                }
              });
            }
          }

          if (mediaFile && fs.existsSync(mediaFile)) {
            const prepared = await prepareImageForKitty(mediaFile, 36, 14);
            if (prepared) {
              newMediaList.push({
                msgId: m.id,
                prepared,
                lineOffset: currentLineCount
              });

              for (let r = 0; r < prepared.rows; r++) {
                renderedLines.push('  ');
                currentLineCount++;
              }
            }
          }
        }
      }

      this.visibleMediaList = newMediaList;
      this.messageBox.setContent(renderedLines.join('\n'));

      if (!preserveScroll) {
        this.messageBox.setScrollPerc(100);
      }
    }

    this.screen.render();
  }

  private renderKittyImages() {
    process.stdout.write(clearAllKittyImages());
    if (this.visibleMediaList.length === 0 || !this.selectedChat) return;

    const boxTop = (this.messageBox as any).atop || 4;
    const boxLeft = (this.messageBox as any).aleft || 25;
    const boxHeight = (this.messageBox as any).height || 17;
    const scrollOffset = this.messageBox.getScroll() || 0;

    const contentTop = boxTop + 1;
    const contentLeft = boxLeft + 2;
    const visibleHeight = boxHeight - 2;

    for (const item of this.visibleMediaList) {
      const relLine = item.lineOffset - scrollOffset;

      if (relLine >= 0 && relLine + item.prepared.rows <= visibleHeight) {
        const screenY = contentTop + relLine + 1;
        const screenX = contentLeft + 1;
        const cmd = createKittyPlacement(item.prepared, screenX, screenY);
        process.stdout.write(cmd);
      }
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
      this.header.setContent(` {bold}{green-fg}● Online{/}${user} | {gray-fg}[Tab] Switch | [o] Fullscreen Image | [i/Enter] Type | [q] Quit{/}`);
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
    this.header.setContent(` {bold}{green-fg}● Online{/} | {yellow-fg}${info}{/} | {gray-fg}[Tab] Switch | [o] Fullscreen Image | [i/Enter] Type | [q] Quit{/}`);
    this.screen.render();
  }

  public onNewIncomingMessage(msg: Message) {
    if (this.selectedChat && this.selectedChat.id === msg.chatId) {
      this.loadMessagesForSelectedChat(true);
    }
  }
}
