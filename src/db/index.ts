import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Chat, Message } from '../types/index.js';

export class LocalDatabase {
  private db: Database.Database;

  constructor(dbFilePath?: string) {
    const defaultPath = path.join(os.homedir(), '.config', 'whatsapp-terminal', 'data.db');
    const finalPath = dbFilePath || defaultPath;

    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    this.db = new Database(finalPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.initSchema();
    this.mergeDuplicateLidChats();
    this.linkExistingMediaFiles();
    this.migrateQuotesAndReactions();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        name TEXT,
        phone TEXT,
        lid TEXT
      );

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        name TEXT,
        is_group INTEGER,
        unread INTEGER,
        last_message_time INTEGER
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT,
        sender_id TEXT,
        sender_name TEXT,
        timestamp INTEGER,
        from_me INTEGER,
        text TEXT,
        kind TEXT,
        media_path TEXT,
        media_preview TEXT,
        raw_msg TEXT,
        reaction TEXT,
        transcription TEXT,
        quoted_msg_id TEXT,
        quoted_text TEXT,
        quoted_sender TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts(lid);
      CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
    `);

    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN media_path TEXT;');
    } catch {}
    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN media_preview TEXT;');
    } catch {}
    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN raw_msg TEXT;');
    } catch {}
    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN reaction TEXT;');
    } catch {}
    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN transcription TEXT;');
    } catch {}
    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN quoted_msg_id TEXT;');
    } catch {}
    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN quoted_text TEXT;');
    } catch {}
    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN quoted_sender TEXT;');
    } catch {}
  }

  public migrateQuotesAndReactions() {
    try {
      const messages = this.db.prepare('SELECT id, raw_msg FROM messages WHERE raw_msg IS NOT NULL').all() as Array<{ id: string; raw_msg: string }>;
      const updateStmt = this.db.prepare('UPDATE messages SET reaction = COALESCE(?, reaction), quoted_msg_id = COALESCE(?, quoted_msg_id), quoted_text = COALESCE(?, quoted_text), quoted_sender = COALESCE(?, quoted_sender) WHERE id = ?');
      const updateReactionStmt = this.db.prepare('UPDATE messages SET reaction = ? WHERE id = ?');

      for (const m of messages) {
        try {
          const raw = JSON.parse(m.raw_msg);
          const msg = raw.message;

          let reaction: string | null = null;
          if (raw.reactions && raw.reactions.length > 0) {
            const lastR = raw.reactions[raw.reactions.length - 1];
            if (lastR?.text) {
              reaction = lastR.text;
            }
          }

          if (msg?.reactionMessage) {
            const targetId = msg.reactionMessage.key?.id;
            const emoji = msg.reactionMessage.text;
            if (targetId && emoji) {
              updateReactionStmt.run(emoji, targetId);
            }
          }

          const ctx = msg?.extendedTextMessage?.contextInfo ||
                      msg?.imageMessage?.contextInfo ||
                      msg?.videoMessage?.contextInfo ||
                      msg?.stickerMessage?.contextInfo ||
                      msg?.documentMessage?.contextInfo;

          let quotedMsgId: string | null = null;
          let quotedSender: string | null = null;
          let quotedText: string | null = null;

          if (ctx) {
            quotedMsgId = ctx.stanzaId || null;
            const qSender = ctx.participant || ctx.remoteJid;
            if (qSender) {
              quotedSender = this.resolveContactName(qSender) || qSender.split('@')[0];
            }

            const q = ctx.quotedMessage;
            if (q) {
              quotedText = q.conversation ||
                           q.extendedTextMessage?.text ||
                           (q.imageMessage ? '[Image]' : '') ||
                           (q.stickerMessage ? '[Sticker]' : '') ||
                           (q.videoMessage ? '[Video]' : '') ||
                           (q.documentMessage ? '[Document]' : '') ||
                           '[Quoted Message]';
            }
          }

          if (reaction || quotedMsgId || quotedText || quotedSender) {
            updateStmt.run(reaction, quotedMsgId, quotedText, quotedSender, m.id);
          }
        } catch {}
      }
    } catch {}
  }

  public linkExistingMediaFiles() {
    const mediaDir = path.join(os.homedir(), '.config', 'whatsapp-terminal', 'media');
    if (!fs.existsSync(mediaDir)) return;
    try {
      const files = fs.readdirSync(mediaDir);
      const stmt = this.db.prepare('UPDATE messages SET media_path = ? WHERE id = ? AND (media_path IS NULL OR media_path = \'\')');
      for (const file of files) {
        if (file.endsWith('.jpg') || file.endsWith('.webp')) {
          const id = path.parse(file).name;
          const fullPath = path.join(mediaDir, file);
          stmt.run(fullPath, id);
        }
      }
    } catch {}
  }

  public getCanonicalChatId(id: string): string {
    if (!id) return '';
    if (id.endsWith('@g.us') || id.endsWith('@newsletter') || id === 'status@broadcast') {
      return id;
    }

    if (id.endsWith('@lid')) {
      const lidUser = id.split('@')[0];
      const contact = this.db.prepare('SELECT phone FROM contacts WHERE lid = ? OR id = ?').get(lidUser, id) as { phone?: string } | undefined;
      if (contact?.phone && contact.phone.trim() !== '') {
        return `${contact.phone.trim()}@s.whatsapp.net`;
      }
    }

    if (id.endsWith('@s.whatsapp.net')) {
      const pnUser = id.split('@')[0].split(':')[0];
      return `${pnUser}@s.whatsapp.net`;
    }

    return id;
  }

  public mergeDuplicateLidChats() {
    const contactsWithBoth = this.db.prepare('SELECT phone, lid, name FROM contacts WHERE phone != \'\' AND lid != \'\'').all() as Array<{
      phone: string;
      lid: string;
      name: string;
    }>;

    for (const c of contactsWithBoth) {
      const pnJid = `${c.phone}@s.whatsapp.net`;
      const lidJid = `${c.lid}@lid`;

      this.db.prepare('UPDATE messages SET chat_id = ? WHERE chat_id = ?').run(pnJid, lidJid);

      const lidChat = this.db.prepare('SELECT last_message_time, unread FROM chats WHERE id = ?').get(lidJid) as { last_message_time: number; unread: number } | undefined;
      if (lidChat) {
        this.db.prepare(`
          INSERT INTO chats (id, name, is_group, unread, last_message_time)
          VALUES (?, ?, 0, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = CASE WHEN excluded.name != '' THEN excluded.name ELSE chats.name END,
            unread = MAX(chats.unread, excluded.unread),
            last_message_time = MAX(COALESCE(chats.last_message_time, 0), excluded.last_message_time)
        `).run(pnJid, c.name, lidChat.unread, lidChat.last_message_time);

        this.db.prepare('DELETE FROM chats WHERE id = ?').run(lidJid);
      }
    }
  }

  public getNamedContactsCount(): number {
    const res = this.db.prepare('SELECT count(*) as c FROM contacts WHERE name IS NOT NULL AND length(name) > 0').get() as { c: number } | undefined;
    return res?.c || 0;
  }

  public saveContact(c: { id: string; name?: string; phone?: string; lid?: string }) {
    if (!c.id) return;
    const existing = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(c.id) as any;
    
    let validName = c.name?.trim() || existing?.name || '';
    if (validName === c.id || validName.includes('@') || (/^\d+$/.test(validName) && validName.length > 8) || validName === 'Me') {
      validName = existing?.name || '';
    }

    const phone = c.phone || existing?.phone || (c.id.endsWith('@s.whatsapp.net') ? c.id.split('@')[0].split(':')[0] : '');
    const lid = c.lid || existing?.lid || (c.id.endsWith('@lid') ? c.id.split('@')[0] : '');

    this.db.prepare(`
      INSERT INTO contacts (id, name, phone, lid)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END,
        phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE contacts.phone END,
        lid = CASE WHEN excluded.lid != '' THEN excluded.lid ELSE contacts.lid END
    `).run(c.id, validName, phone, lid);

    if (phone && lid) {
      this.mergeDuplicateLidChats();
    }

    if (validName) {
      const canonicalId = this.getCanonicalChatId(c.id);
      this.db.prepare('UPDATE chats SET name = ? WHERE id = ? AND is_group = 0').run(validName, canonicalId);
    }
  }

  public resolveContactName(id: string): string {
    if (!id) return '';

    const direct = this.db.prepare('SELECT name, phone FROM contacts WHERE id = ?').get(id) as { name?: string; phone?: string } | undefined;
    if (direct?.name && direct.name.trim() !== '') return direct.name.trim();

    if (id.endsWith('@lid')) {
      const lidUser = id.split('@')[0];
      const byLid = this.db.prepare('SELECT name, phone FROM contacts WHERE lid = ? OR id = ?').get(lidUser, id) as any;
      if (byLid?.name && byLid.name.trim() !== '') return byLid.name.trim();
      if (byLid?.phone && byLid.phone.trim() !== '') return `+${byLid.phone.trim()}`;
      return `+${lidUser}`;
    }

    if (id.endsWith('@s.whatsapp.net')) {
      const pnUser = id.split('@')[0].split(':')[0];
      const byPhone = this.db.prepare('SELECT name FROM contacts WHERE phone = ? OR id = ?').get(pnUser, id) as any;
      if (byPhone?.name && byPhone.name.trim() !== '') return byPhone.name.trim();
      return `+${pnUser}`;
    }

    return id.split('@')[0];
  }

  public saveChat(chat: Chat) {
    const canonicalId = this.getCanonicalChatId(chat.id);
    const existing = this.db.prepare('SELECT name, last_message_time FROM chats WHERE id = ?').get(canonicalId) as { name: string, last_message_time: number } | undefined;
    
    let cleanName = chat.name?.trim() || '';
    if (chat.isGroup) {
      if (!cleanName || cleanName === chat.id || cleanName.includes('@') || (/^\d+$/.test(cleanName) && cleanName.length > 8)) {
        cleanName = existing?.name || '';
      }
    } else {
      cleanName = this.resolveContactName(canonicalId);
    }

    const lastTime = Math.max(chat.lastMessageTime || 0, existing?.last_message_time || 0);

    const stmt = this.db.prepare(`
      INSERT INTO chats (id, name, is_group, unread, last_message_time)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = CASE WHEN excluded.name != '' THEN excluded.name ELSE chats.name END,
        unread = excluded.unread,
        last_message_time = MAX(COALESCE(chats.last_message_time, 0), excluded.last_message_time)
    `);
    stmt.run(canonicalId, cleanName, chat.isGroup ? 1 : 0, chat.unread, lastTime);
  }

  public getChats(): Chat[] {
    const rows = this.db.prepare(`
      SELECT 
        c.id, 
        c.name, 
        c.is_group, 
        c.unread, 
        MAX(COALESCE(c.last_message_time, 0), COALESCE(m.max_time, 0)) as last_message_time
      FROM chats c
      LEFT JOIN (
        SELECT chat_id, MAX(timestamp) as max_time FROM messages GROUP BY chat_id
      ) m ON c.id = m.chat_id
      WHERE c.id NOT LIKE '%@newsletter' AND c.id != 'status@broadcast' AND c.id NOT LIKE '%@lid'
      GROUP BY c.id
      ORDER BY last_message_time DESC
    `).all() as Array<{
      id: string;
      name: string;
      is_group: number;
      unread: number;
      last_message_time: number;
    }>;

    return rows.map(r => {
      let displayName = r.name;
      if (r.is_group) {
        if (!displayName || displayName === r.id || displayName.includes('@') || (/^\d+$/.test(displayName) && displayName.length > 8)) {
          displayName = `[Group] ${r.id.split('@')[0]}`;
        }
      } else {
        displayName = this.resolveContactName(r.id);
      }

      return {
        id: r.id,
        name: displayName,
        isGroup: Boolean(r.is_group),
        unread: r.unread,
        lastMessageTime: r.last_message_time || 0
      };
    });
  }

  public saveMessage(msg: Message) {
    const canonicalChatId = this.getCanonicalChatId(msg.chatId);

    const chatExists = this.db.prepare('SELECT id FROM chats WHERE id = ?').get(canonicalChatId);
    if (!chatExists) {
      const isGroup = canonicalChatId.endsWith('@g.us');
      const resolvedName = isGroup ? '' : this.resolveContactName(canonicalChatId);
      this.saveChat({
        id: canonicalChatId,
        name: resolvedName,
        isGroup,
        unread: msg.fromMe ? 0 : 1,
        lastMessageTime: msg.timestamp
      });
    }

    const stmt = this.db.prepare(`
      INSERT INTO messages (id, chat_id, sender_id, sender_name, timestamp, from_me, text, kind, media_path, media_preview, raw_msg, reaction, transcription, quoted_msg_id, quoted_text, quoted_sender)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        media_path = CASE WHEN excluded.media_path IS NOT NULL AND excluded.media_path != '' THEN excluded.media_path ELSE messages.media_path END,
        media_preview = CASE WHEN excluded.media_preview IS NOT NULL AND excluded.media_preview != '' THEN excluded.media_preview ELSE messages.media_preview END,
        raw_msg = CASE WHEN excluded.raw_msg IS NOT NULL AND excluded.raw_msg != '' THEN excluded.raw_msg ELSE messages.raw_msg END,
        reaction = CASE WHEN excluded.reaction IS NOT NULL THEN excluded.reaction ELSE messages.reaction END,
        transcription = CASE WHEN excluded.transcription IS NOT NULL AND excluded.transcription != '' THEN excluded.transcription ELSE messages.transcription END,
        quoted_msg_id = CASE WHEN excluded.quoted_msg_id IS NOT NULL THEN excluded.quoted_msg_id ELSE messages.quoted_msg_id END,
        quoted_text = CASE WHEN excluded.quoted_text IS NOT NULL THEN excluded.quoted_text ELSE messages.quoted_text END,
        quoted_sender = CASE WHEN excluded.quoted_sender IS NOT NULL THEN excluded.quoted_sender ELSE messages.quoted_sender END
    `);
    stmt.run(
      msg.id,
      canonicalChatId,
      msg.senderId,
      msg.senderName,
      msg.timestamp,
      msg.fromMe ? 1 : 0,
      msg.text,
      msg.kind,
      msg.mediaPath || null,
      msg.mediaPreview || null,
      msg.rawMsg || null,
      msg.reaction || null,
      msg.transcription || null,
      msg.quotedMsgId || null,
      msg.quotedText || null,
      msg.quotedSender || null
    );

    this.db.prepare(`
      UPDATE chats SET last_message_time = MAX(COALESCE(last_message_time, 0), ?) WHERE id = ?
    `).run(msg.timestamp, canonicalChatId);
  }

  public updateMessageReaction(msgId: string, reaction: string) {
    this.db.prepare('UPDATE messages SET reaction = ? WHERE id = ?').run(reaction || null, msgId);
  }

  public getRawMessage(id: string): string | null {
    const row = this.db.prepare('SELECT raw_msg FROM messages WHERE id = ?').get(id) as { raw_msg?: string } | undefined;
    return row?.raw_msg || null;
  }

  public getMessages(chatId: string, limit = 150): Message[] {
    const canonicalChatId = this.getCanonicalChatId(chatId);

    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages WHERE chat_id = ? OR chat_id = ? ORDER BY timestamp DESC LIMIT ?
      ) ORDER BY timestamp ASC
    `).all(canonicalChatId, chatId, limit) as Array<{
      id: string;
      chat_id: string;
      sender_id: string;
      sender_name: string;
      timestamp: number;
      from_me: number;
      text: string;
      kind: string;
      media_path?: string;
      media_preview?: string;
      raw_msg?: string;
      reaction?: string;
      transcription?: string;
      quoted_msg_id?: string;
      quoted_text?: string;
      quoted_sender?: string;
    }>;

    return rows.map(r => {
      let senderName = 'Me';
      if (!r.from_me) {
        senderName = this.resolveContactName(r.sender_id) || r.sender_name || r.sender_id.split('@')[0];
      }

      return {
        id: r.id,
        chatId: r.chat_id,
        senderId: r.sender_id,
        senderName,
        timestamp: r.timestamp,
        fromMe: Boolean(r.from_me),
        text: r.text,
        kind: r.kind,
        mediaPath: r.media_path || undefined,
        mediaPreview: r.media_preview || undefined,
        rawMsg: r.raw_msg || undefined,
        reaction: r.reaction || undefined,
        transcription: r.transcription || undefined,
        quotedMsgId: r.quoted_msg_id || undefined,
        quotedText: r.quoted_text || undefined,
        quotedSender: r.quoted_sender || undefined
      };
    });
  }

  public getOldestMessage(chatId: string): Message | null {
    const canonicalChatId = this.getCanonicalChatId(chatId);

    const row = this.db.prepare(`
      SELECT * FROM messages WHERE chat_id = ? OR chat_id = ? ORDER BY timestamp ASC LIMIT 1
    `).get(canonicalChatId, chatId) as {
      id: string;
      chat_id: string;
      sender_id: string;
      sender_name: string;
      timestamp: number;
      from_me: number;
      text: string;
      kind: string;
      media_path?: string;
      media_preview?: string;
      raw_msg?: string;
      reaction?: string;
      quoted_msg_id?: string;
      quoted_text?: string;
      quoted_sender?: string;
    } | undefined;

    if (!row) return null;
    return {
      id: row.id,
      chatId: row.chat_id,
      senderId: row.sender_id,
      senderName: row.sender_name || row.sender_id.split('@')[0],
      timestamp: row.timestamp,
      fromMe: Boolean(row.from_me),
      text: row.text,
      kind: row.kind,
      mediaPath: row.media_path || undefined,
      mediaPreview: row.media_preview || undefined,
      rawMsg: row.raw_msg || undefined,
      reaction: row.reaction || undefined,
      quotedMsgId: row.quoted_msg_id || undefined,
      quotedText: row.quoted_text || undefined,
      quotedSender: row.quoted_sender || undefined
    };
  }

  public getMessageCount(chatId: string): number {
    const canonicalChatId = this.getCanonicalChatId(chatId);
    const res = this.db.prepare(`
      SELECT COUNT(*) as count FROM messages WHERE chat_id = ? OR chat_id = ?
    `).get(canonicalChatId, chatId) as { count: number } | undefined;
    return res?.count || 0;
  }

  public close() {
    this.db.close();
  }
}
