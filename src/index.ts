import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { LocalDatabase } from './db/index.js';
import { WhatsAppService } from './whatsapp/client.js';
import { TerminalUI } from './ui/index.js';

const logDir = path.join(os.homedir(), '.config', 'whatsapp-terminal');
fs.mkdirSync(logDir, { recursive: true });
const crashLogPath = path.join(logDir, 'crash.log');

process.on('uncaughtException', (err) => {
  try {
    fs.appendFileSync(
      crashLogPath,
      `[${new Date().toISOString()}] Uncaught Exception: ${err.stack || err}\n`
    );
  } catch {}
});

process.on('unhandledRejection', (reason) => {
  try {
    fs.appendFileSync(
      crashLogPath,
      `[${new Date().toISOString()}] Unhandled Rejection: ${(reason as any)?.stack || reason}\n`
    );
  } catch {}
});

async function main() {
  const db = new LocalDatabase();

  let ui: TerminalUI;

  const waService = new WhatsAppService(db, {
    onQR: (qr) => {
      ui?.showQR(qr);
    },
    onStatusChange: (status, info) => {
      ui?.updateStatus(status, info);
    },
    onChatsUpdated: (chats) => {
      ui?.updateChats(chats);
    },
    onNewMessage: (msg) => {
      ui?.onNewIncomingMessage(msg);
    },
    onSyncProgress: (info) => {
      ui?.updateSyncProgress(info);
    }
  });

  ui = new TerminalUI(db, waService);

  await waService.connect();
}

main().catch((err) => {
  try {
    fs.appendFileSync(
      crashLogPath,
      `[${new Date().toISOString()}] Fatal main error: ${err.stack || err}\n`
    );
  } catch {}
  process.exit(1);
});
