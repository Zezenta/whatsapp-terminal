import { LocalDatabase } from './db/index.js';
import { WhatsAppService } from './whatsapp/client.js';
import { TerminalUI } from './ui/index.js';

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
    }
  });

  ui = new TerminalUI(db, waService);

  await waService.connect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
