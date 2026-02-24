/**
 * Shared API authentication helper for channel clients.
 * Reads the API key from settings.json or environment and provides auth headers.
 */

import fs from 'fs';
import path from 'path';

const SCRIPT_DIR = path.resolve(__dirname, '../..');
const _localTinyclaw = path.join(SCRIPT_DIR, '.tinyclaw');
const TINYCLAW_HOME = process.env.TINYCLAW_HOME
    || (fs.existsSync(path.join(_localTinyclaw, 'settings.json'))
        ? _localTinyclaw
        : path.join(require('os').homedir(), '.tinyclaw'));
const SETTINGS_FILE = path.join(TINYCLAW_HOME, 'settings.json');

let cachedKey: string | null | undefined;

function loadApiKey(): string | null {
    if (process.env.TINYCLAW_API_AUTH === 'none') {
        return null;
    }
    if (process.env.TINYCLAW_API_KEY) {
        return process.env.TINYCLAW_API_KEY;
    }
    try {
        const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        return settings?.api?.api_key || null;
    } catch {
        return null;
    }
}

/**
 * Returns headers object with Authorization if API key is configured.
 * Caches the key for the process lifetime.
 */
export function apiHeaders(extra?: Record<string, string>): Record<string, string> {
    if (cachedKey === undefined) {
        cachedKey = loadApiKey();
    }
    const headers: Record<string, string> = { ...extra };
    if (cachedKey) {
        headers['Authorization'] = `Bearer ${cachedKey}`;
    }
    return headers;
}

/**
 * Returns JSON content-type headers with auth.
 */
export function apiJsonHeaders(): Record<string, string> {
    return apiHeaders({ 'Content-Type': 'application/json' });
}
