/**
 * SQLite database for message tracking and conversation history
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { ConversationMessage, ProcessedMessage } from './types.js';

const DB_PATH = path.join(process.env.HOME || '.', '.imessage-mcp', 'messages.db');

let db: Database.Database | null = null;

export function initDb(): Database.Database {
  if (db) return db;

  // Ensure directory exists
  const dir = path.dirname(DB_PATH);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}

  db = new Database(DB_PATH);

  // Create tables
  db.exec(`
    -- Track processed message IDs to avoid duplicates
    CREATE TABLE IF NOT EXISTS processed_messages (
      message_id TEXT PRIMARY KEY,
      processed_at INTEGER NOT NULL
    );

    -- Conversation history for context
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    -- Index for faster lookups
    CREATE INDEX IF NOT EXISTS idx_conversations_phone
      ON conversations(phone_number, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_processed_at
      ON processed_messages(processed_at);
  `);

  return db;
}

export function isMessageProcessed(messageId: string): boolean {
  const database = initDb();
  const row = database.prepare('SELECT 1 FROM processed_messages WHERE message_id = ?').get(messageId);
  return !!row;
}

export function markMessageProcessed(messageId: string): void {
  const database = initDb();
  database.prepare(
    'INSERT OR IGNORE INTO processed_messages (message_id, processed_at) VALUES (?, ?)'
  ).run(messageId, Date.now());
}

export function addConversationMessage(
  phoneNumber: string,
  role: 'user' | 'assistant',
  content: string
): void {
  const database = initDb();
  database.prepare(
    'INSERT INTO conversations (phone_number, role, content, timestamp) VALUES (?, ?, ?, ?)'
  ).run(phoneNumber, role, content, Date.now());
}

export function getConversationHistory(
  phoneNumber: string,
  limit: number = 20
): ConversationMessage[] {
  const database = initDb();
  const rows = database.prepare(`
    SELECT id, phone_number, role, content, timestamp
    FROM conversations
    WHERE phone_number = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(phoneNumber, limit) as ConversationMessage[];

  // Return in chronological order (oldest first)
  return rows.reverse();
}

export function clearConversationHistory(phoneNumber: string): void {
  const database = initDb();
  database.prepare('DELETE FROM conversations WHERE phone_number = ?').run(phoneNumber);
}

export function getAllContacts(): string[] {
  const database = initDb();
  const rows = database.prepare(`
    SELECT DISTINCT phone_number
    FROM conversations
    ORDER BY (SELECT MAX(timestamp) FROM conversations c2 WHERE c2.phone_number = conversations.phone_number) DESC
  `).all() as { phone_number: string }[];

  return rows.map(r => r.phone_number);
}

export function cleanupOldProcessedMessages(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): void {
  const database = initDb();
  const cutoff = Date.now() - olderThanMs;
  database.prepare('DELETE FROM processed_messages WHERE processed_at < ?').run(cutoff);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
