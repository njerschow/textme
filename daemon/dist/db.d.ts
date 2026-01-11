/**
 * SQLite database for message tracking, conversation history, and daemon state
 */
import Database from 'better-sqlite3';
import type { ConversationMessage, RunningTask, QueuedMessage, PendingApproval } from './types.js';
export declare function initDb(): Database.Database;
export declare function isMessageProcessed(messageId: string): boolean;
export declare function markMessageProcessed(messageId: string): void;
export declare function cleanupOldProcessedMessages(olderThanMs?: number): void;
export declare function addConversationMessage(phoneNumber: string, role: 'user' | 'assistant', content: string): void;
export declare function getConversationHistory(phoneNumber: string, limit?: number): ConversationMessage[];
export declare function trimConversationHistory(phoneNumber: string, keepCount: number): void;
export declare function clearConversationHistory(phoneNumber: string): void;
export declare function getAllContacts(): string[];
export declare function getState(key: string): string | null;
export declare function setState(key: string, value: string): void;
export declare function deleteState(key: string): void;
export declare function getRunningTask(): RunningTask | null;
export declare function setRunningTask(id: string, description: string, pid?: number | null): void;
export declare function updateRunningTaskPid(id: string, pid: number): void;
export declare function clearRunningTask(): void;
export declare function queueMessage(messageHandle: string, phoneNumber: string, content: string): void;
export declare function getNextQueuedMessage(): QueuedMessage | null;
export declare function removeQueuedMessage(id: number): void;
export declare function getQueueLength(): number;
export declare function clearMessageQueue(): void;
export declare function addPendingApproval(id: string, taskId: string, command: string, phoneNumber: string, timeoutMs?: number): void;
export declare function getPendingApproval(phoneNumber: string): PendingApproval | null;
export declare function getPendingApprovalById(id: string): PendingApproval | null;
export declare function removePendingApproval(id: string): void;
export declare function cleanupExpiredApprovals(): number;
export declare function closeDb(): void;
export declare function getDbPath(): string;
