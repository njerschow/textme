/**
 * Claude iMessage Daemon
 *
 * Features:
 * 1. Poll Sendblue for messages
 * 2. Stream Claude responses with real-time tool updates
 * 3. Queue messages while processing, notify on dequeue
 * 4. Handle "interrupt" keyword to kill current task
 * 5. Maintain conversation history for context
 */

import { loadConfig, getConfigPath } from './config.js';
import { SendblueClient } from './sendblue.js';
import {
  getOrCreateSession,
  killCurrentSession,
  getCurrentSession,
  interruptCurrentTask,
  type VerboseCallbacks,
} from './claude-session.js';
import {
  initDb,
  closeDb,
  isMessageProcessed,
  markMessageProcessed,
  addConversationMessage,
  getConversationHistory,
  trimConversationHistory,
  clearConversationHistory,
  cleanupOldProcessedMessages,
  getRunningTask,
  queueMessage,
  getNextQueuedMessage,
  removeQueuedMessage,
  getQueueLength,
  getAllQueuedMessages,
  getPendingApproval,
  addPendingApproval,
  removePendingApproval,
  cleanupExpiredApprovals,
  getState,
  setState,
  getLastConversationInfo,
} from './db.js';
import type { DaemonConfig } from './types.js';
import os from 'os';
import fs from 'fs';
import path from 'path';

// PID file for single instance lock
const PID_FILE = path.join(os.homedir(), '.config', 'claude-imessage', 'daemon.pid');

// Log file location
const LOG_DIR = path.join(os.homedir(), '.local', 'log');
const LOG_FILE = path.join(LOG_DIR, 'claude-imessage.log');

/**
 * Setup logging to file
 */
function setupLogging(): void {
  // Ensure log directory exists
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  // Create write stream for log file
  const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

  // Override console.log and console.error to write to both stdout and file
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    const timestamp = new Date().toISOString();
    const message = `[${timestamp}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
    originalLog.apply(console, args);
    logStream.write(message + '\n');
  };

  console.error = (...args: unknown[]) => {
    const timestamp = new Date().toISOString();
    const message = `[${timestamp}] ERROR: ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
    originalError.apply(console, args);
    logStream.write(message + '\n');
  };

  console.log(`[Daemon] Logging to: ${LOG_FILE}`);
}

/**
 * Check if a process is our daemon (not a recycled PID)
 */
function isOurDaemon(pid: number): boolean {
  try {
    // Check if process exists
    process.kill(pid, 0);

    // On macOS/Linux, verify it's actually our daemon by checking cmdline
    const cmdlinePath = `/proc/${pid}/cmdline`;
    if (fs.existsSync(cmdlinePath)) {
      const cmdline = fs.readFileSync(cmdlinePath, 'utf-8');
      return cmdline.includes('claude-imessage') || cmdline.includes('textme');
    }

    // On macOS, /proc doesn't exist - try ps command
    try {
      const { execSync } = require('child_process');
      const psOutput = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8', timeout: 1000 });
      return psOutput.includes('claude-imessage') || psOutput.includes('textme') || psOutput.includes('index.js');
    } catch {
      // ps failed - process might not exist or we can't verify
      return true; // Assume it's ours to be safe
    }
  } catch {
    // Process doesn't exist
    return false;
  }
}

/**
 * Acquire lock - ensures only one instance runs at a time
 * Uses retry logic to handle PM2 restart race conditions
 */
function acquireLock(): boolean {
  const maxRetries = 3;
  const retryDelayMs = 500;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Check if PID file exists
      if (fs.existsSync(PID_FILE)) {
        const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);

        // Check if that process is still running AND is our daemon
        if (isOurDaemon(existingPid) && existingPid !== process.pid) {
          if (attempt < maxRetries - 1) {
            console.log(`[Daemon] Another instance running (PID: ${existingPid}), waiting ${retryDelayMs}ms... (attempt ${attempt + 1}/${maxRetries})`);
            // Synchronous wait
            const waitUntil = Date.now() + retryDelayMs;
            while (Date.now() < waitUntil) { /* busy wait */ }
            continue;
          }
          console.error(`[Daemon] Another instance is already running (PID: ${existingPid})`);
          return false;
        } else {
          // Process doesn't exist or isn't our daemon - stale PID file
          console.log(`[Daemon] Removing stale PID file (old PID: ${existingPid})`);
        }
      }

      // Write our PID
      fs.writeFileSync(PID_FILE, process.pid.toString());
      console.log(`[Daemon] Lock acquired (PID: ${process.pid})`);
      return true;
    } catch (error) {
      console.error('[Daemon] Failed to acquire lock:', error);
      if (attempt === maxRetries - 1) return false;
    }
  }
  return false;
}

/**
 * Release lock on shutdown
 */
function releaseLock(): void {
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
      if (pid === process.pid) {
        fs.unlinkSync(PID_FILE);
        console.log('[Daemon] Lock released');
      }
    }
  } catch (error) {
    console.error('[Daemon] Failed to release lock:', error);
  }
}

// Global state
let config: DaemonConfig;
let sendblue: SendblueClient;
let pollInterval: NodeJS.Timeout | null = null;
let lastPollTime: Date;
let isPolling = false;
let isProcessingMessage = false;

/**
 * Format a timestamp as a relative time (e.g., "2 hours ago")
 */
function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Get the current working directory (persisted in DB)
 */
function getWorkingDirectory(): string {
  const stored = getState('current_project');
  return stored || os.homedir();
}

/**
 * Set the current working directory (persisted in DB)
 */
function setWorkingDirectory(dir: string): void {
  setState('current_project', dir);
}


/**
 * Initialize the daemon
 */
async function init(): Promise<void> {
  console.log('[Daemon] Starting Claude iMessage daemon...');
  console.log(`[Daemon] Config path: ${getConfigPath()}`);

  config = loadConfig();
  console.log(`[Daemon] Whitelist: ${config.whitelist.join(', ')}`);
  console.log(`[Daemon] Poll interval: ${config.pollIntervalMs}ms`);

  initDb();
  console.log('[Daemon] Database initialized');

  sendblue = new SendblueClient(config.sendblue);
  console.log(`[Daemon] Sendblue ready (${config.sendblue.phoneNumber})`);

  // Start Claude session in persisted working directory
  const workingDir = getWorkingDirectory();
  console.log(`[Daemon] Starting Claude session in: ${workingDir}`);
  try {
    await getOrCreateSession(workingDir);
    console.log('[Daemon] Claude session ready');
  } catch (error) {
    console.error('[Daemon] Failed to start Claude session:', error);
    // Continue anyway - will retry on first message
  }

  lastPollTime = new Date(Date.now() - 60 * 1000);

  // Cleanup old messages and expired approvals periodically
  setInterval(() => {
    cleanupOldProcessedMessages();
    cleanupExpiredApprovals();
  }, 60 * 60 * 1000);

  console.log('[Daemon] Initialization complete');

  // Send startup notification to first whitelisted number
  if (config.whitelist.length > 0) {
    const primaryNumber = config.whitelist[0];

    // Build context-aware startup message
    let startupMsg = `🤖 Ready!\n📂 ${workingDir}`;

    // Add last conversation info if available
    const lastConvo = getLastConversationInfo(primaryNumber);
    if (lastConvo) {
      const timeAgo = formatTimeAgo(lastConvo.timestamp);
      const preview = lastConvo.content.substring(0, 50) + (lastConvo.content.length > 50 ? '...' : '');
      const who = lastConvo.role === 'user' ? 'You' : 'Claude';
      startupMsg += `\n\n💬 Last (${timeAgo}):\n${who}: "${preview}"`;
    }

    const qLen = getQueueLength();
    if (qLen > 0) {
      startupMsg += `\n\n📥 ${qLen} queued`;
    }

    startupMsg += `\n\n"?" for commands`;

    try {
      await sendblue.sendMessage(primaryNumber, startupMsg);
      console.log('[Daemon] Startup notification sent');
    } catch (err) {
      console.error('[Daemon] Failed to send startup notification:', err);
    }
  }
}

/**
 * Check if phone number is whitelisted
 */
function isWhitelisted(phoneNumber: string): boolean {
  const normalize = (num: string) => num.replace(/\D/g, '');
  const normalized = normalize(phoneNumber);
  return config.whitelist.some(w => normalize(w) === normalized);
}

/**
 * Get daemon status
 */
function getStatus(): string {
  const session = getCurrentSession();
  const runningTask = getRunningTask();
  const queueLen = getQueueLength();
  const workingDir = getWorkingDirectory();

  let status = `Status: ${session?.isActive() ? 'Active' : 'No session'}\n`;
  status += `Directory: ${workingDir}\n`;

  if (runningTask) {
    const elapsed = Math.round((Date.now() - runningTask.started_at) / 1000);
    status += `Working on: ${runningTask.description.substring(0, 60)}...\n`;
    status += `Elapsed: ${elapsed}s\n`;
  } else {
    status += `Ready for input\n`;
  }

  if (queueLen > 0) {
    status += `${queueLen} message${queueLen > 1 ? 's' : ''} queued`;
  }

  return status;
}

/**
 * Help message - IMPORTANT: Update this when adding new commands!
 */
const HELP_MESSAGE = `Commands:
• help / ? - This message
• status - Current status & directory
• queue - View queued messages
• history - Recent messages & outcomes
• history N - Expand item N details
• home - Go to home directory
• reset / fresh - Home + clear chat history
• cd <path> - Change directory
• interrupt / stop - Stop current task
• yes / no - Approval responses

Everything else goes to Claude.`;

/**
 * Detect media type from URL
 */
function detectMediaType(url: string): 'image' | 'audio' | 'video' | 'file' {
  const lowerUrl = url.toLowerCase();

  // Image extensions
  if (/\.(jpg|jpeg|png|gif|webp|heic|heif|bmp|tiff?)(\?|$)/i.test(lowerUrl)) {
    return 'image';
  }

  // Audio extensions (voice notes)
  if (/\.(mp3|m4a|wav|aac|ogg|caf|amr)(\?|$)/i.test(lowerUrl)) {
    return 'audio';
  }

  // Video extensions
  if (/\.(mp4|mov|avi|webm|mkv)(\?|$)/i.test(lowerUrl)) {
    return 'video';
  }

  // Check for common patterns in iMessage media URLs
  if (lowerUrl.includes('image') || lowerUrl.includes('photo')) {
    return 'image';
  }
  if (lowerUrl.includes('audio') || lowerUrl.includes('voice')) {
    return 'audio';
  }

  return 'file';
}

/**
 * Transcribe audio using OpenAI Whisper API
 */
async function transcribeAudio(audioUrl: string): Promise<string | null> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.log('[Transcribe] No OPENAI_API_KEY set, skipping transcription');
    return null;
  }

  try {
    // Download the audio file
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      console.error(`[Transcribe] Failed to download audio: ${audioResponse.status}`);
      return null;
    }

    const audioBuffer = await audioResponse.arrayBuffer();
    const blob = new Blob([audioBuffer]);

    // Determine file extension from URL
    const urlPath = new URL(audioUrl).pathname;
    const ext = urlPath.split('.').pop()?.toLowerCase() || 'm4a';

    // Create form data for Whisper API
    const formData = new FormData();
    formData.append('file', blob, `audio.${ext}`);
    formData.append('model', 'whisper-1');

    const whisperResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: formData,
    });

    if (!whisperResponse.ok) {
      const error = await whisperResponse.text();
      console.error(`[Transcribe] Whisper API error: ${whisperResponse.status} - ${error}`);
      return null;
    }

    const result = await whisperResponse.json() as { text: string };
    console.log(`[Transcribe] Success: "${result.text.substring(0, 50)}..."`);
    return result.text;
  } catch (error) {
    console.error('[Transcribe] Error:', error);
    return null;
  }
}

/**
 * Check for special commands
 */
function isHelpCommand(content: string): boolean {
  const normalized = content.toLowerCase().trim();
  return normalized === 'help' || normalized === '?';
}

function isStatusCommand(content: string): boolean {
  const normalized = content.toLowerCase().trim();
  return normalized === 'status' || normalized === 'status?';
}

function isQueueCommand(content: string): boolean {
  const normalized = content.toLowerCase().trim();
  return normalized === 'queue' || normalized === 'q';
}

function isHistoryCommand(content: string): { isHistory: boolean; expandIndex: number | null } {
  const normalized = content.toLowerCase().trim();
  if (normalized === 'history' || normalized === 'h') {
    return { isHistory: true, expandIndex: null };
  }
  const match = normalized.match(/^(?:history|h)\s+(\d+)$/);
  if (match) {
    return { isHistory: true, expandIndex: parseInt(match[1], 10) };
  }
  return { isHistory: false, expandIndex: null };
}

function isInterruptCommand(content: string): boolean {
  const normalized = content.toLowerCase().trim();
  return normalized === 'interrupt' || normalized === 'stop' || normalized === 'cancel';
}

function isHomeCommand(content: string): boolean {
  const normalized = content.toLowerCase().trim();
  return normalized === 'home';
}

function isResetCommand(content: string): boolean {
  const normalized = content.toLowerCase().trim();
  return normalized === 'reset' || normalized === 'fresh' || normalized === 'new session';
}

function isCdCommand(content: string): { isCD: boolean; path: string | null; error?: string } {
  const normalized = content.trim();
  // Match "cd /path" or "cd ~/path" or "cd /path/to/dir"
  const match = normalized.match(/^cd\s+(.+)$/i);
  if (match) {
    let targetPath = match[1].trim();
    // Expand ~ to home directory
    if (targetPath.startsWith('~')) {
      targetPath = targetPath.replace(/^~/, os.homedir());
    }

    // Security: Resolve to absolute path and check for path traversal
    const resolvedPath = path.resolve(targetPath);
    const homeDir = os.homedir();

    // Only allow paths within home directory or /tmp
    if (!resolvedPath.startsWith(homeDir) && !resolvedPath.startsWith('/tmp')) {
      console.warn(`[Security] Blocked cd to path outside home: ${resolvedPath}`);
      return { isCD: true, path: null, error: 'Access denied: path outside allowed directories' };
    }

    return { isCD: true, path: resolvedPath };
  }
  return { isCD: false, path: null };
}

function isApprovalResponse(content: string): { isApproval: boolean; approved: boolean } {
  const normalized = content.toLowerCase().trim();
  const approvePatterns = ['yes', 'y', 'approve', 'ok', 'go', 'run it', 'do it'];
  const rejectPatterns = ['no', 'n', 'reject', 'cancel', 'deny', 'stop'];

  if (approvePatterns.includes(normalized)) {
    return { isApproval: true, approved: true };
  }
  if (rejectPatterns.includes(normalized)) {
    return { isApproval: true, approved: false };
  }
  return { isApproval: false, approved: false };
}

/**
 * Send message to Claude and get response with real-time tool activity updates
 */
async function askClaude(
  message: string,
  phoneNumber: string,
  onToolActivity?: (activity: string) => void
): Promise<string> {
  const workingDir = getWorkingDirectory();
  const session = await getOrCreateSession(workingDir);

  // Get conversation history for context
  const history = getConversationHistory(phoneNumber, config.conversationWindowSize);

  // Build session context header
  let contextPrompt = `[Session: ${workingDir}]\n`;

  // Add conversation history if available
  if (history.length > 1) {
    contextPrompt += '\nRecent conversation:\n';
    for (const msg of history.slice(0, -1)) {
      const role = msg.role === 'user' ? 'User' : 'Claude';
      contextPrompt += `${role}: ${msg.content}\n\n`;
    }
    contextPrompt += '---\n';
  }

  contextPrompt += 'Current request:\n';
  const fullMessage = contextPrompt + message;
  const taskId = `task-${Date.now()}`;

  // Build verbose callbacks if activity callback provided
  const callbacks: VerboseCallbacks | undefined = onToolActivity ? {
    onToolActivity,
    activityIntervalMs: 1000, // Send activity updates at most once per second
  } : undefined;

  const response = await session.send(fullMessage, taskId, callbacks);
  return response || 'No response from Claude.';
}

/**
 * Process a single message
 */
async function processMessage(
  messageHandle: string,
  phoneNumber: string,
  content: string,
  fromQueue: boolean = false
): Promise<void> {
  const processStart = Date.now();
  const contentPreview = content.substring(0, 60) + (content.length > 60 ? '...' : '');
  console.log(`[Process] Starting: "${contentPreview}"${fromQueue ? ' (from queue)' : ''}`);

  // Notify what we're starting to work on (unless already notified for queued messages)
  if (!fromQueue) {
    const queueLen = getQueueLength();
    const queueInfo = queueLen > 0 ? ` | ${queueLen} queued` : '';
    await sendblue.sendMessage(
      phoneNumber,
      `🔄 Starting: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"${queueInfo}`
    );
  }

  // Save to conversation history
  addConversationMessage(phoneNumber, 'user', content);

  try {
    isProcessingMessage = true;
    let activityUpdateCount = 0;

    // Tool activity callback - sends real-time updates when Claude uses tools
    const onToolActivity = async (activity: string) => {
      activityUpdateCount++;
      console.log(`[Activity] ${activity}`);
      try {
        await sendblue.sendMessage(phoneNumber, `🔧 ${activity}`);
      } catch (err) {
        console.error('[Activity] Send failed:', err);
      }
    };

    const response = await askClaude(content, phoneNumber, onToolActivity);

    // Truncate if needed
    const MAX_LENGTH = 15000;
    const finalResponse = response.length > MAX_LENGTH
      ? response.substring(0, MAX_LENGTH) + '\n\n[Truncated]'
      : response;

    // Send final response
    const finalPrefix = activityUpdateCount > 0 ? '✅ Done\n\n' : '';
    await sendblue.sendMessage(phoneNumber, finalPrefix + finalResponse);

    // Save response
    addConversationMessage(phoneNumber, 'assistant', finalResponse);
    trimConversationHistory(phoneNumber, config.conversationWindowSize);

    const duration = ((Date.now() - processStart) / 1000).toFixed(1);
    console.log(`[Process] Done in ${duration}s | ${response.length} chars | ${activityUpdateCount} tool updates`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : '';
    console.error('[Process] Error:', errorMsg, errorStack);
    killCurrentSession();
    await sendblue.sendMessage(
      phoneNumber,
      `⚠️ [UNHANDLED ERROR]\n\nYour message: "${content.substring(0, 50)}..."\n\nError: ${errorMsg}\n\nThis error was not handled. Please report it or try again.`
    );
  } finally {
    isProcessingMessage = false;
  }

  // Check for queued messages
  await processQueue();
}

/**
 * Process queued messages
 */
async function processQueue(): Promise<void> {
  const queueLen = getQueueLength();
  console.log(`[Queue] Checking queue (${queueLen} messages)`);

  const nextMessage = getNextQueuedMessage();
  if (nextMessage && !isProcessingMessage) {
    console.log(`[Queue] Dequeueing message: "${nextMessage.content.substring(0, 50)}..."`);
    removeQueuedMessage(nextMessage.id);
    const remainingQueue = getQueueLength();
    const queueInfo = remainingQueue > 0 ? ` | ${remainingQueue} still queued` : '';
    console.log(`[Queue] ${remainingQueue} messages remaining in queue`);

    // Notify user that their queued message is being processed
    console.log(`[Queue] Sending "Now processing" notification`);
    await sendblue.sendMessage(
      nextMessage.phone_number,
      `📬 Now processing: "${nextMessage.content.substring(0, 50)}${nextMessage.content.length > 50 ? '...' : ''}"${queueInfo}`
    );

    // Process the queued message (pass fromQueue=true to skip duplicate notification)
    await processMessage(
      nextMessage.message_handle,
      nextMessage.phone_number,
      nextMessage.content,
      true
    );
  } else if (nextMessage && isProcessingMessage) {
    console.log(`[Queue] Message available but still processing current message`);
  } else {
    console.log(`[Queue] Queue empty, nothing to process`);
  }
}

/**
 * Handle interrupt command
 */
async function handleInterrupt(phoneNumber: string): Promise<void> {
  const runningTask = getRunningTask();

  if (!runningTask) {
    await sendblue.sendMessage(phoneNumber, 'Nothing to interrupt.');
    return;
  }

  console.log(`[Daemon] Interrupt requested for task ${runningTask.id}`);

  const partialOutput = interruptCurrentTask();

  if (partialOutput?.trim()) {
    const truncated = partialOutput.length > 10000
      ? partialOutput.substring(0, 10000) + '\n\n...'
      : partialOutput;
    await sendblue.sendMessage(
      phoneNumber,
      `[Interrupted]\n\nPartial output:\n${truncated}`
    );
  } else {
    await sendblue.sendMessage(phoneNumber, '[Interrupted] - No output yet.');
  }
}

/**
 * Poll for messages
 */
async function poll(): Promise<void> {
  if (isPolling) {
    console.log(`[Poll] Skipping - already polling`);
    return;
  }

  try {
    isPolling = true;
    const pollStart = Date.now();
    const queueLen = getQueueLength();

    const messages = await sendblue.getInboundMessages(lastPollTime);
    lastPollTime = new Date();
    const pollDuration = Date.now() - pollStart;

    // 1 line for polling status
    const status = isProcessingMessage ? 'busy' : (queueLen > 0 ? `queue=${queueLen}` : 'idle');
    console.log(`[Poll] ${messages.length} msgs (${pollDuration}ms) | ${status}`);

    for (const msg of messages) {
      if (isMessageProcessed(msg.message_handle)) continue;
      if (!isWhitelisted(msg.from_number)) {
        markMessageProcessed(msg.message_handle);
        continue;
      }

      const textContent = msg.content?.trim() || '';
      const mediaUrl = msg.media_url;

      // Skip if no text AND no media
      if (!textContent && !mediaUrl) {
        markMessageProcessed(msg.message_handle);
        continue;
      }

      // Build combined content with media info
      let content = textContent;
      if (mediaUrl) {
        const mediaType = detectMediaType(mediaUrl);
        if (mediaType === 'image') {
          const imageNotice = `[User sent an image: ${mediaUrl}]`;
          content = textContent ? `${textContent}\n\n${imageNotice}` : imageNotice;
          console.log(`[Poll] New image: ${mediaUrl.substring(0, 50)}...`);
        } else if (mediaType === 'audio') {
          // For voice notes, try to transcribe
          console.log(`[Poll] New voice note: ${mediaUrl.substring(0, 50)}...`);
          try {
            const transcription = await transcribeAudio(mediaUrl);
            if (transcription) {
              const voiceNotice = `[Voice note transcription: "${transcription}"]`;
              content = textContent ? `${textContent}\n\n${voiceNotice}` : voiceNotice;
            } else {
              const voiceNotice = `[User sent a voice note: ${mediaUrl}]`;
              content = textContent ? `${textContent}\n\n${voiceNotice}` : voiceNotice;
            }
          } catch (err) {
            console.error('[Poll] Transcription failed:', err);
            const voiceNotice = `[User sent a voice note: ${mediaUrl}]`;
            content = textContent ? `${textContent}\n\n${voiceNotice}` : voiceNotice;
          }
        } else {
          const fileNotice = `[User sent a file: ${mediaUrl}]`;
          content = textContent ? `${textContent}\n\n${fileNotice}` : fileNotice;
        }
      }

      // 1 line per new message
      console.log(`[Poll] New: "${content.substring(0, 80)}${content.length > 80 ? '...' : ''}"`);
      markMessageProcessed(msg.message_handle);

      // Handle help command immediately
      if (isHelpCommand(content)) {
        await sendblue.sendMessage(msg.from_number, HELP_MESSAGE);
        continue;
      }

      // Handle status command immediately (even while processing)
      if (isStatusCommand(content)) {
        await sendblue.sendMessage(msg.from_number, getStatus());
        continue;
      }

      // Handle queue command immediately - show what's in the queue
      if (isQueueCommand(content)) {
        const queuedMessages = getAllQueuedMessages();
        if (queuedMessages.length === 0) {
          await sendblue.sendMessage(msg.from_number, '📭 Queue is empty');
        } else {
          let queueDisplay = `📥 Queue (${queuedMessages.length}):\n`;
          queuedMessages.forEach((qm, idx) => {
            const preview = qm.content.substring(0, 40) + (qm.content.length > 40 ? '...' : '');
            const timeAgo = formatTimeAgo(qm.queued_at);
            queueDisplay += `${idx + 1}. "${preview}" (${timeAgo})\n`;
          });
          await sendblue.sendMessage(msg.from_number, queueDisplay.trim());
        }
        continue;
      }

      // Handle history command - show recent messages and outcomes
      const historyResult = isHistoryCommand(content);
      if (historyResult.isHistory) {
        const history = getConversationHistory(msg.from_number, 20);

        // Pair user messages with their responses
        const pairs: Array<{ user: string; response: string | null; timestamp: number }> = [];
        for (let i = 0; i < history.length; i++) {
          if (history[i].role === 'user') {
            const response = (i + 1 < history.length && history[i + 1].role === 'assistant')
              ? history[i + 1].content
              : null;
            pairs.push({
              user: history[i].content,
              response,
              timestamp: history[i].timestamp
            });
          }
        }

        // Reverse to show most recent first
        pairs.reverse();

        if (pairs.length === 0) {
          await sendblue.sendMessage(msg.from_number, '📜 No history yet');
          continue;
        }

        // If expanding a specific item
        if (historyResult.expandIndex !== null) {
          const idx = historyResult.expandIndex - 1; // 1-indexed for user
          if (idx < 0 || idx >= pairs.length) {
            await sendblue.sendMessage(msg.from_number, `❌ Invalid index. Use 1-${pairs.length}`);
          } else {
            const item = pairs[idx];
            const timeAgo = formatTimeAgo(item.timestamp);
            let detail = `📜 #${historyResult.expandIndex} (${timeAgo})\n\n`;
            detail += `📤 You: "${item.user}"\n\n`;
            if (item.response) {
              const truncated = item.response.length > 1500
                ? item.response.substring(0, 1500) + '\n\n[Truncated]'
                : item.response;
              detail += `📥 Claude: ${truncated}`;
            } else {
              detail += `⏳ No response yet (may be processing)`;
            }
            await sendblue.sendMessage(msg.from_number, detail);
          }
          continue;
        }

        // Show summary list
        let historyDisplay = `📜 History (${pairs.length}):\n`;
        const showCount = Math.min(pairs.length, 10);
        for (let i = 0; i < showCount; i++) {
          const item = pairs[i];
          const preview = item.user.substring(0, 35) + (item.user.length > 35 ? '...' : '');
          const status = item.response ? '✓' : '⏳';
          const timeAgo = formatTimeAgo(item.timestamp);
          historyDisplay += `${i + 1}. ${status} "${preview}" (${timeAgo})\n`;
        }
        if (pairs.length > 10) {
          historyDisplay += `\n...and ${pairs.length - 10} more`;
        }
        historyDisplay += `\n\nUse "history N" to expand`;
        await sendblue.sendMessage(msg.from_number, historyDisplay.trim());
        continue;
      }

      // Handle interrupt command immediately
      if (isInterruptCommand(content)) {
        await handleInterrupt(msg.from_number);
        continue;
      }

      // Handle home command - go to home directory
      if (isHomeCommand(content)) {
        const homeDir = os.homedir();
        setWorkingDirectory(homeDir);
        killCurrentSession();
        await sendblue.sendMessage(msg.from_number, `🏠 Now in: ${homeDir}`);
        continue;
      }

      // Handle reset/fresh command - go home AND clear conversation
      if (isResetCommand(content)) {
        const homeDir = os.homedir();
        setWorkingDirectory(homeDir);
        clearConversationHistory(msg.from_number);
        killCurrentSession();
        await sendblue.sendMessage(msg.from_number, `🔄 Fresh start!\nDirectory: ${homeDir}\nChat history cleared.`);
        continue;
      }

      // Handle cd command - change to specific directory
      const cdResult = isCdCommand(content);
      if (cdResult.isCD) {
        if (cdResult.error) {
          await sendblue.sendMessage(msg.from_number, `❌ ${cdResult.error}`);
        } else if (cdResult.path) {
          if (fs.existsSync(cdResult.path) && fs.statSync(cdResult.path).isDirectory()) {
            setWorkingDirectory(cdResult.path);
            killCurrentSession();
            await sendblue.sendMessage(msg.from_number, `📂 Now in: ${cdResult.path}`);
          } else {
            await sendblue.sendMessage(msg.from_number, `❌ Directory not found: ${cdResult.path}`);
          }
        }
        continue;
      }

      // Check for pending approval response
      const pendingApproval = getPendingApproval(msg.from_number);
      if (pendingApproval) {
        const { isApproval, approved } = isApprovalResponse(content);
        if (isApproval) {
          removePendingApproval(pendingApproval.id);
          if (approved) {
            await sendblue.sendMessage(msg.from_number, '✅ Approved. Executing...');
          } else {
            await sendblue.sendMessage(msg.from_number, '❌ Rejected. Command cancelled.');
          }
          continue;
        }
      }

      // If busy, queue the message and notify user
      if (isProcessingMessage || getRunningTask()) {
        queueMessage(msg.message_handle, msg.from_number, content);
        const qLen = getQueueLength();
        console.log(`[Poll] Queued (${qLen} in queue)`);
        await sendblue.sendMessage(
          msg.from_number,
          `📥 Queued (position ${qLen}): "${content.substring(0, 40)}${content.length > 40 ? '...' : ''}"`
        );
        continue;
      }

      // Process the message WITHOUT awaiting - allows poll loop to continue
      // This enables immediate commands (queue, status, interrupt) to be handled
      // even while Claude is working on a task
      processMessage(msg.message_handle, msg.from_number, content).catch(
        async (outerError) => {
          // This catches errors that escape processMessage's own try/catch
          const errorMsg = outerError instanceof Error ? outerError.message : String(outerError);
          console.error('[Poll] Message processing failed:', errorMsg);
          try {
            await sendblue.sendMessage(
              msg.from_number,
              `⚠️ [SYSTEM ERROR]\n\nFailed to process: "${content.substring(0, 40)}..."\n\nError: ${errorMsg}\n\nPlease try again or report this issue.`
            );
          } catch (sendErr) {
            console.error('[Poll] Failed to send error notification:', sendErr);
          }
        }
      );
    }

    // Process queued messages if not busy
    if (!isProcessingMessage && getQueueLength() > 0) {
      console.log(`[Poll] Processing queued message`);
      await processQueue();
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : '';
    console.error('[Poll] Poll error:', errorMsg, errorStack || error);
  } finally {
    isPolling = false;
  }
}

/**
 * Start polling
 */
function startPolling(): void {
  console.log(`[Daemon] Polling every ${config.pollIntervalMs}ms`);
  poll();
  pollInterval = setInterval(poll, config.pollIntervalMs);
}

/**
 * Shutdown - with graceful handling if processing a message
 */
let shutdownRequested = false;
async function shutdown(signal: string): Promise<void> {
  console.log(`[Daemon] ${signal} received...`);

  // If already shutting down, force exit
  if (shutdownRequested) {
    console.log('[Daemon] Force exit (second signal)');
    process.exit(1);
  }
  shutdownRequested = true;

  // If processing a message, wait for it to finish (up to 30 seconds)
  if (isProcessingMessage) {
    console.log('[Daemon] Waiting for current task to complete (up to 30s)...');
    const maxWait = 30000;
    const startWait = Date.now();
    while (isProcessingMessage && (Date.now() - startWait) < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (isProcessingMessage) {
      console.log('[Daemon] Timed out waiting for task, forcing shutdown');
    } else {
      console.log('[Daemon] Task completed, proceeding with shutdown');
    }
  }

  if (pollInterval) clearInterval(pollInterval);
  killCurrentSession();
  closeDb();
  releaseLock();

  console.log('[Daemon] Shutdown complete');
  process.exit(0);
}

/**
 * Send crash notification via Sendblue
 */
async function sendCrashNotification(error: Error | string, context: string): Promise<void> {
  try {
    // Only send if sendblue is initialized
    if (!sendblue || !config?.whitelist?.length) {
      console.error('[Daemon] Cannot send crash notification - sendblue not initialized');
      return;
    }

    const errorMsg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack?.split('\n').slice(0, 3).join('\n') : '';

    const notification = `🚨 TextMe Daemon Crashed!\n\nContext: ${context}\nError: ${errorMsg}\n\n${stack ? `Stack:\n${stack}` : ''}`;

    // Send to primary user
    const primaryNumber = config.whitelist[0];
    await sendblue.sendMessage(primaryNumber, notification);
    console.log(`[Daemon] Crash notification sent to ${primaryNumber}`);
  } catch (notifyError) {
    console.error('[Daemon] Failed to send crash notification:', notifyError);
  }
}

/**
 * Main
 */
async function main(): Promise<void> {
  // Acquire lock first - exit if another instance is running
  if (!acquireLock()) {
    console.error('[Daemon] Exiting - another instance is already running');
    process.exit(1);
  }

  // Setup file logging
  setupLogging();

  // Setup crash handlers BEFORE init (so we can catch init failures)
  process.on('uncaughtException', async (error) => {
    console.error('[Daemon] Uncaught exception:', error);
    await sendCrashNotification(error, 'uncaughtException');
    releaseLock();
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    console.error('[Daemon] Unhandled rejection:', error);
    await sendCrashNotification(error, 'unhandledRejection');
    releaseLock();
    process.exit(1);
  });

  try {
    await init();
    startPolling();

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    console.log('[Daemon] Running. Ctrl+C to stop.');
  } catch (error) {
    console.error('[Daemon] Fatal:', error);
    await sendCrashNotification(error as Error, 'init failure');
    releaseLock();
    process.exit(1);
  }
}

main();
