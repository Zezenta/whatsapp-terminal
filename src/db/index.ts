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
    this.cleanBadNames();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        name TEXT,
        notify TEXT,
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
        kind TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_contacts_lid ON contacts(lid);
      CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
    `);
  }

  private cleanBadNames() {
    // Reset names that were saved as 'Me' or numeric raw IDs
    this.db.prepare(`
      UPDATE chats 
      SET name = '' 
      WHERE name = 'Me' 
         OR name GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*'
         OR name LIKE '%@%'
    `).run();
  }

  public saveContact(c: { id: string; name?: string; notify?: string; phone?: string; lid?: string }) {
    if (!c.id) return;
    const existing = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(c.id) as any;
    
    const name = c.name || existing?.name || '';
    const notify = c.notify || existing?.notify || '';
    const phone = c.phone || existing?.phone || (c.id.endsWith('@s.whatsapp.net') ? c.id.split('@')[0] : '');
    const lid = c.lid || existing?.lid || (c.id.endsWith('@lid') ? c.id.split('@')[0] : '');

    this.db.prepare(`
      INSERT INTO contacts (id, name, notify, phone, lid)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END,
        notify = CASE WHEN excluded.notify != '' THEN excluded.notify ELSE contacts.notify END,
        phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE contacts.phone END,
        lid = CASE WHEN excluded.lid != '' THEN excluded.lid ELSE contacts.lid END
    `).run(c.id, name, notify, phone, lid);

    const resolvedName = name || notify;
    if (resolvedName) {
      this.db.prepare(`
        UPDATE chats 
        SET name = ? 
        WHERE (id = ? OR id = ? OR id = ?) 
          AND (name = '' OR name = id OR name = 'Me' OR name LIKE '%@%' OR name GLOB '[0-9]*')
      `).run(resolvedName, c.id, phone ? `${phone}@s.whatsapp.net` : '', lid ? `${lid}@lid` : '');
    }
  }

  public resolveContactName(id: string): string | null {
    if (!id) return null;

    // 1. Direct lookup in contacts table
    const direct = this.db.prepare('SELECT name, notify FROM contacts WHERE id = ?').get(id) as { name?: string, notify?: string } | undefined;
    if (direct?.name && direct.name.trim() !== '') return direct.name;
    if (direct?.notify && direct.notify.trim() !== '') return direct.notify;

    // 2. If ID is LID (e.g. 12345@lid)
    if (id.endsWith('@lid')) {
      const lidUser = id.split('@')[0];
      const byLid = this.db.prepare('SELECT name, notify, phone FROM contacts WHERE lid = ? OR id = ?').get(lidUser, id) as any;
      if (byLid?.name && byLid.name.trim() !== '') return byLid.name;
      if (byLid?.notify && byLid.notify.trim() !== '') return byLid.notify;
      if (byLid?.phone) return `+${byLid.phone}`;
    }

    // 3. If ID is Phone Number JID (e.g. 5939...@s.whatsapp.net)
    if (id.endsWith('@s.whatsapp.net')) {
      const pnUser = id.split('@')[0];
      const byPhone = this.db.prepare('SELECT name, notify FROM contacts WHERE phone = ? OR id = ?').get(pnUser, id) as any;
      if (byPhone?.name && byPhone.name.trim() !== '') return byPhone.name;
      if (byPhone?.notify && byPhone.notify.trim() !== '') return byPhone.notify;
    }

    // 4. Check if we received messages from this sender with a valid pushName
    const msg = this.db.prepare(`
      SELECT sender_name FROM messages 
      WHERE (chat_id = ? OR sender_id = ?) 
        AND from_me = 0 
        AND sender_name != '' 
        AND sender_name != 'Me' 
        AND sender_name NOT LIKE '%@%' 
        AND NOT (sender_name GLOB '[0-9]*' AND length(sender_name) > 8)
      ORDER BY timestamp DESC LIMIT 1
    `).get(id, id) as { sender_name: string } | undefined;

    if (msg?.sender_name && msg.sender_name.trim() !== '') {
      return msg.sender_name;
    }

    return null;
  }

  public saveChat(chat: Chat) {
    const existing = this.db.prepare('SELECT name, last_message_time FROM chats WHERE id = ?').get(chat.id) as { name: string, last_message_time: number } | undefined;
    
    // Ignore invalid/id-like names
    let cleanName = chat.name;
    if (!cleanName || cleanName === 'Me' || cleanName === chat.id || cleanName.includes('@') || (/^\d+$/.test(cleanName) && cleanName.length > 8)) {
      cleanName = existing?.name || '';
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
    stmt.run(chat.id, cleanName, chat.isGroup ? 1 : 0, chat.unread, lastTime);
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
      WHERE c.id NOT LIKE '%@newsletter' AND c.id != 'status@broadcast'
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
      
      const isIdLike = !displayName || 
        displayName === 'Me' || 
        displayName === r.id || 
        displayName.includes('@') || 
        (/^\d+$/.test(displayName) && displayName.length > 8);

      if (isIdLike) {
        const resolved = this.resolveContactName(r.id);
        if (resolved) {
          displayName = resolved;
        } else if (!r.is_group && r.id.endsWith('@s.whatsapp.net')) {
          const num = r.id.split('@')[0];
          displayName = `+${num}`;
        }
      }

      return {
        id: r.id,
        name: displayName || r.id.split('@')[0],
        isGroup: Boolean(r.is_group),
        unread: r.unread,
        lastMessageTime: r.last_message_time || 0
      };
    });
  }

  public saveMessage(msg: Message) {
    // Ensure chat exists
    const chatExists = this.db.prepare('SELECT id FROM chats WHERE id = ?').get(msg.chatId);
    if (!chatExists) {
      const isGroup = msg.chatId.endsWith('@g.us');
      const resolvedName = this.resolveContactName(msg.chatId) || '';
      this.saveChat({
        id: msg.chatId,
        name: resolvedName,
        isGroup,
        unread: msg.fromMe ? 0 : 1,
        lastMessageTime: msg.timestamp
      });
    }

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages (id, chat_id, sender_id, sender_name, timestamp, from_me, text, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      msg.id,
      msg.chatId,
      msg.senderId,
      msg.senderName,
      msg.timestamp,
      msg.fromMe ? 1 : 0,
      msg.text,
      msg.kind
    );

    // Update chat last message time
    this.db.prepare(`
      UPDATE chats SET last_message_time = MAX(COALESCE(last_message_time, 0), ?) WHERE id = ?
    `).run(msg.timestamp, msg.chatId);
  }

  public getMessages(chatId: string, limit = 150): Message[] {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?
      ) ORDER BY timestamp ASC
    `).all(chatId, limit) as Array<{
      id: string;
      chat_id: string;
      sender_id: string;
      sender_name: string;
      timestamp: number;
      from_me: number;
      text: string;
      kind: string;
    }>;

    return rows.map(r => {
      let senderName = r.sender_name;
      if (!r.from_me) {
        if (!senderName || senderName === 'Me' || senderName.includes('@') || (/^\d+$/.test(senderName) && senderName.length > 8)) {
          senderName = this.resolveContactName(r.sender_id) || (r.sender_id.endsWith('@s.whatsapp.net') ? `+${r.sender_id.split('@')[0]}` : r.sender_id.split('@')[0]);
        }
      } else {
        senderName = 'Me';
      }

      return {
        id: r.id,
        chatId: r.chat_id,
        senderId: r.sender_id,
        senderName,
        timestamp: r.timestamp,
        fromMe: Boolean(r.from_me),
        text: r.text,
        kind: r.kind
      };
    });
  }

  public getOldestMessage(chatId: string): Message | null {
    const row = this.db.prepare(`
      SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp ASC LIMIT 1
    `).get(chatId) as {
      id: string;
      chat_id: string;
      sender_id: string;
      sender_name: string;
      timestamp: number;
      from_me: number;
      text: string;
      kind: string;
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
      kind: row.kind
    };
  }

  public getMessageCount(chatId: string): number {
    const res = this.db.prepare(`
      SELECT COUNT(*) as count FROM messages WHERE chat_id = ?
    `).get(chatId) as { count: number } | undefined;
    return res?.count || 0;
  }

  public close() {
    this.db.close();
  }
}
