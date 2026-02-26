#!/usr/bin/env node
/**
 * Discord Client for TinyClaw Simple
 * Writes DM messages to queue and reads responses
 * Does NOT call Claude directly - that's handled by queue-processor
 */

import { Client, Events, GatewayIntentBits, Partials, Message, DMChannel, AttachmentBuilder } from 'discord.js';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ensureSenderPaired } from '../lib/pairing';
import { apiHeaders, apiJsonHeaders } from '../lib/api-auth';
import {
    API_BASE,
    FILES_DIR,
    PAIRING_FILE,
    channelLogFile,
    ensureDirs,
    createLogger,
    pairingMessage,
    getTeamListText,
    getAgentListText,
    processResetCommand,
    buildUniqueFilePath,
    downloadFile,
    splitMessage,
    generateMessageId,
    buildFullMessage,
    cleanupPendingMessages,
} from '../lib/channel-common';

const LOG_FILE = channelLogFile('discord');

// Ensure directories exist
ensureDirs([path.dirname(LOG_FILE), FILES_DIR]);

// Validate bot token
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!DISCORD_BOT_TOKEN || DISCORD_BOT_TOKEN === 'your_token_here') {
    console.error('ERROR: DISCORD_BOT_TOKEN is not set in .env file');
    process.exit(1);
}

interface PendingMessage {
    message: Message;
    channel: DMChannel;
    timestamp: number;
}

// Track pending messages (waiting for response)
const pendingMessages = new Map<string, PendingMessage>();
let processingOutgoingQueue = false;

// Logger
const log = createLogger(LOG_FILE);

// Discord-specific formatting: **bold** for headers, `code` for inline code
const discordBold = (s: string) => `**${s}**`;
const discordCode = (s: string) => `\`${s}\``;
function discordTeamListText(): string {
    return getTeamListText(discordBold, discordBold, discordCode);
}
function discordAgentListText(): string {
    return getAgentListText(discordBold, discordBold, discordCode);
}

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [
        Partials.Channel,
        Partials.Message,
    ],
});

// Client ready
client.on(Events.ClientReady, (readyClient) => {
    log('INFO', `Discord bot connected as ${readyClient.user.tag}`);
    log('INFO', 'Listening for DMs...');
});

// Message received - Write to queue
client.on(Events.MessageCreate, async (message: Message) => {
    try {
        // Skip bot messages
        if (message.author.bot) {
            return;
        }

        // Skip non-DM messages (guild = server channel)
        if (message.guild) {
            return;
        }

        const hasAttachments = message.attachments.size > 0;
        const hasContent = message.content && message.content.trim().length > 0;

        // Skip messages with no content and no attachments
        if (!hasContent && !hasAttachments) {
            return;
        }

        const sender = message.author.username;

        // Generate unique message ID
        const messageId = generateMessageId();

        // Download any attachments
        const downloadedFiles: string[] = [];
        if (hasAttachments) {
            for (const [, attachment] of message.attachments) {
                try {
                    const attachmentName = attachment.name || `discord_${messageId}_${Date.now()}.bin`;
                    const filename = `discord_${messageId}_${attachmentName}`;
                    const localPath = buildUniqueFilePath(FILES_DIR, filename);

                    await downloadFile(attachment.url, localPath);
                    downloadedFiles.push(localPath);
                    log('INFO', `Downloaded attachment: ${path.basename(localPath)} (${attachment.contentType || 'unknown'})`);
                } catch (dlErr) {
                    log('ERROR', `Failed to download attachment ${attachment.name}: ${(dlErr as Error).message}`);
                }
            }
        }

        let messageText = message.content || '';

        log('INFO', `Message from ${sender}: ${messageText.substring(0, 50)}${downloadedFiles.length > 0 ? ` [+${downloadedFiles.length} file(s)]` : ''}...`);

        const pairing = ensureSenderPaired(PAIRING_FILE, 'discord', message.author.id, sender);
        if (!pairing.approved && pairing.code) {
            if (pairing.isNewPending) {
                log('INFO', `Blocked unpaired Discord sender ${sender} (${message.author.id}) with code ${pairing.code}`);
                await message.reply(pairingMessage(pairing.code));
            } else {
                log('INFO', `Blocked pending Discord sender ${sender} (${message.author.id}) without re-sending pairing message`);
            }
            return;
        }

        // Check for agent list command
        if (message.content.trim().match(/^[!/]agent$/i)) {
            log('INFO', 'Agent list command received');
            const agentList = discordAgentListText();
            await message.reply(agentList);
            return;
        }

        // Check for team list command
        if (message.content.trim().match(/^[!/]team$/i)) {
            log('INFO', 'Team list command received');
            const teamList = discordTeamListText();
            await message.reply(teamList);
            return;
        }

        // Check for reset command: /reset @agent_id [@agent_id2 ...]
        const resetMatch = messageText.trim().match(/^[!/]reset\s+(.+)$/i);
        if (messageText.trim().match(/^[!/]reset$/i)) {
            await message.reply('Usage: `/reset @agent_id [@agent_id2 ...]`\nSpecify which agent(s) to reset.');
            return;
        }
        if (resetMatch) {
            log('INFO', 'Per-agent reset command received');
            try {
                const { results } = processResetCommand(resetMatch[1]);
                await message.reply(results.join('\n'));
            } catch {
                await message.reply('Could not process reset command. Check settings.');
            }
            return;
        }

        // Show typing indicator
        await (message.channel as DMChannel).sendTyping();

        // Build message text with file references
        const fullMessage = buildFullMessage(messageText, downloadedFiles);

        // Write to queue via API
        await fetch(`${API_BASE}/api/message`, {
            method: 'POST',
            headers: apiJsonHeaders(),
            body: JSON.stringify({
                channel: 'discord',
                sender,
                senderId: message.author.id,
                message: fullMessage,
                messageId,
                files: downloadedFiles.length > 0 ? downloadedFiles : undefined,
            }),
        });

        log('INFO', `Queued message ${messageId}`);

        // Store pending message for response
        pendingMessages.set(messageId, {
            message: message,
            channel: message.channel as DMChannel,
            timestamp: Date.now(),
        });

        // Clean up old pending messages (older than 10 minutes)
        cleanupPendingMessages(pendingMessages);

    } catch (error) {
        log('ERROR', `Message handling error: ${(error as Error).message}`);
    }
});

// Watch for responses via API
async function checkOutgoingQueue(): Promise<void> {
    if (processingOutgoingQueue) {
        return;
    }

    processingOutgoingQueue = true;

    try {
        const res = await fetch(`${API_BASE}/api/responses/pending?channel=discord`, { headers: apiHeaders() });
        if (!res.ok) return;
        const responses = await res.json() as any[];

        for (const resp of responses) {
            try {
                const responseText = resp.message;
                const messageId = resp.messageId;
                const sender = resp.sender;
                const senderId = resp.senderId;
                const files: string[] = resp.files || [];

                // Find pending message, or fall back to senderId for proactive messages
                const pending = pendingMessages.get(messageId);
                let dmChannel = pending?.channel ?? null;

                if (!dmChannel && senderId) {
                    try {
                        const user = await client.users.fetch(senderId);
                        dmChannel = await user.createDM();
                    } catch (err) {
                        log('ERROR', `Could not open DM for senderId ${senderId}: ${(err as Error).message}`);
                    }
                }

                if (dmChannel) {
                    // Send any attached files
                    if (files.length > 0) {
                        const attachments: AttachmentBuilder[] = [];
                        for (const file of files) {
                            try {
                                if (!fs.existsSync(file)) continue;
                                attachments.push(new AttachmentBuilder(file));
                            } catch (fileErr) {
                                log('ERROR', `Failed to prepare file ${file}: ${(fileErr as Error).message}`);
                            }
                        }
                        if (attachments.length > 0) {
                            await dmChannel.send({ files: attachments });
                            log('INFO', `Sent ${attachments.length} file(s) to Discord`);
                        }
                    }

                    // Split message if needed (Discord 2000 char limit)
                    if (responseText) {
                        const chunks = splitMessage(responseText, 2000);

                        if (chunks.length > 0) {
                            if (pending) {
                                await pending.message.reply(chunks[0]!);
                            } else {
                                await dmChannel.send(chunks[0]!);
                            }
                        }
                        for (let i = 1; i < chunks.length; i++) {
                            await dmChannel.send(chunks[i]!);
                        }
                    }

                    log('INFO', `Sent ${pending ? 'response' : 'proactive message'} to ${sender} (${responseText.length} chars${files.length > 0 ? `, ${files.length} file(s)` : ''})`);

                    if (pending) pendingMessages.delete(messageId);
                    await fetch(`${API_BASE}/api/responses/${resp.id}/ack`, { method: 'POST', headers: apiHeaders() });
                } else {
                    log('WARN', `No pending message for ${messageId} and no senderId, acking`);
                    await fetch(`${API_BASE}/api/responses/${resp.id}/ack`, { method: 'POST', headers: apiHeaders() });
                }
            } catch (error) {
                log('ERROR', `Error processing response ${resp.id}: ${(error as Error).message}`);
                // Don't ack on error, will retry next poll
            }
        }
    } catch (error) {
        log('ERROR', `Outgoing queue error: ${(error as Error).message}`);
    } finally {
        processingOutgoingQueue = false;
    }
}

// Check outgoing queue every second
setInterval(checkOutgoingQueue, 1000);

// Refresh typing indicator every 8 seconds (Discord typing expires after ~10s)
setInterval(() => {
    for (const [, data] of pendingMessages.entries()) {
        data.channel.sendTyping().catch(() => {
            // Ignore typing errors silently
        });
    }
}, 8000);

// Graceful shutdown
process.on('SIGINT', () => {
    log('INFO', 'Shutting down Discord client...');
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', 'Shutting down Discord client...');
    client.destroy();
    process.exit(0);
});

// Start client
log('INFO', 'Starting Discord client...');
client.login(DISCORD_BOT_TOKEN);
