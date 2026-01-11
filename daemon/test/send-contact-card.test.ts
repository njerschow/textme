/**
 * Test for sending a contact card via Sendblue
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SendblueClient } from '../src/sendblue.js';
import { loadConfig } from '../src/config.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Test phone number - the user's whitelisted number
const TEST_PHONE = '+15551234567';

describe('Sendblue Contact Card', () => {
  let sendblue: SendblueClient;
  let testVcardPath: string;

  beforeAll(() => {
    const config = loadConfig();
    sendblue = new SendblueClient(config.sendblue);

    // Create a test vCard file
    const vcardContent = `BEGIN:VCARD
VERSION:3.0
FN:Claude Assistant
N:Assistant;Claude;;;
TEL;TYPE=CELL:+15559876543
EMAIL:claude@example.com
NOTE:Your AI assistant via iMessage
END:VCARD`;

    testVcardPath = path.join(os.tmpdir(), 'claude-test-contact.vcf');
    fs.writeFileSync(testVcardPath, vcardContent);
  });

  it('should create a valid vCard file', () => {
    expect(fs.existsSync(testVcardPath)).toBe(true);
    const content = fs.readFileSync(testVcardPath, 'utf-8');
    expect(content).toContain('BEGIN:VCARD');
    expect(content).toContain('Claude Assistant');
    expect(content).toContain('END:VCARD');
  });

  it.skip('should upload media and get URL', async () => {
    // Skip by default - this makes actual API calls
    const mediaUrl = await sendblue.uploadMedia(testVcardPath);
    expect(mediaUrl).toBeTruthy();
    expect(typeof mediaUrl).toBe('string');
    console.log('Media URL:', mediaUrl);
  });

  it.skip('should send contact card to user', async () => {
    // Skip by default - this makes actual API calls and sends a real message
    const result = await sendblue.sendContactCard(TEST_PHONE, testVcardPath);
    expect(result.messageId).toBeTruthy();
    console.log('Message ID:', result.messageId);
  });
});

/**
 * Run this file directly to send a contact card:
 * npx tsx test/send-contact-card.test.ts --send
 */
if (process.argv.includes('--send')) {
  (async () => {
    console.log('Sending contact card test...');

    const config = loadConfig();
    const sendblue = new SendblueClient(config.sendblue);

    // Create the vCard
    const vcardContent = `BEGIN:VCARD
VERSION:3.0
FN:Claude Assistant
N:Assistant;Claude;;;
TEL;TYPE=CELL:+15559876543
EMAIL:claude@anthropic.com
NOTE:Your AI assistant via iMessage - Powered by Claude
ORG:Anthropic
END:VCARD`;

    const vcardPath = path.join(os.tmpdir(), 'claude-contact.vcf');
    fs.writeFileSync(vcardPath, vcardContent);
    console.log('Created vCard at:', vcardPath);

    try {
      console.log('Uploading vCard...');
      const mediaUrl = await sendblue.uploadMedia(vcardPath);
      console.log('Media URL:', mediaUrl);

      console.log('Sending contact card to', TEST_PHONE);
      const result = await sendblue.sendContactCard(TEST_PHONE, vcardPath);
      console.log('Success! Message ID:', result.messageId);
    } catch (error) {
      console.error('Error:', error);
    }

    // Cleanup
    fs.unlinkSync(vcardPath);
  })();
}
