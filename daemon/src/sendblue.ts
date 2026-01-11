/**
 * Sendblue API client for sending and receiving iMessages
 */

import type { SendblueMessage, DaemonConfig } from './types.js';

const SENDBLUE_API_BASE = 'https://api.sendblue.com/api';

export class SendblueClient {
  private apiKey: string;
  private apiSecret: string;
  private phoneNumber: string;

  constructor(config: DaemonConfig['sendblue']) {
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.phoneNumber = config.phoneNumber;
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

    console.log(`[Sendblue] Fetching messages since ${since?.toISOString() || 'beginning'}`);

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

    console.log(`[Sendblue] Fetched ${messages.length} messages`);

    // Debug: log first message structure
    if (messages.length > 0) {
      console.log(`[Sendblue] First message sample:`, JSON.stringify(messages[0], null, 2));
    }

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

    console.log(`[Sendblue] Sending message to ${toNumber}: ${content.substring(0, 100)}...`);

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
    console.log(`[Sendblue] Message sent, ID: ${data.message_handle || data.id}`);

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
   * Get the configured phone number
   */
  getPhoneNumber(): string {
    return this.phoneNumber;
  }

  /**
   * Upload a media file and get a media object ID
   */
  async uploadMedia(filePath: string): Promise<string> {
    console.log(`[Sendblue] Uploading media file: ${filePath}`);

    const fs = await import('fs');
    const FormData = (await import('formdata-node')).FormData;
    const { fileFromPath } = await import('formdata-node/file-from-path');

    const formData = new FormData();
    const file = await fileFromPath(filePath);
    formData.append('file', file);

    const headers = {
      'sb-api-key-id': this.apiKey,
      'sb-api-secret-key': this.apiSecret,
      // Don't set Content-Type - let fetch set it with boundary for multipart
    };

    const response = await fetch(`${SENDBLUE_API_BASE}/upload-media-object`, {
      method: 'POST',
      headers,
      body: formData as any,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Sendblue media upload error: ${response.status} - ${text}`);
    }

    const data = await response.json();
    console.log(`[Sendblue] Media uploaded, URL: ${data.media_url || data.url}`);

    return data.media_url || data.url;
  }

  /**
   * Send a contact card (vCard) via a publicly accessible URL
   * Note: Sendblue requires the vCard to be hosted on a public URL
   * The URL must end with .vcf or .vcard and be directly downloadable
   */
  async sendContactCard(toNumber: string, vcardUrl: string): Promise<{ messageId: string }> {
    console.log(`[Sendblue] Sending contact card to ${toNumber}: ${vcardUrl}`);

    if (!vcardUrl.endsWith('.vcf') && !vcardUrl.endsWith('.vcard')) {
      console.warn('[Sendblue] Warning: vCard URL should end with .vcf or .vcard');
    }

    // Send message with the media URL - empty content so attachment is primary
    return this.sendMessage(toNumber, '', vcardUrl);
  }

  /**
   * Send a contact card by creating and hosting a temporary vCard
   * Uses a data URL approach (may not work with all iMessage clients)
   */
  async sendContactCardFromData(
    toNumber: string,
    contact: {
      name: string;
      phone?: string;
      email?: string;
      organization?: string;
      note?: string;
    }
  ): Promise<{ messageId: string }> {
    // Create vCard content
    const nameParts = contact.name.split(' ');
    const lastName = nameParts.pop() || '';
    const firstName = nameParts.join(' ') || contact.name;

    let vcard = `BEGIN:VCARD
VERSION:3.0
FN:${contact.name}
N:${lastName};${firstName};;;`;

    if (contact.phone) {
      vcard += `\nTEL;TYPE=CELL:${contact.phone}`;
    }
    if (contact.email) {
      vcard += `\nEMAIL:${contact.email}`;
    }
    if (contact.organization) {
      vcard += `\nORG:${contact.organization}`;
    }
    if (contact.note) {
      vcard += `\nNOTE:${contact.note}`;
    }
    vcard += `\nEND:VCARD`;

    console.log(`[Sendblue] Created vCard for ${contact.name}`);
    console.log(`[Sendblue] Note: You need to host this vCard on a public URL`);
    console.log(vcard);

    throw new Error(
      'To send a contact card, you must host the vCard on a public URL (e.g., Google Cloud Storage, S3, or any CDN). ' +
      'Then use sendContactCard(toNumber, vcardUrl) with the public URL.'
    );
  }
}
