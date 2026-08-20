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
  private db: LocalDatabase;
  private authDir: string;
  private mediaDir: string;
  private events: WhatsAppServiceEvents;
  private isConnecting = false;
  private isSyncingHistory = false;
  private groupMetaFetching = new Set<string>();
  private downloadingMedia = new Set<string>();

  constructor(database: LocalDatabase, events: WhatsAppServiceEvents = {}, customAuthDir?: string) {
    this.db = database;
    this.events = events;
    this.authDir = customAuthDir || path.join(os.homedir(), '.config', 'whatsapp-terminal', 'auth_info');
    this.mediaDir = path.join(os.homedir(), '.config', 'whatsapp-terminal', 'media');
    fs.mkdirSync(this.authDir, { recursive: true });
    fs.mkdirSync(this.mediaDir, { recursive: true });
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

    const logPath = path.join(os.homedir(), '.config', 'whatsapp-terminal', 'debug.log');
    const logger = pino({ level: 'silent' }, pino.destination(logPath));

    this.sock = makeWASocket({
      version,
      logger,
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

    this.sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings }) => {
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
          const parsed = this.parseMessage(m);
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
        const parsed = this.parseMessage(m);
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

  private parseMessage(m: WAMessage): Message | null {
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

    const msg = m.message;
    if (!msg) return null;

    if (msg.conversation) {
      text = msg.conversation;
    } else if (msg.extendedTextMessage?.text) {
      text = msg.extendedTextMessage.text;
    } else if (msg.imageMessage) {
      text = '[Image]' + (msg.imageMessage.caption ? ` ${msg.imageMessage.caption}` : '');
      kind = 'image';
      this.triggerMediaDownload(m, 'jpg');
    } else if (msg.stickerMessage) {
      text = '[Sticker]';
      kind = 'sticker';
      this.triggerMediaDownload(m, 'webp');
    } else if (msg.videoMessage) {
      text = '[Video]' + (msg.videoMessage.caption ? ` ${msg.videoMessage.caption}` : '');
      kind = 'video';
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

    const msgId = m.key.id || Math.random().toString(36);
    const possibleMedia = path.join(this.mediaDir, `${msgId}.${kind === 'sticker' ? 'webp' : 'jpg'}`);
    if (fs.existsSync(possibleMedia)) {
      mediaPath = possibleMedia;
    }

    return {
      id: msgId,
      chatId,
      senderId,
      senderName,
      timestamp,
      fromMe,
      text,
      kind,
      mediaPath
    };
  }

  private triggerMediaDownload(m: WAMessage, ext: string) {
    const msgId = m.key.id;
    if (!msgId || this.downloadingMedia.has(msgId)) return;

    const mediaFile = path.join(this.mediaDir, `${msgId}.${ext}`);
    if (fs.existsSync(mediaFile)) return;

    this.downloadingMedia.add(msgId);

    downloadMediaMessage(m, 'buffer', {})
      .then(async (buffer) => {
        fs.writeFileSync(mediaFile, buffer);
        const preview = await generateAnsiThumbnail(buffer, 28, 12);
        
        const parsed = this.parseMessage(m);
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
