/**
 * API Server — HTTP endpoints for Mission Control and external integrations.
 *
 * Runs on a configurable port (env TINYCLAW_API_PORT, default 3777) and
 * provides REST + SSE access to agents, teams, settings, queue status,
 * events, logs, and chat histories.
 *
 * Security:
 *   - Binds to 127.0.0.1 by default (localhost only, not network-accessible)
 *   - API key auth via Bearer token (auto-generated on first start)
 *   - CORS restricted to localhost origins
 */

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Conversation } from '../lib/types';
import { getSettings, SETTINGS_FILE } from '../lib/config';
import { log } from '../lib/logging';
import { addSSEClient, removeSSEClient } from './sse';

import messagesRoutes from './routes/messages';
import agentsRoutes from './routes/agents';
import teamsRoutes from './routes/teams';
import settingsRoutes from './routes/settings';
import { createQueueRoutes } from './routes/queue';
import tasksRoutes from './routes/tasks';
import logsRoutes from './routes/logs';
import chatsRoutes from './routes/chats';

const API_PORT = parseInt(process.env.TINYCLAW_API_PORT || '3777', 10);

/**
 * Load or generate the API key. Persists to settings.json so it survives restarts.
 * Can be disabled by setting TINYCLAW_API_AUTH=none.
 */
function getOrCreateApiKey(): string | null {
    if (process.env.TINYCLAW_API_AUTH === 'none') {
        return null;
    }

    // Env override takes priority
    if (process.env.TINYCLAW_API_KEY) {
        return process.env.TINYCLAW_API_KEY;
    }

    const settings = getSettings();
    if (settings.api?.api_key) {
        return settings.api.api_key;
    }

    // Auto-generate and persist
    const key = `tc_${crypto.randomBytes(24).toString('hex')}`;
    try {
        const raw = fs.existsSync(SETTINGS_FILE)
            ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
            : {};
        raw.api = raw.api || {};
        raw.api.api_key = key;
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(raw, null, 2) + '\n');
    } catch {
        // Non-fatal — key works for this session even if persist fails
    }
    return key;
}

/**
 * Create and start the API server.
 *
 * @param conversations  Live reference to the queue-processor conversation map
 *                       so the /api/queue/status endpoint can report active count.
 * @returns The http.Server instance (for graceful shutdown).
 */
export function startApiServer(
    conversations: Map<string, Conversation>
): http.Server {
    const app = new Hono();
    const apiKey = getOrCreateApiKey();
    const settings = getSettings();
    const bindHost = settings.api?.bind_host || process.env.TINYCLAW_API_HOST || '127.0.0.1';

    // CORS — restrict to localhost origins only
    app.use('/*', cors({
        origin: [
            `http://localhost:${API_PORT}`,
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            `http://127.0.0.1:${API_PORT}`,
        ],
    }));

    // API key auth middleware — applied to all /api/* routes
    if (apiKey) {
        app.use('/api/*', async (c, next) => {
            const authHeader = c.req.header('Authorization');
            const queryKey = c.req.query('api_key');

            const providedKey = authHeader?.startsWith('Bearer ')
                ? authHeader.slice(7)
                : queryKey;

            if (providedKey !== apiKey) {
                return c.json({ error: 'Unauthorized. Provide Bearer token or ?api_key= parameter.' }, 401);
            }

            await next();
        });
    }

    // Mount route modules
    app.route('/', messagesRoutes);
    app.route('/', agentsRoutes);
    app.route('/', teamsRoutes);
    app.route('/', settingsRoutes);
    app.route('/', createQueueRoutes(conversations));
    app.route('/', tasksRoutes);
    app.route('/', logsRoutes);
    app.route('/', chatsRoutes);

    // SSE endpoint — needs raw Node.js response for streaming
    app.get('/api/events/stream', (c) => {
        const nodeRes = (c.env as { outgoing: http.ServerResponse }).outgoing;
        nodeRes.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        nodeRes.write(`event: connected\ndata: ${JSON.stringify({ timestamp: Date.now() })}\n\n`);
        addSSEClient(nodeRes);
        nodeRes.on('close', () => removeSSEClient(nodeRes));
        return RESPONSE_ALREADY_SENT;
    });

    // 404 fallback
    app.notFound((c) => {
        return c.json({ error: 'Not found' }, 404);
    });

    // Error handler
    app.onError((err, c) => {
        log('ERROR', `[API] ${err.message}`);
        return c.json({ error: 'Internal server error' }, 500);
    });

    const server = serve({
        fetch: app.fetch,
        port: API_PORT,
        hostname: bindHost,
    }, () => {
        log('INFO', `API server listening on http://${bindHost}:${API_PORT}`);
        if (apiKey) {
            log('INFO', `API key: ${apiKey.slice(0, 6)}..${apiKey.slice(-4)} (use Bearer token or ?api_key=)`);
        } else {
            log('WARN', 'API auth disabled (TINYCLAW_API_AUTH=none)');
        }
    });

    return server as unknown as http.Server;
}
