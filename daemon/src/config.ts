/**
 * Configuration loader for the Claude iMessage daemon
 * Loads from ~/.config/claude-imessage/config.json
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { DaemonConfig } from './types.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'claude-imessage');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: Partial<DaemonConfig> = {
  pollIntervalMs: 5000,
  conversationWindowSize: 20,
};

export function loadConfig(): DaemonConfig {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    createExampleConfig();
    throw new Error(
      `Config not found. Created example at ${CONFIG_PATH}.example\n` +
      `Copy to ${CONFIG_PATH} and fill in your values.`
    );
  }

  let rawConfig: unknown;
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    rawConfig = JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to parse config: ${error}`);
  }

  return validateConfig(rawConfig);
}

function validateConfig(raw: unknown): DaemonConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Config must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  // Validate sendblue
  if (!obj.sendblue || typeof obj.sendblue !== 'object') {
    throw new Error('Config missing sendblue section');
  }
  const sendblue = obj.sendblue as Record<string, unknown>;
  if (!sendblue.apiKey || typeof sendblue.apiKey !== 'string') {
    throw new Error('Config missing sendblue.apiKey');
  }
  if (!sendblue.apiSecret || typeof sendblue.apiSecret !== 'string') {
    throw new Error('Config missing sendblue.apiSecret');
  }
  if (!sendblue.phoneNumber || typeof sendblue.phoneNumber !== 'string') {
    throw new Error('Config missing sendblue.phoneNumber');
  }

  // Validate whitelist
  if (!Array.isArray(obj.whitelist) || obj.whitelist.length === 0) {
    throw new Error('Config missing or empty whitelist');
  }

  return {
    sendblue: {
      apiKey: sendblue.apiKey as string,
      apiSecret: sendblue.apiSecret as string,
      phoneNumber: sendblue.phoneNumber as string,
    },
    whitelist: obj.whitelist as string[],
    pollIntervalMs: typeof obj.pollIntervalMs === 'number'
      ? obj.pollIntervalMs
      : DEFAULT_CONFIG.pollIntervalMs!,
    conversationWindowSize: typeof obj.conversationWindowSize === 'number'
      ? obj.conversationWindowSize
      : DEFAULT_CONFIG.conversationWindowSize!,
  };
}

function createExampleConfig(): void {
  const example = {
    sendblue: {
      apiKey: 'YOUR_SENDBLUE_API_KEY',
      apiSecret: 'YOUR_SENDBLUE_API_SECRET',
      phoneNumber: '+1YOUR_SENDBLUE_NUMBER',
    },
    whitelist: ['+1YOUR_PHONE_NUMBER'],
    pollIntervalMs: 5000,
    conversationWindowSize: 20,
  };

  fs.writeFileSync(`${CONFIG_PATH}.example`, JSON.stringify(example, null, 2));
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
