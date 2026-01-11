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
import { getOrCreateSession, killCurrentSession, getCurrentSession, interruptCurrentTask, } from './claude-session.js';
import { initDb, closeDb, isMessageProcessed, markMessageProcessed, addConversationMessage, getConversationHistory, trimConversationHistory, clearConversationHistory, cleanupOldProcessedMessages, getRunningTask, queueMessage, getNextQueuedMessage, removeQueuedMessage, getQueueLength, getAllQueuedMessages, getPendingApproval, removePendingApproval, cleanupExpiredApprovals, getState, setState, getLastConversationInfo, } from './db.js';
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
function setupLogging() {
    // Ensure log directory exists
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    // Create write stream for log file
    const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    // Override console.log and console.error to write to both stdout and file
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => {
        const timestamp = new Date().toISOString();
        const message = `[${timestamp}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
        originalLog.apply(console, args);
        logStream.write(message + '\n');
    };
    console.error = (...args) => {
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
function acquireLock() {
    try {
        // Check if PID file exists
        if (fs.existsSync(PID_FILE)) {
            const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
            // Check if that process is still running
            try {
                process.kill(existingPid, 0); // Signal 0 just checks if process exists
                console.error(`[Daemon] Another instance is already running (PID: ${existingPid})`);
                return false;
            }
            catch {
                // Process doesn't exist, stale PID file - we can take over
                console.log(`[Daemon] Removing stale PID file (old PID: ${existingPid})`);
            }
        }
        // Write our PID
        fs.writeFileSync(PID_FILE, process.pid.toString());
        console.log(`[Daemon] Lock acquired (PID: ${process.pid})`);
        return true;
    }
    catch (error) {
        console.error('[Daemon] Failed to acquire lock:', error);
        return false;
    }
}
/**
 * Release lock on shutdown
 */
function releaseLock() {
    try {
        if (fs.existsSync(PID_FILE)) {
            const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
            if (pid === process.pid) {
                fs.unlinkSync(PID_FILE);
                console.log('[Daemon] Lock released');
            }
        }
    }
    catch (error) {
        console.error('[Daemon] Failed to release lock:', error);
    }
}
// Global state
let config;
let sendblue;
let pollInterval = null;
let lastPollTime;
let isPolling = false;
let isProcessingMessage = false;
/**
 * Format a timestamp as a relative time (e.g., "2 hours ago")
 */
function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60)
        return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
/**
 * Get the current working directory (persisted in DB)
 */
function getWorkingDirectory() {
    const stored = getState('current_project');
    return stored || os.homedir();
}
/**
 * Set the current working directory (persisted in DB)
 */
function setWorkingDirectory(dir) {
    setState('current_project', dir);
}
/**
 * Initialize the daemon
 */
async function init() {
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
    }
    catch (error) {
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
        }
        catch (err) {
            console.error('[Daemon] Failed to send startup notification:', err);
        }
    }
}
/**
 * Check if phone number is whitelisted
 */
function isWhitelisted(phoneNumber) {
    const normalize = (num) => num.replace(/\D/g, '');
    const normalized = normalize(phoneNumber);
    return config.whitelist.some(w => normalize(w) === normalized);
}
/**
 * Get daemon status
 */
function getStatus() {
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
    }
    else {
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
• home - Go to home directory
• reset / fresh - Home + clear chat history
• cd <path> - Change directory
• interrupt / stop - Stop current task
• yes / no - Approval responses

Everything else goes to Claude.`;
/**
 * Check for special commands
 */
function isHelpCommand(content) {
    const normalized = content.toLowerCase().trim();
    return normalized === 'help' || normalized === '?';
}
function isStatusCommand(content) {
    const normalized = content.toLowerCase().trim();
    return normalized === 'status' || normalized === 'status?';
}
function isQueueCommand(content) {
    const normalized = content.toLowerCase().trim();
    return normalized === 'queue' || normalized === 'q';
}
function isInterruptCommand(content) {
    const normalized = content.toLowerCase().trim();
    return normalized === 'interrupt' || normalized === 'stop' || normalized === 'cancel';
}
function isHomeCommand(content) {
    const normalized = content.toLowerCase().trim();
    return normalized === 'home';
}
function isResetCommand(content) {
    const normalized = content.toLowerCase().trim();
    return normalized === 'reset' || normalized === 'fresh' || normalized === 'new session';
}
function isCdCommand(content) {
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
function isApprovalResponse(content) {
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
async function askClaude(message, phoneNumber, onToolActivity) {
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
    const callbacks = onToolActivity ? {
        onToolActivity,
        activityIntervalMs: 1000, // Send activity updates at most once per second
    } : undefined;
    const response = await session.send(fullMessage, taskId, callbacks);
    return response || 'No response from Claude.';
}
/**
 * Process a single message
 */
async function processMessage(messageHandle, phoneNumber, content, fromQueue = false) {
    const processStart = Date.now();
    const contentPreview = content.substring(0, 60) + (content.length > 60 ? '...' : '');
    console.log(`[Process] Starting: "${contentPreview}"${fromQueue ? ' (from queue)' : ''}`);
    // Notify what we're starting to work on (unless already notified for queued messages)
    if (!fromQueue) {
        const queueLen = getQueueLength();
        const queueInfo = queueLen > 0 ? ` | ${queueLen} queued` : '';
        await sendblue.sendMessage(phoneNumber, `🔄 Starting: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"${queueInfo}`);
    }
    // Save to conversation history
    addConversationMessage(phoneNumber, 'user', content);
    try {
        isProcessingMessage = true;
        let activityUpdateCount = 0;
        // Tool activity callback - sends real-time updates when Claude uses tools
        const onToolActivity = async (activity) => {
            activityUpdateCount++;
            console.log(`[Activity] ${activity}`);
            try {
                await sendblue.sendMessage(phoneNumber, `🔧 ${activity}`);
            }
            catch (err) {
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
    }
    catch (error) {
        console.error('[Process] Error:', error);
        killCurrentSession();
        await sendblue.sendMessage(phoneNumber, `Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    finally {
        isProcessingMessage = false;
    }
    // Check for queued messages
    await processQueue();
}
/**
 * Process queued messages
 */
async function processQueue() {
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
        await sendblue.sendMessage(nextMessage.phone_number, `📬 Now processing: "${nextMessage.content.substring(0, 50)}${nextMessage.content.length > 50 ? '...' : ''}"${queueInfo}`);
        // Process the queued message (pass fromQueue=true to skip duplicate notification)
        await processMessage(nextMessage.message_handle, nextMessage.phone_number, nextMessage.content, true);
    }
    else if (nextMessage && isProcessingMessage) {
        console.log(`[Queue] Message available but still processing current message`);
    }
    else {
        console.log(`[Queue] Queue empty, nothing to process`);
    }
}
/**
 * Handle interrupt command
 */
async function handleInterrupt(phoneNumber) {
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
        await sendblue.sendMessage(phoneNumber, `[Interrupted]\n\nPartial output:\n${truncated}`);
    }
    else {
        await sendblue.sendMessage(phoneNumber, '[Interrupted] - No output yet.');
    }
}
/**
 * Poll for messages
 */
async function poll() {
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
            if (isMessageProcessed(msg.message_handle))
                continue;
            if (!isWhitelisted(msg.from_number)) {
                markMessageProcessed(msg.message_handle);
                continue;
            }
            const content = msg.content?.trim();
            if (!content) {
                markMessageProcessed(msg.message_handle);
                continue;
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
                }
                else {
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
            if (cdResult.isCD && cdResult.path) {
                if (fs.existsSync(cdResult.path) && fs.statSync(cdResult.path).isDirectory()) {
                    setWorkingDirectory(cdResult.path);
                    killCurrentSession();
                    await sendblue.sendMessage(msg.from_number, `📂 Now in: ${cdResult.path}`);
                }
                else {
                    await sendblue.sendMessage(msg.from_number, `❌ Directory not found: ${cdResult.path}`);
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
                    }
                    else {
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
                await sendblue.sendMessage(msg.from_number, `📥 Queued (position ${qLen}): "${content.substring(0, 40)}${content.length > 40 ? '...' : ''}"`);
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
    }
    catch (error) {
        console.error('[Poll] Poll error:', error);
    }
    finally {
        isPolling = false;
    }
}
/**
 * Start polling
 */
function startPolling() {
    console.log(`[Daemon] Polling every ${config.pollIntervalMs}ms`);
    poll();
    pollInterval = setInterval(poll, config.pollIntervalMs);
}
/**
 * Shutdown
 */
async function shutdown(signal) {
    console.log(`[Daemon] ${signal} received, shutting down...`);
    if (pollInterval)
        clearInterval(pollInterval);
    killCurrentSession();
    closeDb();
    releaseLock();
    console.log('[Daemon] Shutdown complete');
    process.exit(0);
}
/**
 * Main
 */
async function main() {
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
    }
    catch (error) {
        console.error('[Daemon] Fatal:', error);
        releaseLock();
        process.exit(1);
    }
}
main();
