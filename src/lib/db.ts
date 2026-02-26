/**
 * SQLite-backed message queue — replaces the file-based incoming/processing/outgoing directories.
 *
 * Uses better-sqlite3 for synchronous, transactional access with WAL mode.
 * Single module-level singleton; call initQueueDb() before any other export.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { EventEmitter } from 'events';
import { TINYCLAW_HOME } from './config';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DbMessage {
    id: number;
    message_id: string;
    channel: string;
    sender: string;
    sender_id: string | null;
    message: string;
    agent: string | null;
    files: string | null;         // JSON array
    conversation_id: string | null;
    from_agent: string | null;
    status: 'pending' | 'processing' | 'completed' | 'dead';
    retry_count: number;
    last_error: string | null;
    created_at: number;
    updated_at: number;
    claimed_by: string | null;
}

export interface DbResponse {
    id: number;
    message_id: string;
    channel: string;
    sender: string;
    sender_id: string | null;
    message: string;
    original_message: string;
    agent: string | null;
    files: string | null;         // JSON array
    status: 'pending' | 'acked';
    created_at: number;
    acked_at: number | null;
}

export interface EnqueueMessageData {
    channel: string;
    sender: string;
    senderId?: string;
    message: string;
    messageId: string;
    agent?: string;
    files?: string[];
    conversationId?: string;
    fromAgent?: string;
}

export interface EnqueueResponseData {
    channel: string;
    sender: string;
    senderId?: string;
    message: string;
    originalMessage: string;
    messageId: string;
    agent?: string;
    files?: string[];
}

// ── Singleton ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 5;

let db: Database.Database | null = null;
let stmts: ReturnType<typeof prepareStatements> | null = null;

export const queueEvents = new EventEmitter();

// ── Init ─────────────────────────────────────────────────────────────────────

export function initQueueDb(customDbPath?: string): void {
    if (db) return;

    const dbPath = customDbPath || path.join(TINYCLAW_HOME, 'tinyclaw.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL UNIQUE,
            channel TEXT NOT NULL,
            sender TEXT NOT NULL,
            sender_id TEXT,
            message TEXT NOT NULL,
            agent TEXT,
            files TEXT,
            conversation_id TEXT,
            from_agent TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            retry_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            claimed_by TEXT
        );

        CREATE TABLE IF NOT EXISTS responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            sender TEXT NOT NULL,
            sender_id TEXT,
            message TEXT NOT NULL,
            original_message TEXT NOT NULL,
            agent TEXT,
            files TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at INTEGER NOT NULL,
            acked_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_messages_status_agent_created
            ON messages(status, agent, created_at);
        CREATE INDEX IF NOT EXISTS idx_responses_channel_status ON responses(channel, status);
        CREATE INDEX IF NOT EXISTS idx_responses_agent ON responses(agent, created_at);
    `);

    // Drop legacy indexes/tables
    db.exec('DROP INDEX IF EXISTS idx_messages_status');
    db.exec('DROP INDEX IF EXISTS idx_messages_agent');
    db.exec('DROP TABLE IF EXISTS events');

    stmts = prepareStatements(db);
}

function getDb(): Database.Database {
    if (!db) throw new Error('Queue DB not initialized — call initQueueDb() first');
    return db;
}

function prepareStatements(d: Database.Database) {
    return {
        enqueueMessage: d.prepare(`
            INSERT INTO messages (message_id, channel, sender, sender_id, message, agent, files, conversation_id, from_agent, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `),
        claimSelect: d.prepare(`
            SELECT * FROM messages
            WHERE status = 'pending' AND (agent = ? OR (agent IS NULL AND ? = 'default'))
            ORDER BY created_at ASC
            LIMIT 1
        `),
        claimUpdate: d.prepare(`
            UPDATE messages SET status = 'processing', claimed_by = ?, updated_at = ?
            WHERE id = ?
        `),
        completeMessage: d.prepare(`
            UPDATE messages SET status = 'completed', updated_at = ? WHERE id = ?
        `),
        failSelect: d.prepare('SELECT retry_count FROM messages WHERE id = ?'),
        failUpdate: d.prepare(`
            UPDATE messages SET status = ?, retry_count = ?, last_error = ?, claimed_by = NULL, updated_at = ?
            WHERE id = ?
        `),
        enqueueResponse: d.prepare(`
            INSERT INTO responses (message_id, channel, sender, sender_id, message, original_message, agent, files, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
        `),
        getResponsesForChannel: d.prepare(`
            SELECT * FROM responses WHERE channel = ? AND status = 'pending' ORDER BY created_at ASC
        `),
        ackResponse: d.prepare(`
            UPDATE responses SET status = 'acked', acked_at = ? WHERE id = ?
        `),
        getRecentResponses: d.prepare(`
            SELECT * FROM responses ORDER BY created_at DESC LIMIT ?
        `),
        getResponsesForAgent: d.prepare(`
            SELECT * FROM responses WHERE agent = ? ORDER BY created_at DESC LIMIT ?
        `),
        getRecentSentMessages: d.prepare(`
            SELECT id, message_id, channel, sender, sender_id, message, agent, status, created_at
            FROM messages ORDER BY created_at DESC LIMIT ?
        `),
        getSentMessagesForAgent: d.prepare(`
            SELECT id, message_id, channel, sender, sender_id, message, agent, status, created_at, conversation_id
            FROM messages WHERE agent = ? AND conversation_id IS NULL ORDER BY created_at DESC LIMIT ?
        `),
        getQueueStatus: d.prepare(`
            SELECT 'msg' as src, status, COUNT(*) as cnt FROM messages GROUP BY status
            UNION ALL
            SELECT 'resp' as src, status, COUNT(*) as cnt FROM responses WHERE status = 'pending'
        `),
        getDeadMessages: d.prepare(`
            SELECT * FROM messages WHERE status = 'dead' ORDER BY updated_at DESC
        `),
        retryDeadMessage: d.prepare(`
            UPDATE messages SET status = 'pending', retry_count = 0, claimed_by = NULL, updated_at = ?
            WHERE id = ? AND status = 'dead'
        `),
        deleteDeadMessage: d.prepare(`
            DELETE FROM messages WHERE id = ? AND status = 'dead'
        `),
        recoverStaleMessages: d.prepare(`
            UPDATE messages
            SET status = CASE WHEN retry_count + 1 >= 5 THEN 'dead' ELSE 'pending' END,
                retry_count = retry_count + 1,
                last_error = 'Recovered from stale processing state',
                claimed_by = NULL,
                updated_at = ?
            WHERE status = 'processing' AND updated_at < ?
        `),
        pruneAckedResponses: d.prepare(`
            DELETE FROM responses WHERE status = 'acked' AND acked_at < ?
        `),
        pruneCompletedMessages: d.prepare(
            `DELETE FROM messages WHERE status = 'completed' AND updated_at < ?`
        ),
        getPendingAgents: d.prepare(`
            SELECT DISTINCT COALESCE(agent, 'default') as agent FROM messages WHERE status = 'pending'
        `),
    };
}

function getStmts() {
    if (!stmts) throw new Error('Queue DB not initialized — call initQueueDb() first');
    return stmts;
}

// ── Messages (incoming queue) ────────────────────────────────────────────────

export function enqueueMessage(data: EnqueueMessageData): number {
    const now = Date.now();
    const result = getStmts().enqueueMessage.run(
        data.messageId,
        data.channel,
        data.sender,
        data.senderId ?? null,
        data.message,
        data.agent ?? null,
        data.files ? JSON.stringify(data.files) : null,
        data.conversationId ?? null,
        data.fromAgent ?? null,
        now,
        now,
    );
    const rowId = result.lastInsertRowid as number;
    queueMicrotask(() => queueEvents.emit('message:enqueued', { id: rowId, agent: data.agent }));
    return rowId;
}

/**
 * Atomically claim the oldest pending message for a given agent.
 * Uses BEGIN IMMEDIATE to prevent concurrent claims.
 */
export function claimNextMessage(agentId: string): DbMessage | null {
    const d = getDb();
    const s = getStmts();
    const claim = d.transaction(() => {
        const row = s.claimSelect.get(agentId, agentId) as DbMessage | undefined;
        if (!row) return null;
        s.claimUpdate.run(agentId, Date.now(), row.id);
        return { ...row, status: 'processing' as const, claimed_by: agentId };
    });
    return claim.immediate();
}

export function completeMessage(rowId: number): void {
    getStmts().completeMessage.run(Date.now(), rowId);
}

export function failMessage(rowId: number, error: string): void {
    const d = getDb();
    const s = getStmts();
    d.transaction(() => {
        const msg = s.failSelect.get(rowId) as { retry_count: number } | undefined;
        if (!msg) return;
        const newCount = msg.retry_count + 1;
        const newStatus = newCount >= MAX_RETRIES ? 'dead' : 'pending';
        s.failUpdate.run(newStatus, newCount, error, Date.now(), rowId);
    })();
}

// ── Responses (outgoing queue) ───────────────────────────────────────────────

export function enqueueResponse(data: EnqueueResponseData): number {
    const now = Date.now();
    const result = getStmts().enqueueResponse.run(
        data.messageId,
        data.channel,
        data.sender,
        data.senderId ?? null,
        data.message,
        data.originalMessage,
        data.agent ?? null,
        data.files ? JSON.stringify(data.files) : null,
        now,
    );
    return result.lastInsertRowid as number;
}

export function getResponsesForChannel(channel: string): DbResponse[] {
    return getStmts().getResponsesForChannel.all(channel) as DbResponse[];
}

export function ackResponse(responseId: number): void {
    getStmts().ackResponse.run(Date.now(), responseId);
}

export function getRecentResponses(limit: number): DbResponse[] {
    return getStmts().getRecentResponses.all(limit) as DbResponse[];
}

export function getResponsesForAgent(agent: string, limit: number): DbResponse[] {
    return getStmts().getResponsesForAgent.all(agent, limit) as DbResponse[];
}

export function getResponsesForAgents(agents: string[], limit: number): DbResponse[] {
    const placeholders = agents.map(() => '?').join(',');
    return getDb().prepare(`
        SELECT * FROM responses WHERE agent IN (${placeholders}) ORDER BY created_at DESC LIMIT ?
    `).all(...agents, limit) as DbResponse[];
}

export function getRecentSentMessages(limit: number): DbMessage[] {
    return getStmts().getRecentSentMessages.all(limit) as DbMessage[];
}

export function getSentMessagesForAgent(agent: string, limit: number): DbMessage[] {
    return getStmts().getSentMessagesForAgent.all(agent, limit) as DbMessage[];
}

export function getSentMessagesForAgents(agents: string[], limit: number): DbMessage[] {
    const placeholders = agents.map(() => '?').join(',');
    return getDb().prepare(`
        SELECT id, message_id, channel, sender, sender_id, message, agent, status, created_at, conversation_id
        FROM messages WHERE agent IN (${placeholders}) AND conversation_id IS NULL ORDER BY created_at DESC LIMIT ?
    `).all(...agents, limit) as DbMessage[];
}

// ── Queue status & management ────────────────────────────────────────────────

export function getQueueStatus(): {
    pending: number; processing: number; completed: number; dead: number;
    responsesPending: number;
} {
    const rows = getStmts().getQueueStatus.all() as { src: string; status: string; cnt: number }[];

    const result = { pending: 0, processing: 0, completed: 0, dead: 0, responsesPending: 0 };
    for (const row of rows) {
        if (row.src === 'msg' && row.status in result) {
            (result as any)[row.status] = row.cnt;
        } else if (row.src === 'resp') {
            result.responsesPending = row.cnt;
        }
    }

    return result;
}

export function getDeadMessages(): DbMessage[] {
    return getStmts().getDeadMessages.all() as DbMessage[];
}

export function retryDeadMessage(rowId: number): boolean {
    const result = getStmts().retryDeadMessage.run(Date.now(), rowId);
    return result.changes > 0;
}

export function deleteDeadMessage(rowId: number): boolean {
    const result = getStmts().deleteDeadMessage.run(rowId);
    return result.changes > 0;
}

/**
 * Recover messages stuck in 'processing' for longer than thresholdMs (default 10 min).
 */
export function recoverStaleMessages(thresholdMs = 10 * 60 * 1000): number {
    const cutoff = Date.now() - thresholdMs;
    const result = getStmts().recoverStaleMessages.run(Date.now(), cutoff);
    return result.changes;
}

/**
 * Clean up acked responses older than the given threshold (default 24h).
 */
export function pruneAckedResponses(olderThanMs = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - olderThanMs;
    return getStmts().pruneAckedResponses.run(cutoff).changes;
}

export function pruneCompletedMessages(olderThanMs = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - olderThanMs;
    return getStmts().pruneCompletedMessages.run(cutoff).changes;
}

/**
 * Get all distinct agent values from pending messages (for processQueue iteration).
 */
export function getPendingAgents(): string[] {
    const rows = getStmts().getPendingAgents.all() as { agent: string }[];
    return rows.map(r => r.agent);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export function closeQueueDb(): void {
    stmts = null;
    if (db) {
        db.close();
        db = null;
    }
}
