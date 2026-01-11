/**
 * Claude Code CLI wrapper - STREAM JSON MODE
 * Uses `claude --output-format stream-json` for real-time tool activity
 * Each line is a JSON event we parse for tool_use and text content
 */
export interface ClaudeSessionConfig {
    workingDirectory: string;
}
export interface VerboseCallbacks {
    /** Called when a tool is being used */
    onToolActivity?: (activity: string) => void;
    /** Minimum interval between activity callbacks in ms (default: 1000) */
    activityIntervalMs?: number;
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
     * Send a message and get response - with real-time streaming via stream-json
     */
    send(message: string, taskId?: string, callbacks?: VerboseCallbacks): Promise<string>;
    /**
     * Process a stream-json event
     */
    private processStreamEvent;
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
