import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  proto,
  WAMessage,
  WASocket,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Chat, Message, ConnectionStatus } from '../types/index.js';
import { LocalDatabase } from '../db/index.js';
import { generateAnsiThumbnail } from '../ui/media.js';

export interface WhatsAppServiceEvents {
  onQR?: (qr: string) => void;
  onStatusChange?: (status: ConnectionStatus, userJid?: string) => void;
  onNewMessage?: (msg: Message) => void;
  onChatsUpdated?: (chats: Chat[]) => void;
  onSyncProgress?: (info: string) => void;
}

function toNumber(t: any): number {
  if (t === null || t === undefined) return 0;
  if (typeof t === 'number') return isNaN(t) ? 0 : t;
  if (typeof t === 'object') {
    if (t.low !== undefined) return Number(t.low);
    if (typeof t.toNumber === 'function') return t.toNumber();
    return Number(t.toString()) || 0;
  }
  const parsed = Number(t);
  return isNaN(parsed) ? 0 : parsed;
}

export class WhatsAppService {
  private sock: WASocket | null = null;
  private logger: any;
  private db: LocalDatabase;
  private authDir: string;
  private mediaDir: string;
  private events: WhatsAppServiceEvents;
  private isConnecting = false;
  private isSyncingHistory = false;
  private groupMetaFetching = new Set<string>();
  private downloadingMedia = new Set<string>();
  private fetchingOlderForChat = new Set<string>();

  constructor(database: LocalDatabase, events: WhatsAppServiceEvents = {}, customAuthDir?: string) {
    this.db = database;
    this.events = events;
    this.authDir = customAuthDir || path.join(os.homedir(), '.config', 'whatsapp-terminal', 'auth_info');
    this.mediaDir = path.join(os.homedir(), '.config', 'whatsapp-terminal', 'media');
    fs.mkdirSync(this.authDir, { recursive: true });
    fs.mkdirSync(this.mediaDir, { recursive: true });

    const logPath = path.join(os.homedir(), '.config', 'whatsapp-terminal', 'debug.log');
    this.logger = pino({ level: 'silent' }, pino.destination(logPath));
  }

  public async connect(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;

    // Force snapshot if we have no saved contact names
    if (this.db.getNamedContactsCount() < 10 && fs.existsSync(this.authDir)) {
      try {
        const files = fs.readdirSync(this.authDir);
        for (const file of files) {
          if (file.startsWith('app-state-sync-version-')) {
            fs.unlinkSync(path.join(this.authDir, file));
          }
        }
      } catch {
        // Ignored
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] as [number, number, number] }));

    this.sock = makeWASocket({
      version,
      logger: this.logger,
      printQRInTerminal: false,
      auth: state,
      generateHighQualityLinkPreview: true,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.events.onStatusChange?.('qr');
        this.events.onQR?.(qr);
      }

      if (connection === 'open') {
        this.isConnecting = false;
        const userJid = this.sock?.user?.id || '';
        this.events.onStatusChange?.('connected', userJid);

        this.loadGroupsAndChats();

        try {
          await (this.sock as any)?.resyncAppState?.(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], true);
        } catch {
          // Ignored
        }

        setTimeout(() => {
          this.startBulkHistorySync();
        }, 3000);
      }

      if (connection === 'close') {
        this.isConnecting = false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        this.events.onStatusChange?.('disconnected', `Code: ${statusCode}`);
        if (shouldReconnect) {
          setTimeout(() => this.connect(), 3000);
        }
      }
    });

    this.sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        if (!c.id || c.id.endsWith('@newsletter')) continue;
        if (c.name) {
          const pn = c.phoneNumber ? c.phoneNumber.split('@')[0] : (c.id.endsWith('@s.whatsapp.net') ? c.id.split('@')[0] : '');
          const lid = c.lid ? c.lid.split('@')[0] : (c.id.endsWith('@lid') ? c.id.split('@')[0] : '');
          this.db.saveContact({
            id: c.id,
            name: c.name,
            phone: pn,
            lid
          });
        }
      }
      this.events.onChatsUpdated?.(this.db.getChats());
    });

    this.sock.ev.on('contacts.update', (updates) => {
      for (const c of updates) {
        if (!c.id) continue;
        if (c.name) {
          const pn = (c as any).phoneNumber ? (c as any).phoneNumber.split('@')[0] : (c.id.endsWith('@s.whatsapp.net') ? c.id.split('@')[0] : '');
          const lid = (c as any).lid ? (c as any).lid.split('@')[0] : (c.id.endsWith('@lid') ? c.id.split('@')[0] : '');
          this.db.saveContact({
            id: c.id,
            name: c.name,
            phone: pn,
            lid
          });
        }
      }
      this.events.onChatsUpdated?.(this.db.getChats());
    });

    this.sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, lidPnMappings }) => {
      if (lidPnMappings) {
        for (const map of lidPnMappings) {
          if (map.lid && map.pn) {
            const lidClean = map.lid.split('@')[0];
            const pnClean = map.pn.split('@')[0];
            this.db.saveContact({
              id: map.lid,
              phone: pnClean,
              lid: lidClean
            });
            this.db.saveContact({
              id: map.pn,
              phone: pnClean,
              lid: lidClean
            });
          }
        }
      }

      if (contacts) {
        for (const c of contacts) {
          if (!c.id || c.id.endsWith('@newsletter')) continue;
          if (c.name) {
            this.db.saveContact({
              id: c.id,
              name: c.name,
              phone: c.id.endsWith('@s.whatsapp.net') ? c.id.split('@')[0] : '',
              lid: (c as any).lid || (c.id.endsWith('@lid') ? c.id.split('@')[0] : '')
            });
          }
        }
      }

      if (chats) {
        for (const c of chats) {
          if (!c.id || c.id.endsWith('@newsletter') || c.id === 'status@broadcast') continue;
          const ts = toNumber(c.conversationTimestamp) || toNumber(c.lastMessageRecvTimestamp);
          const name = c.name || (c as any).displayName || '';
          this.db.saveChat({
            id: c.id,
            name,
            isGroup: c.id.endsWith('@g.us'),
            unread: c.unreadCount || 0,
            lastMessageTime: ts
          });
        }
      }

      if (messages) {
        for (const m of messages) {
          const parsed = await this.parseMessage(m);
          if (parsed) {
            this.db.saveMessage(parsed);
          }
        }
      }

      this.events.onChatsUpdated?.(this.db.getChats());
    });

    this.sock.ev.on('messages.upsert', async ({ messages: rawMessages }) => {
      for (const m of rawMessages) {
        if (!m.message) continue;
        const parsed = await this.parseMessage(m);
        if (parsed) {
          this.db.saveMessage(parsed);
          this.events.onNewMessage?.(parsed);
        }
      }
      this.events.onChatsUpdated?.(this.db.getChats());
    });

    this.sock.ev.on('chats.upsert', (chats) => {
      for (const c of chats) {
        if (!c.id || c.id.endsWith('@newsletter') || c.id === 'status@broadcast') continue;
        const ts = toNumber(c.conversationTimestamp) || toNumber(c.lastMessageRecvTimestamp);
        const name = c.name || (c as any).displayName || '';
        this.db.saveChat({
          id: c.id,
          name,
          isGroup: c.id.endsWith('@g.us'),
          unread: c.unreadCount || 0,
          lastMessageTime: ts
        });
      }
      this.events.onChatsUpdated?.(this.db.getChats());
    });
  }

  public async parseMessage(m: WAMessage): Promise<Message | null> {
    const chatId = m.key.remoteJid;
    if (!chatId || chatId === 'status@broadcast' || chatId.endsWith('@newsletter')) {
      return null;
    }

    const fromMe = Boolean(m.key.fromMe);
    const selfId = this.sock?.user?.id?.split(':')[0] + '@s.whatsapp.net' || 'me';
    const senderId = fromMe ? selfId : (m.key.participant || chatId);
    const timestamp = toNumber(m.messageTimestamp) || Math.floor(Date.now() / 1000);

    const senderName = fromMe ? 'Me' : (this.db.resolveContactName(senderId) || senderId.split('@')[0]);

    let text = '';
    let kind = 'text';
    let mediaPath: string | undefined;
    let mediaPreview: string | undefined;

    const msg = m.message;
    if (!msg) return null;

    const msgId = m.key.id || Math.random().toString(36);

    if (msg.conversation) {
      text = msg.conversation;
    } else if (msg.extendedTextMessage?.text) {
      text = msg.extendedTextMessage.text;
    } else if (msg.imageMessage) {
      text = '[Image]' + (msg.imageMessage.caption ? ` ${msg.imageMessage.caption}` : '');
      kind = 'image';
      if (msg.imageMessage.jpegThumbnail) {
        mediaPreview = await generateAnsiThumbnail(Buffer.from(msg.imageMessage.jpegThumbnail), 34, 16);
      }
      this.triggerMediaDownload(m, 'jpg');
    } else if (msg.stickerMessage) {
      text = '[Sticker]';
      kind = 'sticker';
      if (msg.stickerMessage.pngThumbnail) {
        mediaPreview = await generateAnsiThumbnail(Buffer.from(msg.stickerMessage.pngThumbnail), 26, 12);
      }
      this.triggerMediaDownload(m, 'webp');
    } else if (msg.videoMessage) {
      text = '[Video]' + (msg.videoMessage.caption ? ` ${msg.videoMessage.caption}` : '');
      kind = 'video';
      if (msg.videoMessage.jpegThumbnail) {
        mediaPreview = await generateAnsiThumbnail(Buffer.from(msg.videoMessage.jpegThumbnail), 34, 16);
      }
    } else if (msg.documentMessage) {
      text = `[Document] ${msg.documentMessage.fileName || 'file'}`;
      kind = 'document';
    } else if (msg.audioMessage) {
      text = '[Audio]';
      kind = 'audio';
    } else if (msg.pollCreationMessage) {
      text = `[Poll] ${msg.pollCreationMessage.name}`;
      kind = 'poll';
    } else {
      text = '[Message]';
    }

    const isGroup = chatId.endsWith('@g.us');
    let chatName = '';
    if (isGroup) {
      this.fetchMissingGroupMetadata(chatId);
    } else {
      chatName = this.db.resolveContactName(chatId);
    }

    this.db.saveChat({
      id: chatId,
      name: chatName,
      isGroup,
      unread: fromMe ? 0 : 1,
      lastMessageTime: timestamp
    });

    const possibleMedia = path.join(this.mediaDir, `${msgId}.${kind === 'sticker' ? 'webp' : 'jpg'}`);
    if (fs.existsSync(possibleMedia)) {
      mediaPath = possibleMedia;
      if (!mediaPreview) {
        mediaPreview = await generateAnsiThumbnail(possibleMedia, 34, 16);
      }
    }

    let rawMsg: string | undefined;
    try {
      rawMsg = JSON.stringify(m);
    } catch {}

    return {
      id: msgId,
      chatId,
      senderId,
      senderName,
      timestamp,
      fromMe,
      text,
      kind,
      mediaPath,
      mediaPreview,
      rawMsg
    };
  }

  private triggerMediaDownload(m: WAMessage, ext: string) {
    const msgId = m.key.id;
    if (!msgId || this.downloadingMedia.has(msgId)) return;

    const mediaFile = path.join(this.mediaDir, `${msgId}.${ext}`);
    if (fs.existsSync(mediaFile)) return;

    this.downloadingMedia.add(msgId);

    downloadMediaMessage(m, 'buffer', {}, {
      logger: this.logger,
      reuploadRequest: (msg) => this.sock!.updateMediaMessage(msg)
    })
      .then(async (buffer) => {
        fs.writeFileSync(mediaFile, buffer);
        const preview = await generateAnsiThumbnail(buffer, 34, 16);
        
        const parsed = await this.parseMessage(m);
        if (parsed) {
          parsed.mediaPath = mediaFile;
          parsed.mediaPreview = preview;
          this.db.saveMessage(parsed);
          this.events.onNewMessage?.(parsed);
        }
      })
      .catch(() => {})
      .finally(() => {
        this.downloadingMedia.delete(msgId);
      });
  }

  public async downloadMediaForMessage(msgId: string): Promise<string | null> {
    const possibleJpg = path.join(this.mediaDir, `${msgId}.jpg`);
    if (fs.existsSync(possibleJpg)) return possibleJpg;
    const possibleWebp = path.join(this.mediaDir, `${msgId}.webp`);
    if (fs.existsSync(possibleWebp)) return possibleWebp;

    const rawJson = this.db.getRawMessage(msgId);
    if (!rawJson) return null;

    try {
      const m = JSON.parse(rawJson) as WAMessage;
      const isSticker = Boolean(m.message?.stickerMessage);
      const ext = isSticker ? 'webp' : 'jpg';
      const targetFile = path.join(this.mediaDir, `${msgId}.${ext}`);

      const buffer = await downloadMediaMessage(m, 'buffer', {}, {
        logger: this.logger,
        reuploadRequest: (msg) => this.sock!.updateMediaMessage(msg)
      });
      fs.writeFileSync(targetFile, buffer);

      const preview = await generateAnsiThumbnail(buffer, 34, 16);
      const parsed = await this.parseMessage(m);
      if (parsed) {
        parsed.mediaPath = targetFile;
        parsed.mediaPreview = preview;
        this.db.saveMessage(parsed);
        this.events.onNewMessage?.(parsed);
      }

      return targetFile;
    } catch {
      return null;
    }
  }

  public async syncChatMedia(chatId: string) {
    const msgs = this.db.getMessages(chatId, 100);
    const missingRaw = msgs.filter(m => (m.kind === 'image' || m.kind === 'sticker') && !m.mediaPath && !m.rawMsg);
    
    if (missingRaw.length > 0) {
      await this.fetchOlderMessages(chatId, 50);
    } else {
      const withRaw = msgs.filter(m => (m.kind === 'image' || m.kind === 'sticker') && !m.mediaPath && m.rawMsg);
      for (const m of withRaw) {
        this.downloadMediaForMessage(m.id);
      }
    }
  }

  public async fetchOlderMessages(chatId: string, count = 50): Promise<number> {
    if (!this.sock || this.fetchingOlderForChat.has(chatId)) return 0;
    this.fetchingOlderForChat.add(chatId);

    try {
      const oldest = this.db.getOldestMessage(chatId);
      if (!oldest) return 0;

      this.events.onSyncProgress?.(`Fetching history for ${chatId.split('@')[0]}...`);

      await this.sock.fetchMessageHistory(
        count,
        {
          remoteJid: oldest.chatId,
          fromMe: oldest.fromMe,
          id: oldest.id
        },
        oldest.timestamp * 1000
      );

      this.events.onSyncProgress?.('Messages loaded');
      return count;
    } catch {
      return 0;
    } finally {
      this.fetchingOlderForChat.delete(chatId);
    }
  }

  public async fetchMissingGroupMetadata(chatId: string) {
    if (!this.sock || !chatId.endsWith('@g.us') || this.groupMetaFetching.has(chatId)) return;
    this.groupMetaFetching.add(chatId);

    try {
      const meta = await this.sock.groupMetadata(chatId);
      if (meta.subject) {
        this.db.saveChat({
          id: chatId,
          name: meta.subject,
          isGroup: true,
          unread: 0,
          lastMessageTime: 0
        });
        this.events.onChatsUpdated?.(this.db.getChats());
      }
    } catch {
      // Ignored
    } finally {
      this.groupMetaFetching.delete(chatId);
    }
  }

  private async loadGroupsAndChats() {
    if (!this.sock) return;

    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const [id, group] of Object.entries(groups)) {
        if (group.subject) {
          this.db.saveChat({
            id,
            name: group.subject,
            isGroup: true,
            unread: 0,
            lastMessageTime: 0
          });
        }
      }
      this.events.onChatsUpdated?.(this.db.getChats());
    } catch {
      // Ignored
    }
  }

  public async startBulkHistorySync(): Promise<void> {
    if (!this.sock || this.isSyncingHistory) return;
    this.isSyncingHistory = true;

    try {
      const chats = this.db.getChats();
      if (chats.length === 0) return;

      const totalToSync = Math.min(chats.length, 60);
      this.events.onSyncProgress?.(`Syncing history (${totalToSync} chats)...`);

      for (let i = 0; i < totalToSync; i++) {
        const chat = chats[i];
        const targetCount = i < 10 ? 100 : 10;
        const currentCount = this.db.getMessageCount(chat.id);

        if (chat.isGroup) {
          this.fetchMissingGroupMetadata(chat.id);
        }

        if (currentCount >= targetCount) {
          continue;
        }

        const oldest = this.db.getOldestMessage(chat.id);
        if (!oldest) {
          continue;
        }

        try {
          const needed = targetCount - currentCount;
          this.events.onSyncProgress?.(`Syncing [${i + 1}/${totalToSync}] ${chat.name} (${needed} msgs)...`);

          await this.sock.fetchMessageHistory(
            needed,
            {
              remoteJid: chat.id,
              fromMe: oldest.fromMe,
              id: oldest.id
            },
            oldest.timestamp * 1000
          );

          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch {
          // Continue with next chat
        }
      }

      this.events.onChatsUpdated?.(this.db.getChats());
      this.events.onSyncProgress?.('Sync complete');
    } finally {
      this.isSyncingHistory = false;
    }
  }

  public async sendMessage(chatId: string, text: string): Promise<Message | null> {
    if (!this.sock) {
      throw new Error('Not connected to WhatsApp');
    }

    const sent = await this.sock.sendMessage(chatId, { text });
    if (!sent) return null;

    const selfId = this.sock.user?.id?.split(':')[0] + '@s.whatsapp.net' || 'me';
    const timestamp = toNumber(sent.messageTimestamp) || Math.floor(Date.now() / 1000);

    const msg: Message = {
      id: sent.key.id || Math.random().toString(36),
      chatId,
      senderId: selfId,
      senderName: 'Me',
      timestamp,
      fromMe: true,
      text,
      kind: 'text'
    };

    this.db.saveMessage(msg);
    this.events.onNewMessage?.(msg);
    this.events.onChatsUpdated?.(this.db.getChats());
    return msg;
  }

  public disconnect() {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
  }
}
