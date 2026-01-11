/**
 * Types for the iMessage MCP server
 */

export interface SendblueMessage {
  id: string;
  content: string;
  from_number: string;
  to_number: string;
  status: string;
  date_sent: string;
  date_created: string;
  is_outbound: boolean;
  media_url?: string;
}

export interface SendblueResponse {
  messages: SendblueMessage[];
  has_more: boolean;
}

export interface ConversationMessage {
  id: number;
  phone_number: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface ProcessedMessage {
  message_id: string;
  processed_at: number;
}

export interface ServerConfig {
  sendblueApiKey: string;
  sendblueApiSecret: string;
  sendbluePhoneNumber: string;
  whitelist: string[];
  pollIntervalMs: number;
}

export interface PendingMessage {
  id: string;
  from_number: string;
  content: string;
  timestamp: string;
  receivedAt: number;  // Local timestamp when we received this message
  conversation_context: ConversationMessage[];
}
