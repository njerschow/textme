/**
 * Claude Code CLI wrapper - SIMPLIFIED
 * Uses `claude --print` for reliable text output
 * No streaming complexity - just get the answer
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
            `${process.env.HOME}/.nvm/versions/node/v24.12.0/bin/claude`,
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
     * Send a message and get response - with optional streaming and progress callbacks
     */
    async send(message, taskId, streamingOptions, progressOptions) {
        console.log(`[Claude] ====== STARTING CLAUDE REQUEST ======`);
        console.log(`[Claude] Task ID: ${taskId || 'none'}`);
        console.log(`[Claude] Message length: ${message.length} chars`);
        console.log(`[Claude] Working dir: ${this.config.workingDirectory}`);
        if (!this.isActive_) {
            console.error(`[Claude] Session not active!`);
            throw new Error('Claude session not active');
        }
        if (taskId) {
            this.currentTaskId = taskId;
            setRunningTask(taskId, message.substring(0, 100));
            console.log(`[Claude] Set running task: ${taskId}`);
        }
        this.partialOutput = '';
        const { onChunk, chunkIntervalMs = 2000, minChunkSize = 100 } = streamingOptions || {};
        const { onProgress, progressIntervalMs = 5000 } = progressOptions || {};
        console.log(`[Claude] Streaming config: chunkIntervalMs=${chunkIntervalMs}, minChunkSize=${minChunkSize}`);
        console.log(`[Claude] Streaming callback: ${onChunk ? 'enabled' : 'disabled'}`);
        console.log(`[Claude] Progress callback: ${onProgress ? 'enabled' : 'disabled'}, interval=${progressIntervalMs}ms`);
        return new Promise((resolve, reject) => {
            let output = '';
            let errorOutput = '';
            let lastChunkSentAt = Date.now(); // Initialize to now, not 0
            let lastChunkLength = 0;
            let chunkInterval = null;
            let progressInterval = null;
            let chunkCheckCount = 0;
            let progressUpdateCount = 0;
            const startTime = Date.now();
            // Simple: --print with permission bypass and --continue for conversation context
            console.log(`[Claude] Spawning process: ${CLAUDE_PATH} --print --continue --permission-mode bypassPermissions`);
            const proc = spawn(CLAUDE_PATH, [
                '--print',
                '--continue',
                '--permission-mode', 'bypassPermissions',
            ], {
                cwd: this.config.workingDirectory,
                env: {
                    ...process.env,
                    NO_COLOR: '1',
                    FORCE_COLOR: '0',
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            this.currentProcess = proc;
            console.log(`[Claude] Process spawned with PID: ${proc.pid}`);
            if (proc.pid && this.currentTaskId) {
                updateRunningTaskPid(this.currentTaskId, proc.pid);
            }
            // Function to send chunk updates
            const maybeEmitChunk = (force = false) => {
                if (!onChunk)
                    return;
                chunkCheckCount++;
                const now = Date.now();
                const elapsed = now - startTime;
                const newContent = output.substring(lastChunkLength);
                const timeSinceLastChunk = now - lastChunkSentAt;
                console.log(`[Claude] Chunk check #${chunkCheckCount}: elapsed=${elapsed}ms, newContent=${newContent.length} chars, timeSinceLastChunk=${timeSinceLastChunk}ms`);
                // Emit chunk if: forced, OR (enough time passed AND enough new content)
                if (force || (timeSinceLastChunk >= chunkIntervalMs && newContent.length >= minChunkSize)) {
                    if (newContent.length > 0) {
                        console.log(`[Claude] >>> EMITTING CHUNK: ${newContent.length} new chars (total: ${output.length})`);
                        onChunk(newContent, output);
                        lastChunkSentAt = now;
                        lastChunkLength = output.length;
                    }
                    else {
                        console.log(`[Claude] Chunk check: no new content to emit`);
                    }
                }
                else {
                    console.log(`[Claude] Chunk check: threshold not met (time: ${timeSinceLastChunk}ms/${chunkIntervalMs}ms, size: ${newContent.length}/${minChunkSize})`);
                }
            };
            // Set up periodic chunk checking if streaming is enabled
            if (onChunk) {
                console.log(`[Claude] Setting up chunk interval timer (${chunkIntervalMs}ms)`);
                chunkInterval = setInterval(() => {
                    maybeEmitChunk(false);
                }, chunkIntervalMs);
            }
            // Set up periodic progress updates (independent of streaming)
            if (onProgress) {
                console.log(`[Claude] Setting up progress interval timer (${progressIntervalMs}ms)`);
                progressInterval = setInterval(() => {
                    progressUpdateCount++;
                    const elapsedMs = Date.now() - startTime;
                    const elapsedSecs = Math.round(elapsedMs / 1000);
                    // Determine phase based on elapsed time
                    let phase;
                    if (elapsedSecs < 5) {
                        phase = 'starting';
                    }
                    else if (output.length > 0) {
                        phase = 'finishing';
                    }
                    else {
                        phase = 'processing';
                    }
                    console.log(`[Claude] Progress update #${progressUpdateCount}: phase=${phase}, elapsed=${elapsedSecs}s, output=${output.length} chars`);
                    onProgress({
                        elapsedSecs,
                        phase,
                        outputLength: output.length,
                        hasOutput: output.length > 0,
                        updateNumber: progressUpdateCount,
                    });
                }, progressIntervalMs);
            }
            proc.stdout.on('data', (data) => {
                const text = data.toString();
                output += text;
                this.partialOutput = output;
                console.log(`[Claude] stdout: +${text.length} chars (total: ${output.length})`);
            });
            proc.stderr.on('data', (data) => {
                const text = data.toString();
                errorOutput += text;
                console.log(`[Claude] stderr: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);
            });
            proc.on('error', (error) => {
                console.error(`[Claude] Process error:`, error);
                if (chunkInterval)
                    clearInterval(chunkInterval);
                if (progressInterval)
                    clearInterval(progressInterval);
                this.cleanup();
                reject(error);
            });
            proc.on('close', (code) => {
                const duration = Date.now() - startTime;
                this.currentProcess = null;
                if (chunkInterval)
                    clearInterval(chunkInterval);
                if (progressInterval)
                    clearInterval(progressInterval);
                this.cleanup();
                console.log(`[Claude] ====== PROCESS CLOSED ======`);
                console.log(`[Claude] Exit code: ${code}`);
                console.log(`[Claude] Duration: ${duration}ms`);
                console.log(`[Claude] Output length: ${output.length} chars`);
                console.log(`[Claude] Chunk checks performed: ${chunkCheckCount}`);
                if (errorOutput) {
                    console.log(`[Claude] Stderr (first 200 chars): ${errorOutput.substring(0, 200)}`);
                }
                if (output.trim()) {
                    console.log(`[Claude] Resolving with output`);
                    resolve(output.trim());
                }
                else if (code !== 0) {
                    console.log(`[Claude] Rejecting due to non-zero exit code`);
                    reject(new Error(`Claude exited with code ${code}: ${errorOutput}`));
                }
                else {
                    console.log(`[Claude] Resolving with "No response"`);
                    resolve('No response from Claude.');
                }
            });
            // Timeout after 10 minutes
            const timeout = setTimeout(() => {
                console.log('[Claude] TIMEOUT - killing process after 10 minutes');
                if (chunkInterval)
                    clearInterval(chunkInterval);
                if (progressInterval)
                    clearInterval(progressInterval);
                this.kill();
                if (this.partialOutput.trim()) {
                    resolve(this.partialOutput.trim() + '\n\n[Response timed out]');
                }
                else {
                    reject(new Error('Response timeout'));
                }
            }, 10 * 60 * 1000);
            proc.on('close', () => clearTimeout(timeout));
            // Send the message
            console.log(`[Claude] Writing message to stdin (${message.length} chars)`);
            proc.stdin.write(message);
            proc.stdin.end();
            console.log(`[Claude] stdin closed, waiting for response...`);
        });
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
            console.log('[ClaudeSession] Killing current process');
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
