import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;
let dbMod: typeof import('../../src/lib/db');

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinyclaw-recovery-test-'));
  process.env.TINYCLAW_HOME = tmpDir;
  vi.resetModules();
  dbMod = await import('../../src/lib/db');
  dbMod.initQueueDb();
});

afterEach(() => {
  if (dbMod) dbMod.closeQueueDb();
  delete process.env.TINYCLAW_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('stale message recovery', () => {
  it('recovers messages stuck in processing after simulated crash', async () => {
    // Enqueue and claim (simulating a processor picking it up)
    dbMod.enqueueMessage({
      channel: 'discord',
      sender: 'alice',
      message: 'stuck message',
      messageId: 'crash-1',
      agent: 'coder',
    });
    const claimed = dbMod.claimNextMessage('coder');
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('processing');

    // Wait so the message's updated_at is strictly in the past
    await new Promise(resolve => setTimeout(resolve, 15));

    // Recover with threshold of 1ms — the 15ms-old message is stale
    const recovered = dbMod.recoverStaleMessages(1);
    expect(recovered).toBe(1);

    // Message should be claimable again
    const reclaimed = dbMod.claimNextMessage('coder');
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.message).toBe('stuck message');
  });

  it('recovery increments retry_count (does not reset to 0)', async () => {
    // The current implementation of recoverStaleMessages increments
    // retry_count by 1 (treating recovery as a retry attempt) and
    // will mark as 'dead' if retry_count reaches MAX_RETRIES (5).
    dbMod.enqueueMessage({
      channel: 'c',
      sender: 's',
      message: 'retry test',
      messageId: 'retry-rec-1',
      agent: 'a',
    });

    // Claim and fail twice to bump retry_count to 2
    let msg = dbMod.claimNextMessage('a')!;
    dbMod.failMessage(msg.id, 'error 1');
    msg = dbMod.claimNextMessage('a')!;
    dbMod.failMessage(msg.id, 'error 2');

    // Claim again — retry_count should be 2
    msg = dbMod.claimNextMessage('a')!;
    expect(msg.retry_count).toBe(2);

    // Wait so the message's updated_at is strictly in the past
    await new Promise(resolve => setTimeout(resolve, 15));

    // Recover stale (threshold 1ms to force recovery)
    const count = dbMod.recoverStaleMessages(1);
    expect(count).toBe(1);

    // After recovery, retry_count is incremented to 3 (2 fails + 1 recovery)
    const recovered = dbMod.claimNextMessage('a')!;
    expect(recovered).not.toBeNull();
    expect(recovered!.retry_count).toBe(3);
  });
});
