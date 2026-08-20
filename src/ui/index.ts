import blessed from 'blessed';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { patchBlessedUnicode } from './unicode-patch.js';
import { renderQRToUnicode } from './qr.js';
import { Chat, Message, ConnectionStatus } from '../types/index.js';
import { LocalDatabase } from '../db/index.js';
import { WhatsAppService } from '../whatsapp/client.js';

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

  constructor(database: LocalDatabase, whatsapp: WhatsAppService) {
    // 0. Patch Blessed Unicode engine for modern double-width emojis
    patchBlessedUnicode();

    this.db = database;
    this.waService = whatsapp;

    // 1. Initialize Blessed Screen
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

    // 2. Top Header Bar
    this.header = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      content: ' {bold}{green-fg}● WhatsApp Terminal{/} | {yellow-fg}Connecting...{/} | {gray-fg}[Tab] Switch | [o] Open Image | [i/Enter] Type | [q] Quit{/}',
      style: {
        bg: 'black',
        fg: 'white',
        transparent: false
      }
    });

    // 3. Left Panel (Chat List)
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

    // 4. Right Panel: Chat Title Header
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

    // 5. Right Panel: Message Viewport
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

    // 6. Right Panel: Message Input Field
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

    // 7. QR Code Modal
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

    // Mount elements
    this.screen.append(this.header);
    this.screen.append(this.chatList);
    this.screen.append(this.chatHeader);
    this.screen.append(this.messageBox);
    this.screen.append(this.inputBox);
    this.screen.append(this.qrBox);

    this.setupKeybindings();
    this.loadCachedChats();
    this.chatList.focus();
    this.screen.render();
  }

  private setupKeybindings() {
    // Global Quit
    this.screen.key(['C-c'], () => {
      this.waService.disconnect();
      return process.exit(0);
    });

    // Tab Navigation
    this.screen.key(['tab'], () => {
      if (this.activePanel === 'input') return;

      if (this.activePanel === 'chats') {
        this.setFocus('messages');
      } else {
        this.setFocus('chats');
      }
    });

    // Up / Down / k / j navigation
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

    // PageUp / PageDown
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

    // Mouse wheel scroll on message box
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

    // 'o' or 'v' to open the latest image/sticker in system viewer
    this.screen.key(['o', 'v'], () => {
      if (this.activePanel !== 'input' && this.selectedChat) {
        this.openLatestMedia();
      }
    });

    // 'i' or 'Enter' to focus input box
    this.screen.key(['i', 'enter'], () => {
      if (this.activePanel !== 'input' && this.selectedChat) {
        this.setFocus('input');
        this.inputBox.setValue('');
        this.inputBox.readInput();
      }
    });

    // 'q' to quit when not typing
    this.screen.key(['q'], () => {
      if (this.activePanel !== 'input') {
        this.waService.disconnect();
        return process.exit(0);
      }
    });

    // Input submission
    this.inputBox.on('submit', async (text) => {
      const trimmed = text.trim();
      if (trimmed && this.selectedChat) {
        try {
          await this.waService.sendMessage(this.selectedChat.id, trimmed);
          this.loadMessagesForSelectedChat(false);
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

    // If we've shown all local messages, fetch older batch from WhatsApp
    if (currentLimit >= countInDb) {
      this.updateSyncProgress('Loading older messages from WhatsApp...');
      await this.waService.fetchOlderMessages(chatId, 50);
    }

    this.chatMessageLimits.set(chatId, currentLimit + 50);

    const prevScrollHeight = (this.messageBox as any).getScrollHeight();
    this.loadMessagesForSelectedChat(true);
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

  private openLatestMedia() {
    if (!this.selectedChat) return;
    const msgs = this.db.getMessages(this.selectedChat.id, 50);
    const mediaMsg = msgs.reverse().find(m => m.mediaPath && fs.existsSync(m.mediaPath));

    if (mediaMsg && mediaMsg.mediaPath) {
      try {
        const viewer = fs.existsSync('/usr/bin/imv') ? 'imv' : 'xdg-open';
        const child = spawn(viewer, [mediaMsg.mediaPath], { detached: true, stdio: 'ignore' });
        child.unref();
        this.header.setContent(` {bold}{green-fg}● Opened media in ${viewer}:{/} {gray-fg}${mediaMsg.mediaPath}{/}`);
        this.screen.render();
      } catch {
        // Ignored
      }
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
      let timeStr = '';
      if (c.lastMessageTime && c.lastMessageTime > 0) {
        const msgDate = new Date(c.lastMessageTime * 1000);
        const now = new Date();
        if (msgDate.toDateString() === now.toDateString()) {
          timeStr = ` {gray-fg}${msgDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{/}`;
        } else {
          timeStr = ` {gray-fg}${msgDate.toLocaleDateString([], { month: 'numeric', day: 'numeric' })}{/}`;
        }
      }
      const escapedName = blessed.escape(c.name);
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
    }
  }

  public loadMessagesForSelectedChat(preserveScroll = false) {
    if (!this.selectedChat) {
      this.chatHeader.setContent(' {bold}Select a chat from the left panel{/}');
      this.messageBox.setContent('No conversation selected');
      this.screen.render();
      return;
    }

    const isGrp = this.selectedChat.isGroup ? 'Group' : 'Direct';
    const escapedChatName = blessed.escape(this.selectedChat.name);
    this.chatHeader.setContent(` {bold}${escapedChatName}{/} {gray-fg}(${isGrp} - ${this.selectedChat.id}){/}`);

    const limit = this.chatMessageLimits.get(this.selectedChat.id) || 50;
    const msgs = this.db.getMessages(this.selectedChat.id, limit);

    if (msgs.length === 0) {
      this.messageBox.setContent(' {gray-fg}~~~ No messages in this conversation yet. Press [i] or [Enter] to send a message. ~~~{/}');
    } else {
      const rendered = msgs.map((m) => {
        const time = new Date(m.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const senderColor = m.fromMe ? 'cyan-fg' : 'green-fg';
        const senderName = m.fromMe ? 'Me' : m.senderName;
        const escapedSender = blessed.escape(senderName);
        const escapedText = blessed.escape(m.text);

        let out = `{gray-fg}(${time}){/} {${senderColor}}{bold}${escapedSender}:{/} ${escapedText}`;
        if (m.mediaPreview) {
          out += `\n${m.mediaPreview}`;
          if (m.mediaPath) {
            out += `\n  {gray-fg}[Image: ${blessed.escape(m.mediaPath)}] (Press 'o' to open in full screen){/}`;
          }
        }
        return out;
      }).join('\n');

      this.messageBox.setContent(rendered);
      if (!preserveScroll) {
        this.messageBox.setScrollPerc(100);
      }
    }

    this.screen.render();
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
      this.header.setContent(` {bold}{green-fg}● Online{/}${user} | {gray-fg}[Tab] Switch | [o] Open Image | [i/Enter] Type | [q] Quit{/}`);
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
    this.header.setContent(` {bold}{green-fg}● Online{/} | {yellow-fg}${info}{/} | {gray-fg}[Tab] Switch | [o] Open Image | [i/Enter] Type | [q] Quit{/}`);
    this.screen.render();
  }

  public onNewIncomingMessage(msg: Message) {
    if (this.selectedChat && this.selectedChat.id === msg.chatId) {
      this.loadMessagesForSelectedChat(true);
    }
  }
}
