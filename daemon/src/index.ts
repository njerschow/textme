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
  getPendingApproval,
  addPendingApproval,
  removePendingApproval,
  cleanupExpiredApprovals,
  getState,
  setState,
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
 * Acquire lock - ensures only one instance runs at a time
 */
function acquireLock(): boolean {
  try {
    // Check if PID file exists
    if (fs.existsSync(PID_FILE)) {
      const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);

      // Check if that process is still running
      try {
        process.kill(existingPid, 0); // Signal 0 just checks if process exists
        console.error(`[Daemon] Another instance is already running (PID: ${existingPid})`);
        return false;
      } catch {
        // Process doesn't exist, stale PID file - we can take over
        console.log(`[Daemon] Removing stale PID file (old PID: ${existingPid})`);
      }
    }

    // Write our PID
    fs.writeFileSync(PID_FILE, process.pid.toString());
    console.log(`[Daemon] Lock acquired (PID: ${process.pid})`);
    return true;
  } catch (error) {
    console.error('[Daemon] Failed to acquire lock:', error);
    return false;
  }
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
 * Get the current working directory (persisted in DB)
 */
function getWorkingDirectory(): string {
  const stored = getState('working_directory');
  return stored || os.homedir();
}

/**
 * Set the current working directory (persisted in DB)
 */
function setWorkingDirectory(dir: string): void {
  setState('working_directory', dir);
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
• home - Go to home directory
• reset / fresh - Home + clear chat history
• cd <path> - Change directory
• interrupt / stop - Stop current task
• yes / no - Approval responses

Everything else goes to Claude.`;

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

function isCdCommand(content: string): { isCD: boolean; path: string | null } {
  const normalized = content.trim();
  // Match "cd /path" or "cd ~/path" or "cd /path/to/dir"
  const match = normalized.match(/^cd\s+(.+)$/i);
  if (match) {
    let targetPath = match[1].trim();
    // Expand ~ to home directory
    if (targetPath.startsWith('~')) {
      targetPath = targetPath.replace(/^~/, os.homedir());
    }
    return { isCD: true, path: targetPath };
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

  // Format context from history (exclude the current message which was just added)
  let contextPrompt = '';
  if (history.length > 1) {
    contextPrompt = 'Previous conversation:\n';
    for (const msg of history.slice(0, -1)) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      contextPrompt += `${role}: ${msg.content}\n\n`;
    }
    contextPrompt += '---\nCurrent message:\n';
  }

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
  console.log(`\n[Process] ====== STARTING MESSAGE PROCESSING ======`);
  console.log(`[Process] Content: "${content.substring(0, 80)}${content.length > 80 ? '...' : ''}"`);
  console.log(`[Process] From queue: ${fromQueue}`);
  console.log(`[Process] Phone: ${phoneNumber}`);
  console.log(`[Process] Handle: ${messageHandle.substring(0, 20)}...`);

  // Notify what we're starting to work on (unless already notified for queued messages)
  if (!fromQueue) {
    const queueLen = getQueueLength();
    const queueInfo = queueLen > 0 ? ` | ${queueLen} queued` : '';
    console.log(`[Process] Sending start notification (queue: ${queueLen})`);
    await sendblue.sendMessage(
      phoneNumber,
      `🔄 Starting: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"${queueInfo}`
    );
  }

  // Save to conversation history
  addConversationMessage(phoneNumber, 'user', content);
  console.log(`[Process] Saved to conversation history`);

  try {
    isProcessingMessage = true;
    console.log(`[Process] Set isProcessingMessage=true`);

    // Track tool activity updates sent
    let activityUpdateCount = 0;

    // Tool activity callback - sends real-time updates when Claude uses tools
    const onToolActivity = async (activity: string) => {
      activityUpdateCount++;
      console.log(`[Activity] #${activityUpdateCount}: ${activity}`);

      try {
        // Send tool activity as a brief update
        await sendblue.sendMessage(phoneNumber, `🔧 ${activity}`);
        console.log(`[Activity] Message sent`);
      } catch (err) {
        console.error('[Activity] Failed to send activity update:', err);
      }
    };

    // Send to Claude with tool activity callback
    console.log(`[Process] Calling askClaude (verbose mode with tool activity)`);
    const claudeStart = Date.now();
    const response = await askClaude(content, phoneNumber, onToolActivity);
    const claudeDuration = Date.now() - claudeStart;
    console.log(`[Process] Claude responded in ${claudeDuration}ms`);
    console.log(`[Process] Response length: ${response.length} chars`);

    // Truncate if needed
    const MAX_LENGTH = 15000;
    const finalResponse = response.length > MAX_LENGTH
      ? response.substring(0, MAX_LENGTH) + '\n\n[Truncated]'
      : response;

    // Send final response (marked as complete if we sent activity updates)
    const finalPrefix = activityUpdateCount > 0 ? '✅ Done\n\n' : '';
    console.log(`[Process] Sending final response (${activityUpdateCount} activity updates sent)`);
    await sendblue.sendMessage(phoneNumber, finalPrefix + finalResponse);

    // Save response
    addConversationMessage(phoneNumber, 'assistant', finalResponse);
    trimConversationHistory(phoneNumber, config.conversationWindowSize);

    const totalDuration = Date.now() - processStart;
    console.log(`[Process] ====== PROCESSING COMPLETE ======`);
    console.log(`[Process] Total time: ${totalDuration}ms`);
    console.log(`[Process] Activity updates: ${activityUpdateCount}`);
  } catch (error) {
    console.error('[Process] ====== ERROR ======');
    console.error('[Process] Error:', error);

    // Kill session on error so it restarts fresh
    console.log(`[Process] Killing session due to error`);
    killCurrentSession();

    await sendblue.sendMessage(
      phoneNumber,
      `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  } finally {
    isProcessingMessage = false;
    console.log(`[Process] Set isProcessingMessage=false`);
  }

  // Check for queued messages
  console.log(`[Process] Checking queue for next message`);
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

    // Only log when there's something interesting (messages found, queue, or slow poll)
    if (messages.length > 0) {
      console.log(`[Poll] Found ${messages.length} message(s) (${pollDuration}ms)`);
    } else if (queueLen > 0 || isProcessingMessage) {
      console.log(`[Poll] No new messages | processing=${isProcessingMessage} queue=${queueLen}`);
    }
    // Silent when idle with no messages

    for (const msg of messages) {
      if (isMessageProcessed(msg.message_handle)) {
        console.log(`[Poll] Skipping already processed: ${msg.message_handle.substring(0, 20)}...`);
        continue;
      }

      if (!isWhitelisted(msg.from_number)) {
        console.log(`[Poll] Ignoring non-whitelisted: ${msg.from_number}`);
        markMessageProcessed(msg.message_handle);
        continue;
      }

      const content = msg.content?.trim();
      if (!content) {
        console.log(`[Poll] Skipping empty message from ${msg.from_number}`);
        markMessageProcessed(msg.message_handle);
        continue;
      }

      console.log(`[Poll] === NEW MESSAGE ===`);
      console.log(`[Poll] From: ${msg.from_number}`);
      console.log(`[Poll] Handle: ${msg.message_handle}`);
      console.log(`[Poll] Content: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);
      console.log(`[Poll] Received at: ${msg.created_at || 'unknown'}`);
      markMessageProcessed(msg.message_handle);

      // Handle help command immediately
      if (isHelpCommand(content)) {
        console.log(`[Poll] Handling help command`);
        await sendblue.sendMessage(msg.from_number, HELP_MESSAGE);
        continue;
      }

      // Handle status command immediately (even while processing)
      if (isStatusCommand(content)) {
        console.log(`[Poll] Handling status command`);
        await sendblue.sendMessage(msg.from_number, getStatus());
        continue;
      }

      // Handle interrupt command immediately
      if (isInterruptCommand(content)) {
        console.log(`[Poll] Handling interrupt command`);
        await handleInterrupt(msg.from_number);
        continue;
      }

      // Handle home command - go to home directory
      if (isHomeCommand(content)) {
        console.log(`[Poll] Handling home command`);
        const homeDir = os.homedir();
        setWorkingDirectory(homeDir);
        killCurrentSession(); // Kill session so it restarts in new dir
        await sendblue.sendMessage(msg.from_number, `🏠 Now in: ${homeDir}`);
        continue;
      }

      // Handle reset/fresh command - go home AND clear conversation
      if (isResetCommand(content)) {
        console.log(`[Poll] Handling reset command`);
        const homeDir = os.homedir();
        setWorkingDirectory(homeDir);
        clearConversationHistory(msg.from_number);
        killCurrentSession(); // Kill session so it restarts fresh
        await sendblue.sendMessage(msg.from_number, `🔄 Fresh start!\nDirectory: ${homeDir}\nChat history cleared.`);
        continue;
      }

      // Handle cd command - change to specific directory
      const cdResult = isCdCommand(content);
      if (cdResult.isCD && cdResult.path) {
        console.log(`[Poll] Handling cd command: ${cdResult.path}`);
        // Validate the path exists
        if (fs.existsSync(cdResult.path) && fs.statSync(cdResult.path).isDirectory()) {
          setWorkingDirectory(cdResult.path);
          killCurrentSession(); // Kill session so it restarts in new dir
          await sendblue.sendMessage(msg.from_number, `📂 Now in: ${cdResult.path}`);
        } else {
          await sendblue.sendMessage(msg.from_number, `❌ Directory not found: ${cdResult.path}`);
        }
        continue;
      }

      // Check for pending approval response
      const pendingApproval = getPendingApproval(msg.from_number);
      if (pendingApproval) {
        console.log(`[Poll] Checking if message is approval response`);
        const { isApproval, approved } = isApprovalResponse(content);
        if (isApproval) {
          console.log(`[Poll] Handling approval response: approved=${approved}`);
          removePendingApproval(pendingApproval.id);
          if (approved) {
            await sendblue.sendMessage(msg.from_number, '✅ Approved. Executing...');
            // TODO: Resume the paused command
          } else {
            await sendblue.sendMessage(msg.from_number, '❌ Rejected. Command cancelled.');
            // TODO: Cancel the paused command
          }
          continue;
        }
      }

      // If busy, queue the message and notify user
      if (isProcessingMessage || getRunningTask()) {
        const runningTask = getRunningTask();
        console.log(`[Poll] BUSY - queuing message`);
        console.log(`[Poll]   isProcessingMessage=${isProcessingMessage}`);
        console.log(`[Poll]   runningTask=${runningTask?.description?.substring(0, 50) || 'none'}`);
        queueMessage(msg.message_handle, msg.from_number, content);
        const queueLen = getQueueLength();
        console.log(`[Poll]   New queue length: ${queueLen}`);
        await sendblue.sendMessage(
          msg.from_number,
          `📥 Queued (position ${queueLen}): "${content.substring(0, 40)}${content.length > 40 ? '...' : ''}"`
        );
        continue;
      }

      // Process the message
      await processMessage(msg.message_handle, msg.from_number, content);
    }

    // Process queued messages if not busy
    if (!isProcessingMessage && getQueueLength() > 0) {
      console.log(`[Poll] Processing queued message`);
      await processQueue();
    }
  } catch (error) {
    console.error('[Poll] Poll error:', error);
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
 * Shutdown
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`[Daemon] ${signal} received, shutting down...`);

  if (pollInterval) clearInterval(pollInterval);
  killCurrentSession();
  closeDb();
  releaseLock();

  console.log('[Daemon] Shutdown complete');
  process.exit(0);
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

  try {
    await init();
    startPolling();

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    console.log('[Daemon] Running. Ctrl+C to stop.');
  } catch (error) {
    console.error('[Daemon] Fatal:', error);
    releaseLock();
    process.exit(1);
  }
}

main();
