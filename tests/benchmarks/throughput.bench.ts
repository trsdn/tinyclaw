import { describe, bench, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;
let db: typeof import('../../src/lib/db');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyclaw-bench-'));
  process.env.TINYCLAW_HOME = tmpDir;
  vi.resetModules();
  db = await import('../../src/lib/db');
  db.initQueueDb();
});

afterAll(() => {
  try { db.closeQueueDb(); } catch { /* ignore */ }
  delete process.env.TINYCLAW_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let msgCounter = 0;

describe('queue throughput', () => {
  bench('enqueueMessage', () => {
    msgCounter++;
    db.enqueueMessage({
      channel: 'bench',
      sender: 'user',
      message: `bench message ${msgCounter}`,
      messageId: `bench-enq-${msgCounter}`,
      agent: 'bench-agent',
    });
  });

  bench('claimNextMessage + completeMessage', () => {
    msgCounter++;
    db.enqueueMessage({
      channel: 'bench',
      sender: 'user',
      message: `bench message ${msgCounter}`,
      messageId: `bench-claim-${msgCounter}`,
      agent: 'bench-agent-claim',
    });
    const msg = db.claimNextMessage('bench-agent-claim');
    if (msg) db.completeMessage(msg.id);
  });
});
