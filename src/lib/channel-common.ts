/**
 * Shared logic for all TinyClaw channel clients (Telegram, WhatsApp, Discord).
 * Centralises duplicated helpers so each channel file only contains
 * channel-specific integration code.
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

export const SCRIPT_DIR = path.resolve(__dirname, '..', '..');
const _localTinyclaw = path.join(SCRIPT_DIR, '.tinyclaw');
export const TINYCLAW_HOME = process.env.TINYCLAW_HOME
    || (fs.existsSync(path.join(_localTinyclaw, 'settings.json'))
        ? _localTinyclaw
        : path.join(require('os').homedir(), '.tinyclaw'));

export const SETTINGS_FILE = path.join(TINYCLAW_HOME, 'settings.json');
export const FILES_DIR = path.join(TINYCLAW_HOME, 'files');
export const PAIRING_FILE = path.join(TINYCLAW_HOME, 'pairing.json');

export const API_PORT = parseInt(process.env.TINYCLAW_API_PORT || '3777', 10);
export const API_BASE = `http://localhost:${API_PORT}`;

/**
 * Build the channel-specific log file path.
 */
export function channelLogFile(channelName: string): string {
    return path.join(TINYCLAW_HOME, `logs/${channelName}.log`);
}

/**
 * Ensure a list of directories exist (recursive).
 */
export function ensureDirs(dirs: string[]): void {
    dirs.forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

/**
 * Create a log() function bound to a specific log file.
 */
export function createLogger(logFile: string): (level: string, message: string) => void {
    return function log(level: string, message: string): void {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${level}] ${message}\n`;
        console.log(logMessage.trim());
        fs.appendFileSync(logFile, logMessage);
    };
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export function pairingMessage(code: string): string {
    return [
        'This sender is not paired yet.',
        `Your pairing code: ${code}`,
        'Ask the TinyClaw owner to approve you with:',
        `tinyclaw pairing approve ${code}`,
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Settings-based text helpers
// ---------------------------------------------------------------------------

/**
 * Load teams from settings and format as text.
 * @param headerFmt  function that wraps the header text for the channel
 *                   (e.g. plain, markdown, discord bold)
 * @param boldFmt    function that wraps inline text in bold for the channel
 * @param codeFmt    function that wraps inline text as code for the channel
 */
export function getTeamListText(
    headerFmt: (s: string) => string = s => s,
    boldFmt: (s: string) => string = s => s,
    codeFmt: (s: string) => string = s => s,
): string {
    try {
        const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings = JSON.parse(settingsData);
        const teams = settings.teams;
        if (!teams || Object.keys(teams).length === 0) {
            return `No teams configured.\n\nCreate a team with: ${codeFmt('tinyclaw team add')}`;
        }
        let text = `${headerFmt('Available Teams:')}\n`;
        for (const [id, team] of Object.entries(teams) as [string, any][]) {
            text += `\n${boldFmt(`@${id}`)} - ${team.name}`;
            text += `\n  Agents: ${team.agents.join(', ')}`;
            text += `\n  Leader: @${team.leader_agent}`;
        }
        text += `\n\nUsage: Start your message with ${codeFmt('@team_id')} to route to a team.`;
        return text;
    } catch {
        return 'Could not load team configuration.';
    }
}

/**
 * Load agents from settings and format as text.
 * Same formatting parameters as getTeamListText.
 */
export function getAgentListText(
    headerFmt: (s: string) => string = s => s,
    boldFmt: (s: string) => string = s => s,
    codeFmt: (s: string) => string = s => s,
): string {
    try {
        const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings = JSON.parse(settingsData);
        const agents = settings.agents;
        if (!agents || Object.keys(agents).length === 0) {
            return `No agents configured. Using default single-agent mode.\n\nConfigure agents in ${codeFmt('.tinyclaw/settings.json')} or run: ${codeFmt('tinyclaw agent add')}`;
        }
        let text = `${headerFmt('Available Agents:')}\n`;
        for (const [id, agent] of Object.entries(agents) as [string, any][]) {
            text += `\n${boldFmt(`@${id}`)} - ${agent.name}`;
            text += `\n  Provider: ${agent.provider}/${agent.model}`;
            text += `\n  Directory: ${agent.working_directory}`;
            if (agent.system_prompt) text += `\n  Has custom system prompt`;
            if (agent.prompt_file) text += `\n  Prompt file: ${agent.prompt_file}`;
        }
        text += `\n\nUsage: Start your message with ${codeFmt('@agent_id')} to route to a specific agent.`;
        return text;
    } catch {
        return 'Could not load agent configuration.';
    }
}

// ---------------------------------------------------------------------------
// Reset command
// ---------------------------------------------------------------------------

export interface ResetResult {
    results: string[];
}

/**
 * Process the /reset command: parse agent args, write reset flags.
 * Returns the result text lines.
 */
export function processResetCommand(agentArgString: string): ResetResult {
    const agentArgs = agentArgString.split(/\s+/).map(a => a.replace(/^@/, '').toLowerCase());
    const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(settingsData);
    const agents = settings.agents || {};
    const workspacePath = settings?.workspace?.path || path.join(require('os').homedir(), 'tinyclaw-workspace');
    const results: string[] = [];
    for (const agentId of agentArgs) {
        if (!agents[agentId]) {
            results.push(`Agent '${agentId}' not found.`);
            continue;
        }
        const flagDir = path.join(workspacePath, agentId);
        if (!fs.existsSync(flagDir)) fs.mkdirSync(flagDir, { recursive: true });
        fs.writeFileSync(path.join(flagDir, 'reset_flag'), 'reset');
        results.push(`Reset @${agentId} (${agents[agentId].name}).`);
    }
    return { results };
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

export function sanitizeFileName(fileName: string): string {
    const baseName = path.basename(fileName).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
    return baseName.length > 0 ? baseName : 'file.bin';
}

export function ensureFileExtension(fileName: string, fallbackExt: string): string {
    if (path.extname(fileName)) {
        return fileName;
    }
    return `${fileName}${fallbackExt}`;
}

export function buildUniqueFilePath(dir: string, preferredName: string): string {
    const cleanName = sanitizeFileName(preferredName);
    const ext = path.extname(cleanName);
    const stem = path.basename(cleanName, ext);
    let candidate = path.join(dir, cleanName);
    let counter = 1;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${stem}_${counter}${ext}`);
        counter++;
    }
    return candidate;
}

/**
 * Download a file from a URL to a local path.
 * Follows 301/302 redirects.
 */
export function downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const request = (url.startsWith('https') ? https.get(url, handleResponse) : http.get(url, handleResponse));

        function handleResponse(response: http.IncomingMessage): void {
            if (response.statusCode === 301 || response.statusCode === 302) {
                const redirectUrl = response.headers.location;
                if (redirectUrl) {
                    file.close();
                    fs.unlinkSync(destPath);
                    downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
                    return;
                }
            }
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }

        request.on('error', (err) => {
            fs.unlink(destPath, () => { }); // Clean up on error
            reject(err);
        });
    });
}

// ---------------------------------------------------------------------------
// Message splitting
// ---------------------------------------------------------------------------

/**
 * Split a long message into chunks that fit a channel's character limit.
 * Tries to break at newlines, then spaces, then hard-cuts.
 */
export function splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) {
        return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        // Try to split at a newline boundary
        let splitIndex = remaining.lastIndexOf('\n', maxLength);

        // Fall back to space boundary
        if (splitIndex <= 0) {
            splitIndex = remaining.lastIndexOf(' ', maxLength);
        }

        // Hard-cut if no good boundary found
        if (splitIndex <= 0) {
            splitIndex = maxLength;
        }

        chunks.push(remaining.substring(0, splitIndex));
        remaining = remaining.substring(splitIndex).replace(/^\n/, '');
    }

    return chunks;
}

// ---------------------------------------------------------------------------
// Queue helpers
// ---------------------------------------------------------------------------

/**
 * Generate a unique message ID for queue entries.
 */
export function generateMessageId(): string {
    return `${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

/**
 * Build the full message text including file references.
 */
export function buildFullMessage(messageText: string, downloadedFiles: string[]): string {
    let fullMessage = messageText;
    if (downloadedFiles.length > 0) {
        const fileRefs = downloadedFiles.map(f => `[file: ${f}]`).join('\n');
        fullMessage = fullMessage ? `${fullMessage}\n\n${fileRefs}` : fileRefs;
    }
    return fullMessage;
}

/**
 * Clean up entries older than the given max age from a pending-messages map.
 * Works with any map whose values have a `timestamp` property.
 */
export function cleanupPendingMessages<T extends { timestamp: number }>(
    pendingMessages: Map<string, T>,
    maxAgeMs: number = 10 * 60 * 1000,
): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, data] of pendingMessages.entries()) {
        if (data.timestamp < cutoff) {
            pendingMessages.delete(id);
        }
    }
}
