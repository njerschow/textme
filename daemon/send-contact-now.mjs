/**
 * Quick script to send Claude-Code.vcf contact card
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const SENDBLUE_API_BASE = 'https://api.sendblue.com/api';

// Load config
const configPath = path.join(os.homedir(), '.config/claude-imessage/config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Using the vCard URL from SendBlue's inbound message storage
const vcardUrl = 'https://storage.googleapis.com/inbound-file-store/LYitt52k_Claude Code.vcf';
const toNumber = '+15551234567';

async function main() {
  console.log('=== Sending Claude Code Contact Card ===\n');
  console.log('vCard URL:', vcardUrl);
  console.log('To:', toNumber);
  console.log('From:', config.sendblue.phoneNumber);
  console.log('');

  // Send the contact card
  console.log('Sending contact card...');

  const sendResponse = await fetch(`${SENDBLUE_API_BASE}/send-message`, {
    method: 'POST',
    headers: {
      'sb-api-key-id': config.sendblue.apiKey,
      'sb-api-secret-key': config.sendblue.apiSecret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      number: toNumber,
      content: '',
      from_number: config.sendblue.phoneNumber,
      media_url: vcardUrl,
    }),
  });

  if (!sendResponse.ok) {
    const text = await sendResponse.text();
    throw new Error(`Send failed: ${sendResponse.status} - ${text}`);
  }

  const sendData = await sendResponse.json();
  console.log('Success!');
  console.log('Message ID:', sendData.message_handle || sendData.id);
  console.log('');
  console.log('Full response:', JSON.stringify(sendData, null, 2));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
