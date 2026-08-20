import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  proto,
  WAMessage,
  WASocket
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Chat, Message, ConnectionStatus } from '../types/index.js';
import { LocalDatabase } from '../db/index.js';

export interface WhatsAppServiceEvents {
  onQR?: (qr: string) => void;
  onStatusChange?: (status: ConnectionStatus, userJid?: string) => void;
  onNewMessage?: (msg: Message) => void;
  onChatsUpdated?: (chats: Chat[]) => void;
  onSyncProgress?: (info: string) => void;
}

export class WhatsAppService {
  private sock: WASocket | null = null;
  private db: LocalDatabase;
  private authDir: string;
  private events: WhatsAppServiceEvents;
  private isConnecting = false;
  private isSyncingHistory = false;

  constructor(database: LocalDatabase, events: WhatsAppServiceEvents = {}, customAuthDir?: string) {
    this.db = database;
    this.events = events;
    this.authDir = customAuthDir || path.join(os.homedir(), '.config', 'whatsapp-terminal', 'auth_info');
    fs.mkdirSync(this.authDir, { recursive: true });
  }

  public async connect(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] as [number, number, number] }));

    // Log to file rather than stdout to keep Blessed TUI clean
    const logPath = path.join(os.homedir(), '.config', 'whatsapp-terminal', 'debug.log');
    const logger = pino({ level: 'silent' }, pino.destination(logPath));

    this.sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: state,
      generateHighQualityLinkPreview: true,
      syncFullHistory: true
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
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

        // Start background bulk history sync after connection stabilizes
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

    // History sync from WhatsApp (initial pairing or on-demand response)
    this.sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest, progress }) => {
      if (contacts) {
        for (const c of contacts) {
          if (!c.id || c.id.endsWith('@newsletter')) continue;
          const name = c.name || c.notify || c.verifiedName || '';
          if (name) {
            this.db.saveChat({
              id: c.id,
              name,
              isGroup: c.id.endsWith('@g.us'),
              unread: 0,
              lastMessageTime: 0
            });
          }
        }
      }

      if (chats) {
        for (const c of chats) {
          if (!c.id || c.id.endsWith('@newsletter') || c.id === 'status@broadcast') continue;
          this.db.saveChat({
            id: c.id,
            name: c.name || c.id.split('@')[0],
            isGroup: c.id.endsWith('@g.us'),
            unread: c.unreadCount || 0,
            lastMessageTime: Number(c.conversationTimestamp || Math.floor(Date.now() / 1000))
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
        this.db.saveChat({
          id: c.id,
          name: c.name || c.id.split('@')[0],
          isGroup: c.id.endsWith('@g.us'),
          unread: c.unreadCount || 0,
          lastMessageTime: Number(c.conversationTimestamp || Math.floor(Date.now() / 1000))
        });
      }
      this.events.onChatsUpdated?.(this.db.getChats());
    });

    this.sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) {
        if (!c.id || c.id.endsWith('@newsletter')) continue;
        const name = c.name || c.notify || c.verifiedName || '';
        if (name) {
          this.db.saveChat({
            id: c.id,
            name,
            isGroup: c.id.endsWith('@g.us'),
            unread: 0,
            lastMessageTime: 0
          });
        }
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
    const senderId = fromMe ? (this.sock?.user?.id?.split(':')[0] + '@s.whatsapp.net' || 'me') : (m.key.participant || chatId);
    const senderName = m.pushName || (fromMe ? 'Me' : senderId.split('@')[0]);
    const timestamp = Number(m.messageTimestamp || Math.floor(Date.now() / 1000));

    let text = '';
    let kind = 'text';

    const msg = m.message;
    if (!msg) return null;

    if (msg.conversation) {
      text = msg.conversation;
    } else if (msg.extendedTextMessage?.text) {
      text = msg.extendedTextMessage.text;
    } else if (msg.imageMessage) {
      text = '[Image]' + (msg.imageMessage.caption ? ` ${msg.imageMessage.caption}` : '');
      kind = 'image';
    } else if (msg.videoMessage) {
      text = '[Video]' + (msg.videoMessage.caption ? ` ${msg.videoMessage.caption}` : '');
      kind = 'video';
    } else if (msg.documentMessage) {
      text = `[Document] ${msg.documentMessage.fileName || 'file'}`;
      kind = 'document';
    } else if (msg.audioMessage) {
      text = '[Audio]';
      kind = 'audio';
    } else if (msg.stickerMessage) {
      text = '[Sticker]';
      kind = 'sticker';
    } else if (msg.pollCreationMessage) {
      text = `[Poll] ${msg.pollCreationMessage.name}`;
      kind = 'poll';
    } else {
      text = '[Message]';
    }

    // Update chat info in DB
    const isGroup = chatId.endsWith('@g.us');
    this.db.saveChat({
      id: chatId,
      name: isGroup ? chatId.split('@')[0] : senderName,
      isGroup,
      unread: fromMe ? 0 : 1,
      lastMessageTime: timestamp
    });

    return {
      id: m.key.id || Math.random().toString(36),
      chatId,
      senderId,
      senderName,
      timestamp,
      fromMe,
      text,
      kind
    };
  }

  private async loadGroupsAndChats() {
    if (!this.sock) return;

    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const [id, group] of Object.entries(groups)) {
        this.db.saveChat({
          id,
          name: group.subject || id.split('@')[0],
          isGroup: true,
          unread: 0,
          lastMessageTime: group.creation || Math.floor(Date.now() / 1000)
        });
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
      this.events.onSyncProgress?.(`Syncing history for ${totalToSync} chats...`);

      // Top 10 chats -> 100 messages
      // Next 50 chats -> 10 messages
      for (let i = 0; i < totalToSync; i++) {
        const chat = chats[i];
        const targetCount = i < 10 ? 100 : 10;
        const currentCount = this.db.getMessageCount(chat.id);

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

          // Delay 500ms between requests to avoid overloading the socket
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
    const timestamp = Number(sent.messageTimestamp || Math.floor(Date.now() / 1000));

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
