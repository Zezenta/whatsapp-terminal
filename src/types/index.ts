export interface Chat {
  id: string;
  name: string;
  isGroup: boolean;
  unread: number;
  lastMessageTime: number;
}

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  timestamp: number;
  fromMe: boolean;
  text: string;
  kind: string;
  mediaPath?: string;
  mediaPreview?: string;
  rawMsg?: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'qr' | 'connected' | 'error';
