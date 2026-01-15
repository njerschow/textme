/**
 * Sendblue API client for sending and receiving iMessages
 */
const SENDBLUE_API_BASE = 'https://api.sendblue.com/api';
export class SendblueClient {
    apiKey;
    apiSecret;
    phoneNumber;
    constructor(config) {
        this.apiKey = config.apiKey;
        this.apiSecret = config.apiSecret;
        this.phoneNumber = config.phoneNumber;
    }
    getHeaders() {
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
    async getMessages(since, limit = 50) {
        const params = new URLSearchParams();
        params.set('limit', limit.toString());
        if (since) {
            // ISO 8601 format
            params.set('created_at_gte', since.toISOString());
        }
        const url = `${SENDBLUE_API_BASE}/v2/messages?${params.toString()}`;
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
        // Only log when messages are found
        if (messages.length > 0) {
            console.log(`[Sendblue] Received ${messages.length} message(s)`);
        }
        return messages;
    }
    /**
     * Get inbound (received) messages only
     */
    async getInboundMessages(since, limit = 50) {
        const allMessages = await this.getMessages(since, limit);
        return allMessages.filter(msg => !msg.is_outbound);
    }
    /**
     * Send an iMessage
     */
    async sendMessage(toNumber, content, mediaUrl) {
        const body = {
            number: toNumber,
            content: content,
            from_number: this.phoneNumber,
        };
        if (mediaUrl) {
            body.media_url = mediaUrl;
        }
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
        console.log(`[Sendblue] Sent to ${toNumber.slice(-4)}: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`);
        return { messageId: data.message_handle || data.id };
    }
    /**
     * Check message delivery status
     */
    async getMessageStatus(messageHandle) {
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
    getPhoneNumber() {
        return this.phoneNumber;
    }
    /**
     * Upload a file from a local path and get a media URL
     * Uses the new /upload-file endpoint (max 100MB)
     */
    async uploadFile(filePath) {
        console.log(`[Sendblue] Uploading file: ${filePath}`);
        const fs = await import('fs');
        const path = await import('path');
        const fileBuffer = fs.readFileSync(filePath);
        const filename = path.basename(filePath);
        return this.uploadFileFromBuffer(fileBuffer, filename);
    }
    /**
     * Upload a file from a Buffer and get a media URL
     * Uses the new /upload-file endpoint (max 100MB)
     */
    async uploadFileFromBuffer(buffer, filename) {
        console.log(`[Sendblue] Uploading buffer as: ${filename} (${buffer.length} bytes)`);
        // Create multipart form data manually
        const boundary = `----SendblueUpload${Date.now()}`;
        const header = Buffer.from(`--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
            `Content-Type: application/octet-stream\r\n\r\n`);
        const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
        const body = Buffer.concat([header, buffer, footer]);
        const response = await fetch(`${SENDBLUE_API_BASE}/upload-file`, {
            method: 'POST',
            headers: {
                'sb-api-key-id': this.apiKey,
                'sb-api-secret-key': this.apiSecret,
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
            },
            body: body,
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Sendblue file upload error: ${response.status} - ${text}`);
        }
        const data = await response.json();
        console.log(`[Sendblue] File uploaded, URL: ${data.media_url}`);
        return data.media_url;
    }
    /**
     * Upload a file from a URL and get a Sendblue media URL
     */
    async uploadFileFromUrl(url, filename) {
        console.log(`[Sendblue] Downloading and uploading from URL: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to download file from ${url}: ${response.status}`);
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const inferredFilename = filename || url.split('/').pop()?.split('?')[0] || 'file';
        return this.uploadFileFromBuffer(buffer, inferredFilename);
    }
    /**
     * Send a message with an attachment (uploads file first if needed)
     */
    async sendMessageWithAttachment(toNumber, content, attachment) {
        let mediaUrl;
        if (attachment.filePath) {
            mediaUrl = await this.uploadFile(attachment.filePath);
        }
        else if (attachment.buffer && attachment.filename) {
            mediaUrl = await this.uploadFileFromBuffer(attachment.buffer, attachment.filename);
        }
        else if (attachment.url) {
            mediaUrl = await this.uploadFileFromUrl(attachment.url, attachment.filename);
        }
        else {
            throw new Error('Attachment must have filePath, buffer+filename, or url');
        }
        return this.sendMessage(toNumber, content, mediaUrl);
    }
    /**
     * Send a contact card (vCard) via a publicly accessible URL
     * Note: Sendblue requires the vCard to be hosted on a public URL
     * The URL must end with .vcf or .vcard and be directly downloadable
     */
    async sendContactCard(toNumber, vcardUrl) {
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
    async sendContactCardFromData(toNumber, contact) {
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
        throw new Error('To send a contact card, you must host the vCard on a public URL (e.g., Google Cloud Storage, S3, or any CDN). ' +
            'Then use sendContactCard(toNumber, vcardUrl) with the public URL.');
    }
}
