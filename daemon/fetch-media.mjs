import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Load config
const configPath = join(homedir(), '.config', 'claude-imessage', 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));

const apiKey = config.sendblue.apiKey;
const apiSecret = config.sendblue.apiSecret;

const response = await fetch('https://api.sendblue.com/api/v2/messages?limit=30', {
  headers: {
    'sb-api-key-id': apiKey,
    'sb-api-secret-key': apiSecret,
    'Content-Type': 'application/json'
  }
});

const data = await response.json();
const msgs = data.data || [];

console.log('Looking for inbound messages with media_url...\n');

msgs.forEach(m => {
  // Show inbound messages or any message with a media URL
  if (m.media_url || !m.is_outbound) {
    console.log('---');
    console.log('ID:', m.id);
    console.log('Content:', m.content);
    console.log('Media URL:', m.media_url || 'none');
    console.log('Inbound:', !m.is_outbound);
    console.log('Date:', m.date_sent);
    console.log('');
  }
});
