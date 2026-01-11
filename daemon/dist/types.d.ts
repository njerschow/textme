/**
 * Type definitions for the Claude iMessage daemon
 */
export interface DaemonConfig {
    sendblue: {
        apiKey: string;
        apiSecret: string;
        phoneNumber: string;
    };
    whitelist: string[];
    pollIntervalMs: number;
    conversationWindowSize: number;
    /** Interval between streaming progress updates in ms (default: 3000) */
    streamingIntervalMs?: number;
    /** Minimum characters needed before sending a progress update (default: 50) */
    streamingMinChunkSize?: number;
    /** Interval between periodic progress updates in ms (default: 5000) */
    progressIntervalMs?: number;
}
export interface SendblueMessage {
    message_handle: string;
    content: string;
    from_number: string;
    to_number: string;
    number: string;
    status: string;
    date_sent: string;
    date_updated: string;
    created_at?: string;
    is_outbound: boolean;
    media_url?: string;
}
export interface ConversationMessage {
    id: number;
    phone_number: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}
export interface RunningTask {
    id: string;
    description: string;
    started_at: number;
    pid: number | null;
}
export interface ProcessedMessage {
    message_id: string;
    processed_at: number;
}
export interface StreamEvent {
    type: string;
    subtype?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    content?: string;
    text?: string;
    message?: {
        id?: string;
        content?: Array<{
            type: string;
            text?: string;
        }>;
    };
}
export type StreamCallback = (event: StreamEvent, formattedUpdate: string) => void;
export interface QueuedMessage {
    id: number;
    message_handle: string;
    phone_number: string;
    content: string;
    queued_at: number;
}
export interface PendingApproval {
    id: string;
    task_id: string;
    command: string;
    phone_number: string;
    created_at: number;
    expires_at: number;
}
export type ApprovalCallback = (approved: boolean) => void;
