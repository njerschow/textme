/**
 * Script to send a contact card via Sendblue
 *
 * IMPORTANT: Sendblue requires the vCard to be hosted on a PUBLIC URL
 * You cannot upload files directly - they must be hosted on:
 * - Google Cloud Storage
 * - AWS S3
 * - Any CDN with direct download links
 * - GitHub raw URLs (gists work!)
 *
 * Usage: npx tsx scripts/send-contact-card.ts [vcard-url]
 *
 * Example with a hosted vCard:
 * npx tsx scripts/send-contact-card.ts https://storage.googleapis.com/your-bucket/contact.vcf
 */

import { SendblueClient } from '../src/sendblue.js';
import { loadConfig } from '../src/config.js';

const TEST_PHONE = '+15551234567';

// Example vCard URL - replace with your own hosted vCard
// You can create a GitHub Gist with .vcf extension and use the raw URL
const EXAMPLE_VCARD_URL = process.argv[2] || '';

async function main() {
  console.log('=== Sendblue Contact Card Sender ===\n');

  if (!EXAMPLE_VCARD_URL) {
    console.log('To send a contact card, you need to host your vCard on a public URL.\n');
    console.log('Steps:');
    console.log('1. Create a vCard file (example below)');
    console.log('2. Upload to GitHub Gist, Google Cloud Storage, S3, or any CDN');
    console.log('3. Run: npx tsx scripts/send-contact-card.ts <your-vcard-url>\n');

    console.log('Example vCard content:');
    console.log('------------------------');
    const exampleVcard = `BEGIN:VCARD
VERSION:3.0
FN:Claude Assistant
N:Assistant;Claude;;;
TEL;TYPE=CELL:+15559876543
EMAIL:claude@anthropic.com
NOTE:Your AI assistant via iMessage
ORG:Anthropic
END:VCARD`;
    console.log(exampleVcard);
    console.log('------------------------\n');

    console.log('Quick option: Create a GitHub Gist');
    console.log('1. Go to https://gist.github.com');
    console.log('2. Create a new gist with filename "contact.vcf"');
    console.log('3. Paste the vCard content');
    console.log('4. Click "Create secret gist" or "Create public gist"');
    console.log('5. Click "Raw" to get the direct URL');
    console.log('6. Use that URL with this script\n');
    return;
  }

  console.log('Sending contact card...');
  console.log('To:', TEST_PHONE);
  console.log('vCard URL:', EXAMPLE_VCARD_URL);

  const config = loadConfig();
  const sendblue = new SendblueClient(config.sendblue);

  try {
    const result = await sendblue.sendContactCard(TEST_PHONE, EXAMPLE_VCARD_URL);
    console.log('\nSuccess! Message ID:', result.messageId);
  } catch (error) {
    console.error('\nError:', error);
  }
}

main();
