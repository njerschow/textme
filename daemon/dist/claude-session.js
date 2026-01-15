/**
 * Claude Code CLI wrapper - STREAM JSON MODE
 * Uses `claude --output-format stream-json` for real-time tool activity
 * Each line is a JSON event we parse for tool_use and text content
 */
import { spawn, execSync } from 'child_process';
import { setRunningTask, clearRunningTask, updateRunningTaskPid } from './db.js';
// Find claude binary path
function findClaudePath() {
    try {
        return execSync('which claude', { encoding: 'utf-8' }).trim();
    }
    catch {
        const paths = [
            '/usr/local/bin/claude',
            `${process.env.HOME}/.local/bin/claude`,
        ];
        for (const p of paths) {
            try {
                execSync(`test -x "${p}"`);
                return p;
            }
            catch { }
        }
        return 'claude';
    }
}
const CLAUDE_PATH = findClaudePath();
// Tool names we care about for activity updates
const TOOL_DISPLAY_NAMES = {
    'Read': 'Reading',
    'Glob': 'Searching files',
    'Grep': 'Grep',
    'Bash': 'Running',
    'Write': 'Writing',
    'Edit': 'Editing',
    'Task': 'Task',
    'WebFetch': 'Fetching',
    'WebSearch': 'Searching web',
    'TodoWrite': 'Updating todos',
};
export class ClaudeSession {
    config;
    isActive_ = true;
    currentTaskId = null;
    currentProcess = null;
    partialOutput = '';
    constructor(config) {
        this.config = config;
    }
    async start() {
        console.log(`[ClaudeSession] Ready in ${this.config.workingDirectory}`);
        console.log(`[ClaudeSession] Using claude at: ${CLAUDE_PATH}`);
    }
    /**
     * Send a message and get response - with real-time streaming via stream-json
     * Includes retry logic for transient API errors (529 overloaded, etc.)
     */
    async send(message, taskId, callbacks) {
        const maxRetries = 3;
        const baseDelayMs = 5000; // 5 seconds initial delay
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await this.sendAttempt(message, taskId, callbacks, attempt);
            }
            catch (error) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                const isRetryable = errorMsg.includes('529') ||
                    errorMsg.includes('overload') ||
                    errorMsg.includes('Overloaded') ||
                    errorMsg.includes('rate_limit') ||
                    errorMsg.includes('capacity');
                if (isRetryable && attempt < maxRetries) {
                    const delayMs = baseDelayMs * Math.pow(2, attempt - 1); // Exponential backoff
                    console.log(`[Claude] Retryable error (attempt ${attempt}/${maxRetries}), waiting ${delayMs / 1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    continue;
                }
                // Non-retryable or exhausted retries
                throw error;
            }
        }
        throw new Error('Unexpected: retry loop exited without return or throw');
    }
    /**
     * Single attempt to send message to Claude
     */
    async sendAttempt(message, taskId, callbacks, attempt) {
        console.log(`[Claude] ====== STARTING (stream-json mode) attempt ${attempt} ======`);
        console.log(`[Claude] Task: ${taskId || 'none'} | ${message.length} chars | ${this.config.workingDirectory}`);
        if (!this.isActive_) {
            throw new Error('Claude session not active');
        }
        if (taskId) {
            this.currentTaskId = taskId;
            setRunningTask(taskId, message.substring(0, 100));
        }
        this.partialOutput = '';
        const { onToolActivity, activityIntervalMs = 1000 } = callbacks || {};
        return new Promise((resolve, reject) => {
            let textOutput = '';
            let errorOutput = '';
            let lastActivityTime = 0;
            let toolCount = 0;
            const startTime = Date.now();
            // System prompt to give Claude context about how it's being used
            const systemPrompt = `You are being accessed via iMessage through the TextMe daemon. The user is texting you from their phone. Keep responses concise and mobile-friendly - avoid lengthy code blocks or verbose explanations unless specifically requested. You have full file system access and can help with coding tasks, but remember the user is reading your responses on a small screen.`;
            // Use stream-json for real-time events
            const args = [
                '--print',
                '--output-format', 'stream-json',
                '--verbose', // Required for stream-json
                '--continue',
                '--permission-mode', 'bypassPermissions',
                '--system-prompt', systemPrompt,
            ];
            console.log(`[Claude] Spawning: ${CLAUDE_PATH} ${args.join(' ')}`);
            const proc = spawn(CLAUDE_PATH, args, {
                cwd: this.config.workingDirectory,
                env: { ...process.env },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            this.currentProcess = proc;
            console.log(`[Claude] PID: ${proc.pid}`);
            if (proc.pid && this.currentTaskId) {
                updateRunningTaskPid(this.currentTaskId, proc.pid);
            }
            // Parse each JSON line as it arrives
            let lineBuffer = '';
            proc.stdout.on('data', (data) => {
                const text = data.toString();
                lineBuffer += text;
                // Process complete lines
                const lines = lineBuffer.split('\n');
                lineBuffer = lines.pop() || ''; // Keep incomplete line
                for (const line of lines) {
                    if (!line.trim())
                        continue;
                    try {
                        const event = JSON.parse(line);
                        this.processStreamEvent(event, {
                            onToolActivity,
                            activityIntervalMs,
                            lastActivityTime: () => lastActivityTime,
                            setLastActivityTime: (t) => { lastActivityTime = t; },
                            incrementToolCount: () => { toolCount++; },
                            appendText: (t) => { textOutput += t; },
                        });
                    }
                    catch (e) {
                        // Not JSON - might be raw output, append it
                        if (line.trim() && !line.startsWith('{')) {
                            textOutput += line + '\n';
                        }
                    }
                }
                this.partialOutput = textOutput;
            });
            proc.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });
            proc.on('error', (error) => {
                console.error(`[Claude] Process error:`, error);
                this.cleanup();
                reject(error);
            });
            proc.on('close', (code) => {
                const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                this.currentProcess = null;
                this.cleanup();
                console.log(`[Claude] Done: ${duration}s | ${toolCount} tools | ${textOutput.length} chars | exit ${code}`);
                if (textOutput.trim()) {
                    resolve(textOutput.trim());
                }
                else if (code !== 0) {
                    reject(new Error(`Claude exited with code ${code}: ${errorOutput}`));
                }
                else {
                    resolve('No response from Claude.');
                }
            });
            // Timeout after 10 minutes
            const timeout = setTimeout(() => {
                console.log('[Claude] TIMEOUT - killing after 10 minutes');
                this.kill();
                if (textOutput.trim()) {
                    resolve(textOutput.trim() + '\n\n[Timed out]');
                }
                else {
                    reject(new Error('Response timeout'));
                }
            }, 10 * 60 * 1000);
            proc.on('close', () => clearTimeout(timeout));
            // Send the message
            console.log(`[Claude] Sending message...`);
            proc.stdin.write(message);
            proc.stdin.end();
        });
    }
    /**
     * Process a stream-json event
     */
    processStreamEvent(event, ctx) {
        // Handle different event types
        // Format: {"type": "...", ...}
        if (event.type === 'assistant' && event.message?.content) {
            // Assistant message with content blocks
            for (const block of event.message.content) {
                if (block.type === 'tool_use') {
                    ctx.incrementToolCount();
                    const toolName = block.name || 'Unknown';
                    const displayName = TOOL_DISPLAY_NAMES[toolName] || toolName;
                    // Build activity description
                    let activity = displayName;
                    if (block.input) {
                        if (block.input.file_path) {
                            activity += `: ${block.input.file_path}`;
                        }
                        else if (block.input.command) {
                            const cmd = block.input.command.substring(0, 100);
                            activity += `: ${cmd}${block.input.command.length > 100 ? '...' : ''}`;
                        }
                        else if (block.input.pattern) {
                            activity += `: ${block.input.pattern}`;
                        }
                        else if (block.input.query) {
                            activity += `: ${block.input.query.substring(0, 80)}`;
                        }
                    }
                    // Rate limit activity callbacks
                    if (ctx.onToolActivity) {
                        const now = Date.now();
                        if (now - ctx.lastActivityTime() >= ctx.activityIntervalMs) {
                            console.log(`[Claude] Tool: ${activity}`);
                            ctx.onToolActivity(activity);
                            ctx.setLastActivityTime(now);
                        }
                    }
                }
                else if (block.type === 'text') {
                    ctx.appendText(block.text || '');
                }
            }
        }
        else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            // Streaming text delta
            ctx.appendText(event.delta.text || '');
        }
        else if (event.type === 'message_start' || event.type === 'message_delta') {
            // Message metadata - ignore
        }
        else if (event.type === 'result') {
            // Final result - might contain the response
            if (event.result) {
                ctx.appendText(event.result);
            }
        }
        else if (event.type === 'system' && event.message) {
            // System messages can contain useful info
            console.log(`[Claude] System: ${event.message.substring(0, 100)}`);
        }
    }
    cleanup() {
        if (this.currentTaskId) {
            clearRunningTask();
            this.currentTaskId = null;
        }
    }
    getPartialOutput() {
        return this.partialOutput;
    }
    getPid() {
        return this.currentProcess?.pid;
    }
    isActive() {
        return this.isActive_;
    }
    isProcessing() {
        return this.currentProcess !== null;
    }
    kill() {
        if (this.currentProcess) {
            console.log('[ClaudeSession] Killing process');
            this.currentProcess.kill('SIGTERM');
            this.currentProcess = null;
        }
        this.cleanup();
    }
    async exit() {
        console.log('[ClaudeSession] Session ended');
        this.isActive_ = false;
        this.kill();
    }
}
// Session manager
let currentSession = null;
let currentDir = '';
export async function getOrCreateSession(workingDir) {
    if (currentSession?.isActive() && currentDir === workingDir) {
        return currentSession;
    }
    if (currentSession) {
        await currentSession.exit();
    }
    currentDir = workingDir;
    currentSession = new ClaudeSession({ workingDirectory: workingDir });
    await currentSession.start();
    return currentSession;
}
export function getCurrentSession() {
    return currentSession?.isActive() ? currentSession : null;
}
export function killCurrentSession() {
    if (currentSession) {
        currentSession.kill();
        currentSession = null;
        currentDir = '';
    }
}
export function interruptCurrentTask() {
    if (currentSession?.isProcessing()) {
        const partial = currentSession.getPartialOutput();
        currentSession.kill();
        return partial;
    }
    return null;
}
