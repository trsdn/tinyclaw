import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;

// Each test gets a fresh TINYCLAW_HOME + re-imported db module
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyclaw-db-test-'));
  process.env.TINYCLAW_HOME = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  // Close the DB before removing the temp dir
  try {
    // Dynamic import to get the current module instance
    const dbModule = require('../../src/lib/db');
    if (dbModule.closeQueueDb) dbModule.closeQueueDb();
  } catch { /* ignore */ }
  delete process.env.TINYCLAW_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function getDb() {
  const mod = await import('../../src/lib/db');
  mod.initQueueDb();
  return mod;
}

// ── enqueueMessage / claimNextMessage ─────────────────────────────────────────

describe('enqueueMessage + claimNextMessage', () => {
  it('enqueues and claims a message', async () => {
    const db = await getDb();
    db.enqueueMessage({
      channel: 'discord',
      sender: 'alice',
      message: 'hello',
      messageId: 'msg-1',
      agent: 'coder',
    });

    const claimed = db.claimNextMessage('coder');
    expect(claimed).not.toBeNull();
    expect(claimed!.message).toBe('hello');
    expect(claimed!.status).toBe('processing');
    expect(claimed!.claimed_by).toBe('coder');
  });

  it('returns null when queue is empty', async () => {
    const db = await getDb();
    const claimed = db.claimNextMessage('coder');
    expect(claimed).toBeNull();
  });

  it('prevents double-claiming the same message', async () => {
    const db = await getDb();
    db.enqueueMessage({
      channel: 'discord',
      sender: 'alice',
      message: 'hello',
      messageId: 'msg-2',
      agent: 'coder',
    });

    const first = db.claimNextMessage('coder');
    const second = db.claimNextMessage('coder');
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('claims in FIFO order', async () => {
    const db = await getDb();
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'first', messageId: 'fifo-1', agent: 'a' });
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'second', messageId: 'fifo-2', agent: 'a' });
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'third', messageId: 'fifo-3', agent: 'a' });

    const m1 = db.claimNextMessage('a');
    const m2 = db.claimNextMessage('a');
    const m3 = db.claimNextMessage('a');

    expect(m1!.message).toBe('first');
    expect(m2!.message).toBe('second');
    expect(m3!.message).toBe('third');
  });

  it('routes agent-specific messages only to that agent', async () => {
    const db = await getDb();
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'for coder', messageId: 'r-1', agent: 'coder' });
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'for reviewer', messageId: 'r-2', agent: 'reviewer' });

    const claimed = db.claimNextMessage('reviewer');
    expect(claimed).not.toBeNull();
    expect(claimed!.message).toBe('for reviewer');

    // coder should not see reviewer's message
    const coderMsg = db.claimNextMessage('coder');
    expect(coderMsg).not.toBeNull();
    expect(coderMsg!.message).toBe('for coder');
  });
});

// ── failMessage ───────────────────────────────────────────────────────────────

describe('failMessage', () => {
  it('increments retry_count and resets to pending', async () => {
    const db = await getDb();
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'fail test', messageId: 'fail-1', agent: 'a' });
    const claimed = db.claimNextMessage('a')!;

    db.failMessage(claimed.id, 'some error');

    // Should be claimable again
    const retry = db.claimNextMessage('a');
    expect(retry).not.toBeNull();
    expect(retry!.retry_count).toBe(1);
  });

  it('marks as dead after MAX_RETRIES (5)', async () => {
    const db = await getDb();
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'die test', messageId: 'die-1', agent: 'a' });

    // Fail 5 times (MAX_RETRIES = 5)
    for (let i = 0; i < 5; i++) {
      const msg = db.claimNextMessage('a');
      if (!msg) break;
      db.failMessage(msg.id, `error ${i}`);
    }

    // Should now be dead — no more messages to claim
    const dead = db.claimNextMessage('a');
    expect(dead).toBeNull();

    // Verify it appears in dead messages
    const deadMsgs = db.getDeadMessages();
    expect(deadMsgs.length).toBeGreaterThanOrEqual(1);
    expect(deadMsgs.some(m => m.message_id === 'die-1')).toBe(true);
  });
});

// ── completeMessage ───────────────────────────────────────────────────────────

describe('completeMessage', () => {
  it('marks the message as completed', async () => {
    const db = await getDb();
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'complete me', messageId: 'comp-1', agent: 'a' });
    const claimed = db.claimNextMessage('a')!;

    db.completeMessage(claimed.id);

    // Should not be claimable again
    const next = db.claimNextMessage('a');
    expect(next).toBeNull();

    // Status should show in queue status
    const status = db.getQueueStatus();
    expect(status.completed).toBeGreaterThanOrEqual(1);
  });
});

// ── getPendingAgents ──────────────────────────────────────────────────────────

describe('getPendingAgents', () => {
  it('returns distinct agents with pending messages', async () => {
    const db = await getDb();
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'm1', messageId: 'pa-1', agent: 'coder' });
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'm2', messageId: 'pa-2', agent: 'reviewer' });
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'm3', messageId: 'pa-3', agent: 'coder' });

    const agents = db.getPendingAgents();
    expect(agents.sort()).toEqual(['coder', 'reviewer']);
  });

  it('returns "default" for messages with null agent', async () => {
    const db = await getDb();
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'm', messageId: 'pa-4' });

    const agents = db.getPendingAgents();
    expect(agents).toContain('default');
  });
});

// ── recoverStaleMessages ──────────────────────────────────────────────────────

describe('recoverStaleMessages', () => {
  it('resets stale processing messages to pending', async () => {
    const db = await getDb();
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'stale', messageId: 'stale-1', agent: 'a' });
    db.claimNextMessage('a'); // now processing

    // Wait a tiny bit so the message's updated_at is strictly less than Date.now()
    await new Promise(resolve => setTimeout(resolve, 15));

    // Recover with threshold of 1ms — the 15ms-old message is stale
    const count = db.recoverStaleMessages(1);
    expect(count).toBe(1);

    // Should be claimable again
    const reclaimed = db.claimNextMessage('a');
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.message).toBe('stale');
  });

  it('respects the threshold — does not recover fresh messages', async () => {
    const db = await getDb();
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'fresh', messageId: 'fresh-1', agent: 'a' });
    db.claimNextMessage('a');

    // Recover with a large threshold — nothing should be recovered
    const count = db.recoverStaleMessages(10 * 60 * 1000);
    expect(count).toBe(0);
  });
});

// ── getQueueStatus ────────────────────────────────────────────────────────────

describe('getQueueStatus', () => {
  it('returns correct counts for all statuses', async () => {
    const db = await getDb();

    // pending
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'p1', messageId: 'qs-1', agent: 'a' });
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'p2', messageId: 'qs-2', agent: 'a' });

    // processing
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'proc', messageId: 'qs-3', agent: 'b' });
    db.claimNextMessage('b');

    // completed
    db.enqueueMessage({ channel: 'c', sender: 's', message: 'done', messageId: 'qs-4', agent: 'c' });
    const claimed = db.claimNextMessage('c')!;
    db.completeMessage(claimed.id);

    const status = db.getQueueStatus();
    expect(status.pending).toBe(2);
    expect(status.processing).toBe(1);
    expect(status.completed).toBe(1);
    expect(status.dead).toBe(0);
  });
});
