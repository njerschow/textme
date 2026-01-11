/**
 * Configuration loader for the Claude iMessage daemon
 * Loads from ~/.config/claude-imessage/config.json
 */
import type { DaemonConfig } from './types.js';
export declare function loadConfig(): DaemonConfig;
export declare function getConfigPath(): string;
