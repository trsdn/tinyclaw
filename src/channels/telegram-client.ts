#!/usr/bin/env node
/**
 * Telegram Client for TinyClaw Simple
 * Writes DM messages to queue and reads responses
 * Does NOT call Claude directly - that's handled by queue-processor
 *
 * Setup: Create a bot via @BotFather on Telegram to get a bot token.
 */

import TelegramBot from 'node-telegram-bot-api';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ensureSenderPaired } from '../lib/pairing';
import { apiHeaders, apiJsonHeaders } from '../lib/api-auth';
import {
    TINYCLAW_HOME,
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
    sanitizeFileName,
    ensureFileExtension,
    buildUniqueFilePath,
    downloadFile,
    splitMessage,
    generateMessageId,
    buildFullMessage,
    cleanupPendingMessages,
} from '../lib/channel-common';

const LOG_FILE = channelLogFile('telegram');

// Ensure directories exist
ensureDirs([path.dirname(LOG_FILE), FILES_DIR]);

// Validate bot token
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'your_token_here') {
    console.error('ERROR: TELEGRAM_BOT_TOKEN is not set in .env file');
    process.exit(1);
}

interface PendingMessage {
    chatId: number;
    messageId: number;
    timestamp: number;
}

// Track pending messages (waiting for response)
const pendingMessages = new Map<string, PendingMessage>();
let processingOutgoingQueue = false;

// Logger
const log = createLogger(LOG_FILE);

// Telegram-specific formatting: plain text (no bold/code wrappers)
function telegramTeamListText(): string {
    return getTeamListText();
}

function telegramAgentListText(): string {
    return getAgentListText();
}

async function sendTelegramMessage(
    chatId: number,
    text: string,
    options: TelegramBot.SendMessageOptions = {},
): Promise<void> {
    try {
        await bot.sendMessage(chatId, text, {
            ...options,
            parse_mode: 'Markdown',
        });
    } catch (error) {
        const message = (error as Error).message || '';
        if (!message.toLowerCase().includes("can't parse entities")) {
            throw error;
        }

        log('WARN', 'Failed to parse Telegram Markdown, retrying without Markdown parsing');
        await bot.sendMessage(chatId, text, options);
    }
}

// Get file extension from mime type
function extFromMime(mime?: string): string {
    if (!mime) return '';
    const map: Record<string, string> = {
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
        'image/webp': '.webp', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3',
        'video/mp4': '.mp4', 'application/pdf': '.pdf',
    };
    return map[mime] || '';
}

// Download a Telegram file by file_id and return the local path
async function downloadTelegramFile(fileId: string, ext: string, messageId: string, originalName?: string): Promise<string | null> {
    try {
        const file = await bot.getFile(fileId);
        if (!file.file_path) return null;

        const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const telegramPathName = path.basename(file.file_path);
        const sourceName = originalName || telegramPathName || `file_${Date.now()}${ext}`;
        const withExt = ensureFileExtension(sourceName, ext || '.bin');
        const filename = `telegram_${messageId}_${withExt}`;
        const localPath = buildUniqueFilePath(FILES_DIR, filename);

        await downloadFile(url, localPath);
        log('INFO', `Downloaded file: ${path.basename(localPath)}`);
        return localPath;
    } catch (error) {
        log('ERROR', `Failed to download file: ${(error as Error).message}`);
        return null;
    }
}

// Initialize Telegram bot (polling mode)
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Bot ready
bot.getMe().then(async (me: TelegramBot.User) => {
    log('INFO', `Telegram bot connected as @${me.username}`);

    // Register bot commands so they appear in Telegram's "/" menu
    await bot.setMyCommands([
        { command: 'agent', description: 'List available agents' },
        { command: 'team', description: 'List available teams' },
        { command: 'reset', description: 'Reset conversation history' },
    ]).catch((err: Error) => log('WARN', `Failed to register commands: ${err.message}`));

    log('INFO', 'Listening for messages...');
}).catch((err: Error) => {
    log('ERROR', `Failed to connect: ${err.message}`);
    process.exit(1);
});

// Message received - Write to queue
bot.on('message', async (msg: TelegramBot.Message) => {
    try {
        // Skip group/channel messages - only handle private chats
        if (msg.chat.type !== 'private') {
            return;
        }

        // Determine message text and any media files
        let messageText = msg.text || msg.caption || '';
        const downloadedFiles: string[] = [];
        const queueMessageId = generateMessageId();

        // Handle photo messages
        if (msg.photo && msg.photo.length > 0) {
            // Get the largest photo (last in array)
            const photo = msg.photo[msg.photo.length - 1];
            const filePath = await downloadTelegramFile(photo.file_id, '.jpg', queueMessageId, `photo_${msg.message_id}.jpg`);
            if (filePath) downloadedFiles.push(filePath);
        }

        // Handle document/file messages
        if (msg.document) {
            const ext = msg.document.file_name
                ? path.extname(msg.document.file_name)
                : extFromMime(msg.document.mime_type);
            const filePath = await downloadTelegramFile(msg.document.file_id, ext, queueMessageId, msg.document.file_name);
            if (filePath) downloadedFiles.push(filePath);
        }

        // Handle audio messages
        if (msg.audio) {
            const ext = extFromMime(msg.audio.mime_type) || '.mp3';
            const audioFileName = ('file_name' in msg.audio) ? (msg.audio as { file_name?: string }).file_name : undefined;
            const filePath = await downloadTelegramFile(msg.audio.file_id, ext, queueMessageId, audioFileName);
            if (filePath) downloadedFiles.push(filePath);
        }

        // Handle voice messages
        if (msg.voice) {
            const filePath = await downloadTelegramFile(msg.voice.file_id, '.ogg', queueMessageId, `voice_${msg.message_id}.ogg`);
            if (filePath) downloadedFiles.push(filePath);
        }

        // Handle video messages
        if (msg.video) {
            const ext = extFromMime(msg.video.mime_type) || '.mp4';
            const videoFileName = ('file_name' in msg.video) ? (msg.video as { file_name?: string }).file_name : undefined;
            const filePath = await downloadTelegramFile(msg.video.file_id, ext, queueMessageId, videoFileName);
            if (filePath) downloadedFiles.push(filePath);
        }

        // Handle video notes (round video messages)
        if (msg.video_note) {
            const filePath = await downloadTelegramFile(msg.video_note.file_id, '.mp4', queueMessageId, `video_note_${msg.message_id}.mp4`);
            if (filePath) downloadedFiles.push(filePath);
        }

        // Handle sticker
        if (msg.sticker) {
            const ext = msg.sticker.is_animated ? '.tgs' : msg.sticker.is_video ? '.webm' : '.webp';
            const filePath = await downloadTelegramFile(msg.sticker.file_id, ext, queueMessageId, `sticker_${msg.message_id}${ext}`);
            if (filePath) downloadedFiles.push(filePath);
            if (!messageText) messageText = `[Sticker: ${msg.sticker.emoji || 'sticker'}]`;
        }

        // Skip if no text and no media
        if ((!messageText || messageText.trim().length === 0) && downloadedFiles.length === 0) {
            return;
        }

        const sender = msg.from
            ? (msg.from.first_name + (msg.from.last_name ? ` ${msg.from.last_name}` : ''))
            : 'Unknown';
        const senderId = msg.chat.id.toString();

        log('INFO', `Message from ${sender}: ${messageText.substring(0, 50)}${downloadedFiles.length > 0 ? ` [+${downloadedFiles.length} file(s)]` : ''}...`);

        const pairing = ensureSenderPaired(PAIRING_FILE, 'telegram', senderId, sender);
        if (!pairing.approved && pairing.code) {
            if (pairing.isNewPending) {
                log('INFO', `Blocked unpaired Telegram sender ${sender} (${senderId}) with code ${pairing.code}`);
                await bot.sendMessage(msg.chat.id, pairingMessage(pairing.code), {
                    reply_to_message_id: msg.message_id,
                });
            } else {
                log('INFO', `Blocked pending Telegram sender ${sender} (${senderId}) without re-sending pairing message`);
            }
            return;
        }

        // Check for agent list command
        if (msg.text && msg.text.trim().match(/^[!/]agent$/i)) {
            log('INFO', 'Agent list command received');
            const agentList = telegramAgentListText();
            await bot.sendMessage(msg.chat.id, agentList, {
                reply_to_message_id: msg.message_id,
            });
            return;
        }

        // Check for team list command
        if (msg.text && msg.text.trim().match(/^[!/]team$/i)) {
            log('INFO', 'Team list command received');
            const teamList = telegramTeamListText();
            await bot.sendMessage(msg.chat.id, teamList, {
                reply_to_message_id: msg.message_id,
            });
            return;
        }

        // Check for reset command: /reset @agent_id [@agent_id2 ...]
        const resetMatch = messageText.trim().match(/^[!/]reset\s+(.+)$/i);
        if (messageText.trim().match(/^[!/]reset$/i)) {
            await bot.sendMessage(msg.chat.id, 'Usage: /reset @agent_id [@agent_id2 ...]\nSpecify which agent(s) to reset.', {
                reply_to_message_id: msg.message_id,
            });
            return;
        }
        if (resetMatch) {
            log('INFO', 'Per-agent reset command received');
            try {
                const { results } = processResetCommand(resetMatch[1]);
                await bot.sendMessage(msg.chat.id, results.join('\n'), {
                    reply_to_message_id: msg.message_id,
                });
            } catch {
                await bot.sendMessage(msg.chat.id, 'Could not process reset command. Check settings.', {
                    reply_to_message_id: msg.message_id,
                });
            }
            return;
        }

        // Show typing indicator
        await bot.sendChatAction(msg.chat.id, 'typing');

        // Build message text with file references
        const fullMessage = buildFullMessage(messageText, downloadedFiles);

        // Write to queue via API
        await fetch(`${API_BASE}/api/message`, {
            method: 'POST',
            headers: apiJsonHeaders(),
            body: JSON.stringify({
                channel: 'telegram',
                sender,
                senderId,
                message: fullMessage,
                messageId: queueMessageId,
                files: downloadedFiles.length > 0 ? downloadedFiles : undefined,
            }),
        });

        log('INFO', `Queued message ${queueMessageId}`);

        // Store pending message for response
        pendingMessages.set(queueMessageId, {
            chatId: msg.chat.id,
            messageId: msg.message_id,
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
        const res = await fetch(`${API_BASE}/api/responses/pending?channel=telegram`, { headers: apiHeaders() });
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
                const targetChatId = pending?.chatId ?? (senderId ? Number(senderId) : null);

                if (targetChatId && !Number.isNaN(targetChatId)) {
                    // Send any attached files first
                    if (files.length > 0) {
                        for (const file of files) {
                            try {
                                if (!fs.existsSync(file)) continue;
                                const ext = path.extname(file).toLowerCase();
                                if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
                                    await bot.sendPhoto(targetChatId, file);
                                } else if (['.mp3', '.ogg', '.wav', '.m4a'].includes(ext)) {
                                    await bot.sendAudio(targetChatId, file);
                                } else if (['.mp4', '.avi', '.mov', '.webm'].includes(ext)) {
                                    await bot.sendVideo(targetChatId, file);
                                } else {
                                    await bot.sendDocument(targetChatId, file);
                                }
                                log('INFO', `Sent file to Telegram: ${path.basename(file)}`);
                            } catch (fileErr) {
                                log('ERROR', `Failed to send file ${file}: ${(fileErr as Error).message}`);
                            }
                        }
                    }

                    // Split message if needed (Telegram 4096 char limit)
                    if (responseText) {
                        const chunks = splitMessage(responseText, 4096);

                        if (chunks.length > 0) {
                            await sendTelegramMessage(targetChatId, chunks[0]!, pending
                                ? { reply_to_message_id: pending.messageId }
                                : {},
                            );
                        }
                        for (let i = 1; i < chunks.length; i++) {
                            await sendTelegramMessage(targetChatId, chunks[i]!);
                        }
                    }

                    log('INFO', `Sent ${pending ? 'response' : 'proactive message'} to ${sender} (${responseText.length} chars${files.length > 0 ? `, ${files.length} file(s)` : ''})`);

                    if (pending) pendingMessages.delete(messageId);
                    await fetch(`${API_BASE}/api/responses/${resp.id}/ack`, { method: 'POST', headers: apiHeaders() });
                } else {
                    log('WARN', `No pending message for ${messageId} and no valid senderId, acking`);
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

// Refresh typing indicator every 4 seconds for pending messages
setInterval(() => {
    for (const [, data] of pendingMessages.entries()) {
        bot.sendChatAction(data.chatId, 'typing').catch(() => {
            // Ignore typing errors silently
        });
    }
}, 4000);

// Handle polling errors
bot.on('polling_error', (error: Error) => {
    log('ERROR', `Polling error: ${error.message}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    log('INFO', 'Shutting down Telegram client...');
    bot.stopPolling();
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', 'Shutting down Telegram client...');
    bot.stopPolling();
    process.exit(0);
});

// Start
log('INFO', 'Starting Telegram client...');
