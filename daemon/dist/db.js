/**
 * SQLite database for message tracking, conversation history, and daemon state
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';
const DB_DIR = path.join(os.homedir(), '.config', 'claude-imessage');
const DB_PATH = path.join(DB_DIR, 'daemon.db');
let db = null;
export function initDb() {
    if (db)
        return db;
    // Ensure directory exists
    if (!fs.existsSync(DB_DIR)) {
        fs.mkdirSync(DB_DIR, { recursive: true });
    }
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

    -- Daemon state (key-value store)
    CREATE TABLE IF NOT EXISTS daemon_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Running tasks (for concurrency tracking)
    CREATE TABLE IF NOT EXISTS running_tasks (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      pid INTEGER
    );

    -- Message queue for when Claude is busy
    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_handle TEXT UNIQUE NOT NULL,
      phone_number TEXT NOT NULL,
      content TEXT NOT NULL,
      queued_at INTEGER NOT NULL
    );

    -- Pending approvals for Bash commands
    CREATE TABLE IF NOT EXISTS pending_approvals (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      command TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    -- Indexes for faster lookups
    CREATE INDEX IF NOT EXISTS idx_conversations_phone
      ON conversations(phone_number, timestamp DESC);

    CREATE INDEX IF NOT EXISTS idx_processed_at
      ON processed_messages(processed_at);

    CREATE INDEX IF NOT EXISTS idx_queue_order
      ON message_queue(queued_at ASC);

    CREATE INDEX IF NOT EXISTS idx_approvals_phone
      ON pending_approvals(phone_number);
  `);
    return db;
}
// --- Processed Messages ---
export function isMessageProcessed(messageId) {
    const database = initDb();
    const row = database.prepare('SELECT 1 FROM processed_messages WHERE message_id = ?').get(messageId);
    return !!row;
}
export function markMessageProcessed(messageId) {
    const database = initDb();
    database.prepare('INSERT OR IGNORE INTO processed_messages (message_id, processed_at) VALUES (?, ?)').run(messageId, Date.now());
}
export function cleanupOldProcessedMessages(olderThanMs = 7 * 24 * 60 * 60 * 1000) {
    const database = initDb();
    const cutoff = Date.now() - olderThanMs;
    database.prepare('DELETE FROM processed_messages WHERE processed_at < ?').run(cutoff);
}
// --- Conversation History ---
export function addConversationMessage(phoneNumber, role, content) {
    const database = initDb();
    database.prepare('INSERT INTO conversations (phone_number, role, content, timestamp) VALUES (?, ?, ?, ?)').run(phoneNumber, role, content, Date.now());
}
export function getConversationHistory(phoneNumber, limit = 20) {
    const database = initDb();
    const rows = database.prepare(`
    SELECT id, phone_number, role, content, timestamp
    FROM conversations
    WHERE phone_number = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(phoneNumber, limit);
    // Return in chronological order (oldest first)
    return rows.reverse();
}
export function trimConversationHistory(phoneNumber, keepCount) {
    const database = initDb();
    // Get the timestamp of the Nth most recent message
    const cutoffRow = database.prepare(`
    SELECT timestamp FROM conversations
    WHERE phone_number = ?
    ORDER BY timestamp DESC
    LIMIT 1 OFFSET ?
  `).get(phoneNumber, keepCount - 1);
    if (cutoffRow) {
        // Delete older messages
        database.prepare(`
      DELETE FROM conversations
      WHERE phone_number = ? AND timestamp < ?
    `).run(phoneNumber, cutoffRow.timestamp);
    }
}
export function clearConversationHistory(phoneNumber) {
    const database = initDb();
    database.prepare('DELETE FROM conversations WHERE phone_number = ?').run(phoneNumber);
}
export function getLastConversationInfo(phoneNumber) {
    const database = initDb();
    const row = database.prepare(`
    SELECT content, timestamp, role FROM conversations
    WHERE phone_number = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(phoneNumber);
    return row ?? null;
}
export function getAllContacts() {
    const database = initDb();
    const rows = database.prepare(`
    SELECT DISTINCT phone_number
    FROM conversations
    ORDER BY (SELECT MAX(timestamp) FROM conversations c2 WHERE c2.phone_number = conversations.phone_number) DESC
  `).all();
    return rows.map(r => r.phone_number);
}
// --- Daemon State ---
export function getState(key) {
    const database = initDb();
    const row = database.prepare('SELECT value FROM daemon_state WHERE key = ?').get(key);
    return row?.value ?? null;
}
export function setState(key, value) {
    const database = initDb();
    database.prepare('INSERT OR REPLACE INTO daemon_state (key, value) VALUES (?, ?)').run(key, value);
}
export function deleteState(key) {
    const database = initDb();
    database.prepare('DELETE FROM daemon_state WHERE key = ?').run(key);
}
// --- Running Tasks ---
export function getRunningTask() {
    const database = initDb();
    const row = database.prepare('SELECT id, description, started_at, pid FROM running_tasks LIMIT 1').get();
    return row ?? null;
}
export function setRunningTask(id, description, pid = null) {
    const database = initDb();
    // Clear any existing tasks first
    database.prepare('DELETE FROM running_tasks').run();
    database.prepare('INSERT INTO running_tasks (id, description, started_at, pid) VALUES (?, ?, ?, ?)').run(id, description, Date.now(), pid);
}
export function updateRunningTaskPid(id, pid) {
    const database = initDb();
    database.prepare('UPDATE running_tasks SET pid = ? WHERE id = ?').run(pid, id);
}
export function clearRunningTask() {
    const database = initDb();
    database.prepare('DELETE FROM running_tasks').run();
}
// --- Message Queue ---
export function queueMessage(messageHandle, phoneNumber, content) {
    const database = initDb();
    database.prepare('INSERT OR IGNORE INTO message_queue (message_handle, phone_number, content, queued_at) VALUES (?, ?, ?, ?)').run(messageHandle, phoneNumber, content, Date.now());
}
export function getNextQueuedMessage() {
    const database = initDb();
    const row = database.prepare('SELECT id, message_handle, phone_number, content, queued_at FROM message_queue ORDER BY queued_at ASC LIMIT 1').get();
    return row ?? null;
}
export function removeQueuedMessage(id) {
    const database = initDb();
    database.prepare('DELETE FROM message_queue WHERE id = ?').run(id);
}
export function getQueueLength() {
    const database = initDb();
    const row = database.prepare('SELECT COUNT(*) as count FROM message_queue').get();
    return row.count;
}
export function getAllQueuedMessages() {
    const database = initDb();
    const rows = database.prepare('SELECT id, message_handle, phone_number, content, queued_at FROM message_queue ORDER BY queued_at ASC').all();
    return rows;
}
export function clearMessageQueue() {
    const database = initDb();
    database.prepare('DELETE FROM message_queue').run();
}
// --- Pending Approvals ---
export function addPendingApproval(id, taskId, command, phoneNumber, timeoutMs = 5 * 60 * 1000) {
    const database = initDb();
    const now = Date.now();
    database.prepare('INSERT OR REPLACE INTO pending_approvals (id, task_id, command, phone_number, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, taskId, command, phoneNumber, now, now + timeoutMs);
}
export function getPendingApproval(phoneNumber) {
    const database = initDb();
    const now = Date.now();
    const row = database.prepare('SELECT id, task_id, command, phone_number, created_at, expires_at FROM pending_approvals WHERE phone_number = ? AND expires_at > ?').get(phoneNumber, now);
    return row ?? null;
}
export function getPendingApprovalById(id) {
    const database = initDb();
    const row = database.prepare('SELECT id, task_id, command, phone_number, created_at, expires_at FROM pending_approvals WHERE id = ?').get(id);
    return row ?? null;
}
export function removePendingApproval(id) {
    const database = initDb();
    database.prepare('DELETE FROM pending_approvals WHERE id = ?').run(id);
}
export function cleanupExpiredApprovals() {
    const database = initDb();
    const result = database.prepare('DELETE FROM pending_approvals WHERE expires_at < ?').run(Date.now());
    return result.changes;
}
// --- Utility ---
export function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}
export function getDbPath() {
    return DB_PATH;
}
