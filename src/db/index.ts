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
  }

  private initSchema() {
    this.db.exec(`
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
    `);
  }

  public saveChat(chat: Chat) {
    const existing = this.db.prepare('SELECT name, last_message_time FROM chats WHERE id = ?').get(chat.id) as { name: string, last_message_time: number } | undefined;
    
    const name = (chat.name && chat.name !== chat.id) ? chat.name : (existing?.name || chat.id.split('@')[0]);
    const lastTime = Math.max(chat.lastMessageTime || 0, existing?.last_message_time || 0);

    const stmt = this.db.prepare(`
      INSERT INTO chats (id, name, is_group, unread, last_message_time)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = CASE WHEN excluded.name != '' AND excluded.name != excluded.id THEN excluded.name ELSE chats.name END,
        unread = excluded.unread,
        last_message_time = MAX(COALESCE(chats.last_message_time, 0), excluded.last_message_time)
    `);
    stmt.run(chat.id, name, chat.isGroup ? 1 : 0, chat.unread, lastTime);
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

    return rows.map(r => ({
      id: r.id,
      name: r.name || r.id.split('@')[0],
      isGroup: Boolean(r.is_group),
      unread: r.unread,
      lastMessageTime: r.last_message_time || 0
    }));
  }

  public saveMessage(msg: Message) {
    // Ensure chat exists
    const chatExists = this.db.prepare('SELECT id FROM chats WHERE id = ?').get(msg.chatId);
    if (!chatExists) {
      const isGroup = msg.chatId.endsWith('@g.us');
      const name = isGroup ? msg.chatId.split('@')[0] : (msg.fromMe ? msg.chatId.split('@')[0] : msg.senderName);
      this.saveChat({
        id: msg.chatId,
        name,
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

    return rows.map(r => ({
      id: r.id,
      chatId: r.chat_id,
      senderId: r.sender_id,
      senderName: r.sender_name || r.sender_id.split('@')[0],
      timestamp: r.timestamp,
      fromMe: Boolean(r.from_me),
      text: r.text,
      kind: r.kind
    }));
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
