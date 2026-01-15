/**
 * Sendblue API client for sending and receiving iMessages
 */
import type { SendblueMessage, DaemonConfig } from './types.js';
export declare class SendblueClient {
    private apiKey;
    private apiSecret;
    private phoneNumber;
    constructor(config: DaemonConfig['sendblue']);
    private getHeaders;
    /**
     * Fetch messages from Sendblue API
     * @param since - Only fetch messages after this date
     * @param limit - Maximum number of messages to fetch
     */
    getMessages(since?: Date, limit?: number): Promise<SendblueMessage[]>;
    /**
     * Get inbound (received) messages only
     */
    getInboundMessages(since?: Date, limit?: number): Promise<SendblueMessage[]>;
    /**
     * Send an iMessage
     */
    sendMessage(toNumber: string, content: string, mediaUrl?: string): Promise<{
        messageId: string;
    }>;
    /**
     * Check message delivery status
     */
    getMessageStatus(messageHandle: string): Promise<string>;
    /**
     * Get the configured phone number
     */
    getPhoneNumber(): string;
    /**
     * Upload a file from a local path and get a media URL
     * Uses the new /upload-file endpoint (max 100MB)
     */
    uploadFile(filePath: string): Promise<string>;
    /**
     * Upload a file from a Buffer and get a media URL
     * Uses the new /upload-file endpoint (max 100MB)
     */
    uploadFileFromBuffer(buffer: Buffer, filename: string): Promise<string>;
    /**
     * Upload a file from a URL and get a Sendblue media URL
     */
    uploadFileFromUrl(url: string, filename?: string): Promise<string>;
    /**
     * Send a message with an attachment (uploads file first if needed)
     */
    sendMessageWithAttachment(toNumber: string, content: string, attachment: {
        filePath?: string;
        buffer?: Buffer;
        url?: string;
        filename?: string;
    }): Promise<{
        messageId: string;
    }>;
    /**
     * Send a contact card (vCard) via a publicly accessible URL
     * Note: Sendblue requires the vCard to be hosted on a public URL
     * The URL must end with .vcf or .vcard and be directly downloadable
     */
    sendContactCard(toNumber: string, vcardUrl: string): Promise<{
        messageId: string;
    }>;
    /**
     * Send a contact card by creating and hosting a temporary vCard
     * Uses a data URL approach (may not work with all iMessage clients)
     */
    sendContactCardFromData(toNumber: string, contact: {
        name: string;
        phone?: string;
        email?: string;
        organization?: string;
        note?: string;
    }): Promise<{
        messageId: string;
    }>;
}
