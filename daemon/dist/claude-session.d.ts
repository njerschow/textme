/**
 * Claude Code CLI wrapper - SIMPLIFIED
 * Uses `claude --print` for reliable text output
 * No streaming complexity - just get the answer
 */
export interface ClaudeSessionConfig {
    workingDirectory: string;
}
export interface StreamingOptions {
    /** Called with accumulated output periodically during processing */
    onChunk?: (chunk: string, fullOutput: string) => void;
    /** Minimum interval between chunk callbacks in ms (default: 2000) */
    chunkIntervalMs?: number;
    /** Minimum new characters needed to trigger a chunk callback (default: 100) */
    minChunkSize?: number;
}
export interface ProgressOptions {
    /** Called periodically to report progress (even when no new output) */
    onProgress?: (update: ProgressUpdate) => void;
    /** Interval between progress updates in ms (default: 5000) */
    progressIntervalMs?: number;
}
export interface ProgressUpdate {
    /** Elapsed time in seconds */
    elapsedSecs: number;
    /** Current phase (starting, processing, finalizing) */
    phase: 'starting' | 'processing' | 'finishing';
    /** Output length so far */
    outputLength: number;
    /** Whether we have any output yet */
    hasOutput: boolean;
    /** Update number (1, 2, 3...) */
    updateNumber: number;
}
export declare class ClaudeSession {
    private config;
    private isActive_;
    private currentTaskId;
    private currentProcess;
    private partialOutput;
    constructor(config: ClaudeSessionConfig);
    start(): Promise<void>;
    /**
     * Send a message and get response - with optional streaming and progress callbacks
     */
    send(message: string, taskId?: string, streamingOptions?: StreamingOptions, progressOptions?: ProgressOptions): Promise<string>;
    private cleanup;
    getPartialOutput(): string;
    getPid(): number | undefined;
    isActive(): boolean;
    isProcessing(): boolean;
    kill(): void;
    exit(): Promise<void>;
}
export declare function getOrCreateSession(workingDir: string): Promise<ClaudeSession>;
export declare function getCurrentSession(): ClaudeSession | null;
export declare function killCurrentSession(): void;
export declare function interruptCurrentTask(): string | null;
