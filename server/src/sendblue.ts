/**
 * Sendblue API client for sending and receiving iMessages
 */

import type { SendblueMessage, ServerConfig } from './types.js';

const SENDBLUE_API_BASE = 'https://api.sendblue.com/api';

export class SendblueClient {
  private apiKey: string;
  private apiSecret: string;
  private phoneNumber: string;

  constructor(config: Pick<ServerConfig, 'sendblueApiKey' | 'sendblueApiSecret' | 'sendbluePhoneNumber'>) {
    this.apiKey = config.sendblueApiKey;
    this.apiSecret = config.sendblueApiSecret;
    this.phoneNumber = config.sendbluePhoneNumber;
  }

  private getHeaders(): HeadersInit {
    return {
      'sb-api-key-id': this.apiKey,
      'sb-api-secret-key': this.apiSecret,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Fetch messages from Sendblue API
   * @param since - Only fetch messages after this date
   * @param limit - Maximum number of messages to fetch
   */
  async getMessages(since?: Date, limit: number = 50): Promise<SendblueMessage[]> {
    const params = new URLSearchParams();
    params.set('limit', limit.toString());

    if (since) {
      // ISO 8601 format
      params.set('created_at_gte', since.toISOString());
    }

    const url = `${SENDBLUE_API_BASE}/v2/messages?${params.toString()}`;

    console.error(`[Sendblue] Fetching messages: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Sendblue API error: ${response.status} - ${text}`);
    }

    const data = await response.json();

    // API returns { status: "OK", data: [...], pagination: {...} }
    const messages = data.data || [];

    console.error(`[Sendblue] Fetched ${messages.length} messages`);

    return messages;
  }

  /**
   * Get inbound (received) messages only
   */
  async getInboundMessages(since?: Date, limit: number = 50): Promise<SendblueMessage[]> {
    const allMessages = await this.getMessages(since, limit);
    return allMessages.filter(msg => !msg.is_outbound);
  }

  /**
   * Send an iMessage
   */
  async sendMessage(toNumber: string, content: string, mediaUrl?: string): Promise<{ messageId: string }> {
    const body: Record<string, string> = {
      number: toNumber,
      content: content,
      from_number: this.phoneNumber,
    };

    if (mediaUrl) {
      body.media_url = mediaUrl;
    }

    console.error(`[Sendblue] Sending message to ${toNumber}: ${content.substring(0, 50)}...`);

    const response = await fetch(`${SENDBLUE_API_BASE}/send-message`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Sendblue send error: ${response.status} - ${text}`);
    }

    const data = await response.json();
    console.error(`[Sendblue] Message sent, ID: ${data.message_handle || data.id}`);

    return { messageId: data.message_handle || data.id };
  }

  /**
   * Check message delivery status
   */
  async getMessageStatus(messageHandle: string): Promise<string> {
    const response = await fetch(`${SENDBLUE_API_BASE}/status?message_handle=${messageHandle}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Sendblue status error: ${response.status}`);
    }

    const data = await response.json();
    return data.status;
  }

  /**
   * Evaluate if a phone number can receive iMessages
   */
  async evaluateNumber(phoneNumber: string): Promise<{ isImessage: boolean }> {
    const response = await fetch(`${SENDBLUE_API_BASE}/evaluate-service`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ number: phoneNumber }),
    });

    if (!response.ok) {
      throw new Error(`Sendblue evaluate error: ${response.status}`);
    }

    const data = await response.json();
    return { isImessage: data.is_imessage === true };
  }

  private formatDate(date: Date): string {
    return date.toISOString().replace('T', ' ').substring(0, 19);
  }
}
