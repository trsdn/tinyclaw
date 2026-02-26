#!/usr/bin/env node
/**
 * WhatsApp Client for TinyClaw Simple
 * Writes messages to queue and reads responses
 * Does NOT call Claude directly - that's handled by queue-processor
 */

import { Client, LocalAuth, Message, Chat, MessageMedia, MessageTypes } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { ensureSenderPaired } from '../lib/pairing';
import { apiHeaders, apiJsonHeaders } from '../lib/api-auth';
import {
    SCRIPT_DIR,
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
    generateMessageId,
    buildFullMessage,
    cleanupPendingMessages,
} from '../lib/channel-common';

const LOG_FILE = channelLogFile('whatsapp');
const SESSION_DIR = path.join(SCRIPT_DIR, '.tinyclaw/whatsapp-session');

// Ensure directories exist
ensureDirs([path.dirname(LOG_FILE), SESSION_DIR, FILES_DIR]);

interface PendingMessage {
    message: Message;
    chat: Chat;
    timestamp: number;
}

// Media message types that we can download
const MEDIA_TYPES: string[] = [
    MessageTypes.IMAGE,
    MessageTypes.AUDIO,
    MessageTypes.VOICE,
    MessageTypes.VIDEO,
    MessageTypes.DOCUMENT,
    MessageTypes.STICKER,
];

// Get file extension from mime type
function extFromMime(mime?: string): string {
    if (!mime) return '.bin';
    const map: Record<string, string> = {
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
        'image/webp': '.webp', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3',
        'audio/mp4': '.m4a', 'video/mp4': '.mp4', 'application/pdf': '.pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'text/plain': '.txt',
    };
    return map[mime] || `.${mime.split('/')[1] || 'bin'}`;
}

// Download media from a WhatsApp message and save to FILES_DIR
async function downloadWhatsAppMedia(message: Message, queueMessageId: string): Promise<string | null> {
    try {
        const media = await message.downloadMedia();
        if (!media || !media.data) return null;

        const ext = message.type === MessageTypes.DOCUMENT && (message as any)._data?.filename
            ? path.extname((message as any)._data.filename)
            : extFromMime(media.mimetype);

        const filename = `whatsapp_${queueMessageId}_${Date.now()}${ext}`;
        const localPath = path.join(FILES_DIR, filename);

        // Write base64 data to file
        fs.writeFileSync(localPath, Buffer.from(media.data, 'base64'));
        log('INFO', `Downloaded media: ${filename} (${media.mimetype})`);
        return localPath;
    } catch (error) {
        log('ERROR', `Failed to download media: ${(error as Error).message}`);
        return null;
    }
}

// Track pending messages (waiting for response)
const pendingMessages = new Map<string, PendingMessage>();
let processingOutgoingQueue = false;

// Logger
const log = createLogger(LOG_FILE);

// WhatsApp-specific formatting: *bold* for headers
const whatsappBold = (s: string) => `*${s}*`;
function whatsappTeamListText(): string {
    return getTeamListText(whatsappBold);
}
function whatsappAgentListText(): string {
    return getAgentListText(whatsappBold);
}

// Initialize WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: SESSION_DIR
    }),
    puppeteer: {
        headless: 'new' as any,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

// QR Code for authentication
client.on('qr', (qr: string) => {
    log('INFO', 'Scan this QR code with WhatsApp:');
    console.log('\n');

    // Display in tmux pane
    qrcode.generate(qr, { small: true });

    // Save to file for tinyclaw.sh to display (avoids tmux capture distortion)
    const channelsDir = path.join(TINYCLAW_HOME, 'channels');
    if (!fs.existsSync(channelsDir)) {
        fs.mkdirSync(channelsDir, { recursive: true });
    }
    const qrFile = path.join(channelsDir, 'whatsapp_qr.txt');
    qrcode.generate(qr, { small: true }, (code: string) => {
        fs.writeFileSync(qrFile, code);
        log('INFO', 'QR code saved to .tinyclaw/channels/whatsapp_qr.txt');
    });

    console.log('\n');
    log('INFO', 'Open WhatsApp → Settings → Linked Devices → Link a Device');
});

// Authentication success
client.on('authenticated', () => {
    log('INFO', 'WhatsApp authenticated successfully!');
});

// Client ready
client.on('ready', () => {
    log('INFO', '✓ WhatsApp client connected and ready!');
    log('INFO', 'Listening for messages...');

    // Create ready flag for tinyclaw.sh
    const readyFile = path.join(TINYCLAW_HOME, 'channels/whatsapp_ready');
    fs.writeFileSync(readyFile, Date.now().toString());
});

// Message received - Write to queue
client.on('message_create', async (message: Message) => {
    try {
        // Skip outgoing messages
        if (message.fromMe) {
            return;
        }

        // Check if message has downloadable media
        const hasMedia = message.hasMedia && MEDIA_TYPES.includes(message.type);
        const isChat = message.type === 'chat';

        // Skip messages that are neither chat nor media
        if (!isChat && !hasMedia) {
            return;
        }

        let messageText = message.body || '';
        const downloadedFiles: string[] = [];

        const chat = await message.getChat();
        const contact = await message.getContact();
        const sender = contact.pushname || contact.name || message.from;

        // Skip group messages
        if (chat.isGroup) {
            return;
        }

        // Generate unique message ID
        const messageId = generateMessageId();

        // Download media if present
        if (hasMedia) {
            const filePath = await downloadWhatsAppMedia(message, messageId);
            if (filePath) {
                downloadedFiles.push(filePath);
            }
            // Add context for stickers
            if (message.type === MessageTypes.STICKER && !messageText) {
                messageText = '[Sticker]';
            }
        }

        // Skip if no text and no media
        if ((!messageText || messageText.trim().length === 0) && downloadedFiles.length === 0) {
            return;
        }

        log('INFO', `📱 Message from ${sender}: ${messageText.substring(0, 50)}${downloadedFiles.length > 0 ? ` [+${downloadedFiles.length} file(s)]` : ''}...`);

        const pairing = ensureSenderPaired(PAIRING_FILE, 'whatsapp', message.from, sender);
        if (!pairing.approved && pairing.code) {
            if (pairing.isNewPending) {
                log('INFO', `Blocked unpaired WhatsApp sender ${sender} (${message.from}) with code ${pairing.code}`);
                await message.reply(pairingMessage(pairing.code));
            } else {
                log('INFO', `Blocked pending WhatsApp sender ${sender} (${message.from}) without re-sending pairing message`);
            }
            return;
        }

        // Check for agent list command
        if (message.body.trim().match(/^[!/]agent$/i)) {
            log('INFO', 'Agent list command received');
            const agentList = whatsappAgentListText();
            await message.reply(agentList);
            return;
        }

        // Check for team list command
        if (message.body.trim().match(/^[!/]team$/i)) {
            log('INFO', 'Team list command received');
            const teamList = whatsappTeamListText();
            await message.reply(teamList);
            return;
        }

        // Check for reset command: /reset @agent_id [@agent_id2 ...]
        const resetMatch = messageText.trim().match(/^[!/]reset\s+(.+)$/i);
        if (messageText.trim().match(/^[!/]reset$/i)) {
            await message.reply('Usage: /reset @agent_id [@agent_id2 ...]\nSpecify which agent(s) to reset.');
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
        await chat.sendStateTyping();

        // Build message text with file references
        const fullMessage = buildFullMessage(messageText, downloadedFiles);

        // Write to queue via API
        await fetch(`${API_BASE}/api/message`, {
            method: 'POST',
            headers: apiJsonHeaders(),
            body: JSON.stringify({
                channel: 'whatsapp',
                sender,
                senderId: message.from,
                message: fullMessage,
                messageId,
                files: downloadedFiles.length > 0 ? downloadedFiles : undefined,
            }),
        });

        log('INFO', `✓ Queued message ${messageId}`);

        // Store pending message for response
        pendingMessages.set(messageId, {
            message: message,
            chat: chat,
            timestamp: Date.now()
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
        const res = await fetch(`${API_BASE}/api/responses/pending?channel=whatsapp`, { headers: apiHeaders() });
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
                let targetChat: Chat | null = pending?.chat ?? null;

                if (!targetChat && senderId) {
                    try {
                        const chatId = senderId.includes('@') ? senderId : `${senderId}@c.us`;
                        targetChat = await client.getChatById(chatId);
                    } catch (err) {
                        log('ERROR', `Could not get chat for senderId ${senderId}: ${(err as Error).message}`);
                    }
                }

                if (targetChat) {
                    // Send any attached files first
                    if (files.length > 0) {
                        for (const file of files) {
                            try {
                                if (!fs.existsSync(file)) continue;
                                const media = MessageMedia.fromFilePath(file);
                                await targetChat.sendMessage(media);
                                log('INFO', `Sent file to WhatsApp: ${path.basename(file)}`);
                            } catch (fileErr) {
                                log('ERROR', `Failed to send file ${file}: ${(fileErr as Error).message}`);
                            }
                        }
                    }

                    // Send text response
                    if (responseText) {
                        if (pending) {
                            await pending.message.reply(responseText);
                        } else {
                            await targetChat.sendMessage(responseText);
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

// Error handlers
client.on('auth_failure', (msg: string) => {
    log('ERROR', `Authentication failure: ${msg}`);
    process.exit(1);
});

client.on('disconnected', (reason: string) => {
    log('WARN', `WhatsApp disconnected: ${reason}`);

    // Remove ready flag
    const readyFile = path.join(TINYCLAW_HOME, 'channels/whatsapp_ready');
    if (fs.existsSync(readyFile)) {
        fs.unlinkSync(readyFile);
    }
});

// Graceful shutdown
process.on('SIGINT', async () => {
    log('INFO', 'Shutting down WhatsApp client...');

    // Remove ready flag
    const readyFile = path.join(TINYCLAW_HOME, 'channels/whatsapp_ready');
    if (fs.existsSync(readyFile)) {
        fs.unlinkSync(readyFile);
    }

    await client.destroy();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    log('INFO', 'Shutting down WhatsApp client...');

    // Remove ready flag
    const readyFile = path.join(TINYCLAW_HOME, 'channels/whatsapp_ready');
    if (fs.existsSync(readyFile)) {
        fs.unlinkSync(readyFile);
    }

    await client.destroy();
    process.exit(0);
});

// Start client
log('INFO', 'Starting WhatsApp client...');
client.initialize();
