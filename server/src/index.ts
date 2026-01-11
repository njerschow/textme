#!/usr/bin/env bun

/**
 * iMessage MCP Server
 *
 * A stdio-based MCP server that lets Claude send and receive iMessages via Sendblue.
 * Uses polling instead of webhooks - no ngrok required.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SendblueClient } from './sendblue.js';
import {
  initDb,
  isMessageProcessed,
  markMessageProcessed,
  addConversationMessage,
  getConversationHistory,
  clearConversationHistory,
  getAllContacts,
  cleanupOldProcessedMessages,
  closeDb,
} from './db.js';
import type { ServerConfig, PendingMessage, SendblueMessage } from './types.js';

// Store pending messages from polling
let pendingMessages: PendingMessage[] = [];
let lastPollTime: Date = new Date(Date.now() - 24 * 60 * 60 * 1000); // Start 24 hours ago
let pollingInterval: ReturnType<typeof setInterval> | null = null;

// Track pending ask_user requests waiting for responses
interface PendingAsk {
  toNumber: string;
  sentAt: number;
  message: string;
}
let pendingAsks: PendingAsk[] = [];

// Helper to sleep
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function loadConfig(): ServerConfig {
  const errors: string[] = [];

  if (!process.env.SENDBLUE_API_KEY) {
    errors.push('SENDBLUE_API_KEY is required');
  }
  if (!process.env.SENDBLUE_API_SECRET) {
    errors.push('SENDBLUE_API_SECRET is required');
  }
  if (!process.env.SENDBLUE_PHONE_NUMBER) {
    errors.push('SENDBLUE_PHONE_NUMBER is required');
  }
  if (!process.env.IMESSAGE_WHITELIST) {
    errors.push('IMESSAGE_WHITELIST is required (comma-separated phone numbers)');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n  - ${errors.join('\n  - ')}`);
  }

  const whitelist = process.env.IMESSAGE_WHITELIST!
    .split(',')
    .map(n => n.trim())
    .filter(n => n.length > 0);

  return {
    sendblueApiKey: process.env.SENDBLUE_API_KEY!,
    sendblueApiSecret: process.env.SENDBLUE_API_SECRET!,
    sendbluePhoneNumber: process.env.SENDBLUE_PHONE_NUMBER!,
    whitelist,
    pollIntervalMs: parseInt(process.env.IMESSAGE_POLL_INTERVAL_MS || '10000', 10),
  };
}

function isWhitelisted(phoneNumber: string, whitelist: string[]): boolean {
  // Normalize phone numbers for comparison (remove spaces, dashes, etc.)
  const normalize = (n: string) => n.replace(/[\s\-\(\)\.]/g, '');
  const normalizedInput = normalize(phoneNumber);

  return whitelist.some(w => {
    const normalizedWhitelist = normalize(w);
    return normalizedInput === normalizedWhitelist ||
           normalizedInput.endsWith(normalizedWhitelist) ||
           normalizedWhitelist.endsWith(normalizedInput);
  });
}

async function pollForMessages(client: SendblueClient, config: ServerConfig): Promise<void> {
  try {
    const messages = await client.getInboundMessages(lastPollTime, 50);
    lastPollTime = new Date();

    for (const msg of messages) {
      // Skip if already processed
      if (isMessageProcessed(msg.id)) {
        continue;
      }

      // Skip if not from whitelisted number
      if (!isWhitelisted(msg.from_number, config.whitelist)) {
        console.error(`[Poll] Ignoring message from non-whitelisted number: ${msg.from_number}`);
        continue;
      }

      // Get conversation context
      const context = getConversationHistory(msg.from_number, 10);

      // Add to pending messages
      pendingMessages.push({
        id: msg.id,
        from_number: msg.from_number,
        content: msg.content,
        timestamp: msg.date_sent || msg.date_created,
        receivedAt: Date.now(),  // Track when we actually received it
        conversation_context: context,
      });

      // Store the user message in conversation history
      addConversationMessage(msg.from_number, 'user', msg.content);

      console.error(`[Poll] New message from ${msg.from_number}: ${msg.content.substring(0, 50)}...`);
    }

    // Cleanup old processed messages occasionally
    if (Math.random() < 0.01) {
      cleanupOldProcessedMessages();
    }
  } catch (error) {
    console.error('[Poll] Error:', error);
  }
}

async function main() {
  // Load configuration
  let config: ServerConfig;
  try {
    config = loadConfig();
  } catch (error) {
    console.error('Configuration error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Initialize database
  initDb();

  // Create Sendblue client
  const sendblueClient = new SendblueClient(config);

  // Start polling for messages
  console.error(`[iMessage] Starting polling every ${config.pollIntervalMs}ms`);
  console.error(`[iMessage] Whitelist: ${config.whitelist.join(', ')}`);

  // Initial poll
  await pollForMessages(sendblueClient, config);

  // Set up polling interval
  pollingInterval = setInterval(() => {
    pollForMessages(sendblueClient, config);
  }, config.pollIntervalMs);

  // Create MCP server
  const mcpServer = new Server(
    { name: 'imessage', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // List available tools
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'check_messages',
          description: 'Check for new iMessages from whitelisted contacts. Returns pending messages that need responses.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'send_message',
          description: 'Send an iMessage to a whitelisted contact.',
          inputSchema: {
            type: 'object',
            properties: {
              to_number: {
                type: 'string',
                description: 'Phone number to send to (must be whitelisted)',
              },
              content: {
                type: 'string',
                description: 'Message content to send',
              },
            },
            required: ['to_number', 'content'],
          },
        },
        {
          name: 'get_conversation',
          description: 'Get conversation history with a contact.',
          inputSchema: {
            type: 'object',
            properties: {
              phone_number: {
                type: 'string',
                description: 'Phone number to get history for',
              },
              limit: {
                type: 'number',
                description: 'Maximum messages to return (default: 20)',
              },
            },
            required: ['phone_number'],
          },
        },
        {
          name: 'mark_read',
          description: 'Mark a message as read/processed without sending a response.',
          inputSchema: {
            type: 'object',
            properties: {
              message_id: {
                type: 'string',
                description: 'ID of the message to mark as read',
              },
            },
            required: ['message_id'],
          },
        },
        {
          name: 'list_contacts',
          description: 'List all contacts who have sent messages.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'clear_history',
          description: 'Clear conversation history with a contact.',
          inputSchema: {
            type: 'object',
            properties: {
              phone_number: {
                type: 'string',
                description: 'Phone number to clear history for',
              },
            },
            required: ['phone_number'],
          },
        },
        {
          name: 'ask_user',
          description: 'Send an iMessage and wait for the user to respond. Use this when you need input, want to report completed work, or need to discuss next steps. Blocks until response received or timeout.',
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'What to ask the user. Be conversational.',
              },
              timeout_seconds: {
                type: 'number',
                description: 'How long to wait for response in seconds (default: 300 = 5 minutes)',
              },
            },
            required: ['message'],
          },
        },
        {
          name: 'notify_user',
          description: 'Send an iMessage without waiting for a response. Use for status updates or non-urgent information.',
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: 'Message to send to the user.',
              },
            },
            required: ['message'],
          },
        },
        {
          name: 'wait_for_message',
          description: 'Wait for an incoming iMessage from the user. Use this to listen for instructions when the user wants to communicate via text. Blocks until a message arrives or timeout.',
          inputSchema: {
            type: 'object',
            properties: {
              timeout_seconds: {
                type: 'number',
                description: 'How long to wait in seconds (default: 1800 = 30 minutes)',
              },
            },
            required: [],
          },
        },
      ],
    };
  });

  // Handle tool calls
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;

      if (name === 'check_messages') {
        // Return pending messages
        const messages = [...pendingMessages];

        if (messages.length === 0) {
          return {
            content: [{ type: 'text', text: 'No new messages.' }],
          };
        }

        const formatted = messages.map(msg => {
          const contextStr = msg.conversation_context.length > 0
            ? `\n\nRecent conversation:\n${msg.conversation_context.map(c => `${c.role}: ${c.content}`).join('\n')}`
            : '';

          return `From: ${msg.from_number}\nTime: ${msg.timestamp}\nMessage: ${msg.content}${contextStr}\nMessage ID: ${msg.id}`;
        }).join('\n\n---\n\n');

        return {
          content: [{
            type: 'text',
            text: `${messages.length} new message(s):\n\n${formatted}\n\nUse send_message to respond and mark_read to dismiss without responding.`,
          }],
        };
      }

      if (name === 'send_message') {
        const { to_number, content } = args as { to_number: string; content: string };

        // Verify whitelisted
        if (!isWhitelisted(to_number, config.whitelist)) {
          return {
            content: [{ type: 'text', text: `Error: ${to_number} is not in the whitelist.` }],
            isError: true,
          };
        }

        // Send via Sendblue
        await sendblueClient.sendMessage(to_number, content);

        // Store in conversation history
        addConversationMessage(to_number, 'assistant', content);

        // Mark any pending messages from this number as processed
        const fromThisNumber = pendingMessages.filter(m => m.from_number === to_number);
        for (const msg of fromThisNumber) {
          markMessageProcessed(msg.id);
        }
        pendingMessages = pendingMessages.filter(m => m.from_number !== to_number);

        return {
          content: [{ type: 'text', text: `Message sent to ${to_number}: "${content}"` }],
        };
      }

      if (name === 'get_conversation') {
        const { phone_number, limit } = args as { phone_number: string; limit?: number };
        const history = getConversationHistory(phone_number, limit || 20);

        if (history.length === 0) {
          return {
            content: [{ type: 'text', text: `No conversation history with ${phone_number}.` }],
          };
        }

        const formatted = history.map(msg =>
          `[${new Date(msg.timestamp).toLocaleString()}] ${msg.role}: ${msg.content}`
        ).join('\n');

        return {
          content: [{ type: 'text', text: `Conversation with ${phone_number}:\n\n${formatted}` }],
        };
      }

      if (name === 'mark_read') {
        const { message_id } = args as { message_id: string };
        markMessageProcessed(message_id);
        pendingMessages = pendingMessages.filter(m => m.id !== message_id);

        return {
          content: [{ type: 'text', text: `Message ${message_id} marked as read.` }],
        };
      }

      if (name === 'list_contacts') {
        const contacts = getAllContacts();

        if (contacts.length === 0) {
          return {
            content: [{ type: 'text', text: 'No contacts yet.' }],
          };
        }

        return {
          content: [{ type: 'text', text: `Contacts:\n${contacts.join('\n')}` }],
        };
      }

      if (name === 'clear_history') {
        const { phone_number } = args as { phone_number: string };
        clearConversationHistory(phone_number);

        return {
          content: [{ type: 'text', text: `Conversation history cleared for ${phone_number}.` }],
        };
      }

      if (name === 'ask_user') {
        const { message, timeout_seconds } = args as { message: string; timeout_seconds?: number };
        const timeoutMs = (timeout_seconds || 300) * 1000; // Default 5 minutes
        const toNumber = config.whitelist[0]; // Use first whitelisted number

        console.error(`[ask_user] Sending: ${message.substring(0, 50)}...`);

        // Send the message
        await sendblueClient.sendMessage(toNumber, message);
        addConversationMessage(toNumber, 'assistant', message);

        const sentAt = Date.now();

        // Clear any pending messages from this number (we're starting fresh)
        pendingMessages = pendingMessages.filter(m => m.from_number !== toNumber);

        console.error(`[ask_user] Waiting for response (timeout: ${timeoutMs / 1000}s)...`);

        // Poll for response
        while (Date.now() - sentAt < timeoutMs) {
          await sleep(5000); // Check every 5 seconds

          // Force a poll to get latest messages
          await pollForMessages(sendblueClient, config);

          // Check for new messages from the user (received after we sent)
          const responses = pendingMessages.filter(m =>
            m.from_number === toNumber &&
            m.receivedAt > sentAt
          );

          if (responses.length > 0) {
            const response = responses[0];
            console.error(`[ask_user] Response received: ${response.content.substring(0, 50)}...`);

            // Mark as processed
            markMessageProcessed(response.id);
            pendingMessages = pendingMessages.filter(m => m.id !== response.id);

            return {
              content: [{
                type: 'text',
                text: `User responded: "${response.content}"`,
              }],
            };
          }
        }

        // Timeout reached
        console.error(`[ask_user] Timeout reached, no response received`);

        // Track this as a pending ask for the Stop hook
        pendingAsks.push({ toNumber, sentAt, message });

        return {
          content: [{
            type: 'text',
            text: `No response received within ${timeoutMs / 1000} seconds. The user may respond later - check_messages will pick it up, or the Stop hook will notify you.`,
          }],
        };
      }

      if (name === 'notify_user') {
        const { message } = args as { message: string };
        const toNumber = config.whitelist[0]; // Use first whitelisted number

        // Send without waiting
        await sendblueClient.sendMessage(toNumber, message);
        addConversationMessage(toNumber, 'assistant', message);

        return {
          content: [{ type: 'text', text: `Notification sent: "${message}"` }],
        };
      }

      if (name === 'wait_for_message') {
        const { timeout_seconds } = args as { timeout_seconds?: number };
        const timeoutMs = (timeout_seconds || 1800) * 1000; // Default 30 minutes
        const fromNumber = config.whitelist[0]; // Listen for messages from first whitelisted number

        console.error(`[wait_for_message] Waiting for message (timeout: ${timeoutMs / 1000}s)...`);

        const startedAt = Date.now();

        // Clear any existing pending messages so we only get new ones
        const existingIds = new Set(pendingMessages.map(m => m.id));

        // Poll for new messages
        while (Date.now() - startedAt < timeoutMs) {
          await sleep(5000); // Check every 5 seconds

          // Force a poll to get latest messages
          await pollForMessages(sendblueClient, config);

          // Check for NEW messages from the whitelisted number
          const newMessages = pendingMessages.filter(m =>
            m.from_number === fromNumber &&
            !existingIds.has(m.id) &&
            m.receivedAt > startedAt
          );

          if (newMessages.length > 0) {
            const message = newMessages[0];
            console.error(`[wait_for_message] Message received: ${message.content.substring(0, 50)}...`);

            // Mark as processed
            markMessageProcessed(message.id);
            pendingMessages = pendingMessages.filter(m => m.id !== message.id);

            return {
              content: [{
                type: 'text',
                text: `User sent: "${message.content}"`,
              }],
            };
          }

          // Log progress every minute
          const elapsed = Math.floor((Date.now() - startedAt) / 60000);
          if (elapsed > 0 && (Date.now() - startedAt) % 60000 < 5000) {
            console.error(`[wait_for_message] Still waiting... (${elapsed}m elapsed)`);
          }
        }

        // Timeout reached
        console.error(`[wait_for_message] Timeout reached, no message received`);

        return {
          content: [{
            type: 'text',
            text: `No message received within ${timeoutMs / 1000} seconds. You can try again or ask the user to send a message.`,
          }],
        };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  });

  // Connect MCP server via stdio
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error('');
  console.error('iMessage MCP server ready');
  console.error(`Phone: ${config.sendbluePhoneNumber}`);
  console.error(`Whitelist: ${config.whitelist.join(', ')}`);
  console.error(`Poll interval: ${config.pollIntervalMs}ms`);
  console.error('');

  // Graceful shutdown
  const shutdown = async () => {
    console.error('\nShutting down...');
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
