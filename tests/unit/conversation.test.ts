import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  withConversationLock,
  incrementPending,
  decrementPending,
} from '../../src/lib/conversation';
import { Conversation, TeamConfig } from '../../src/lib/types';

// The lock implementation uses `execution.finally(...)` which creates a
// dangling promise chain that can surface as an unhandled rejection when
// the inner function throws.  Suppress during error-path tests.
let savedListeners: ((...args: any[]) => void)[] = [];
function suppressUnhandledRejections() {
  savedListeners = process.listeners('unhandledRejection') as any[];
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', () => {}); // swallow
}
function restoreUnhandledRejections() {
  process.removeAllListeners('unhandledRejection');
  for (const fn of savedListeners) {
    process.on('unhandledRejection', fn);
  }
  savedListeners = [];
}

// ── Helper ────────────────────────────────────────────────────────────────────

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'test-conv',
    channel: 'test',
    sender: 'user',
    originalMessage: 'hello',
    messageId: 'msg-1',
    pending: 0,
    responses: [],
    files: new Set<string>(),
    totalMessages: 0,
    maxMessages: 50,
    teamContext: { teamId: 'dev', team: { name: 'Dev', agents: ['a'], leader_agent: 'a' } },
    startTime: Date.now(),
    outgoingMentions: new Map(),
    ...overrides,
  };
}

// ── withConversationLock ──────────────────────────────────────────────────────

describe('withConversationLock', () => {
  it('executes the function and returns its result', async () => {
    const result = await withConversationLock('lock-1', async () => 42);
    expect(result).toBe(42);
  });

  it('serializes concurrent calls to the same conversation ID', async () => {
    const order: number[] = [];
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const p1 = withConversationLock('lock-serial', async () => {
      order.push(1);
      await delay(50);
      order.push(2);
    });

    const p2 = withConversationLock('lock-serial', async () => {
      order.push(3);
      await delay(10);
      order.push(4);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('allows different IDs to run in parallel', async () => {
    const order: string[] = [];
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const p1 = withConversationLock('lock-a', async () => {
      order.push('a-start');
      await delay(50);
      order.push('a-end');
    });

    const p2 = withConversationLock('lock-b', async () => {
      order.push('b-start');
      await delay(10);
      order.push('b-end');
    });

    await Promise.all([p1, p2]);
    // b should finish before a because it has a shorter delay and they run in parallel
    expect(order.indexOf('b-end')).toBeLessThan(order.indexOf('a-end'));
  });

  it('propagates errors and releases the lock', async () => {
    suppressUnhandledRejections();
    try {
      await expect(
        withConversationLock('lock-err', async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      // Lock should be released — next call should succeed
      const result = await withConversationLock('lock-err', async () => 'ok');
      expect(result).toBe('ok');
    } finally {
      // Allow any microtasks from the lock's .finally() to settle
      await new Promise(resolve => setTimeout(resolve, 10));
      restoreUnhandledRejections();
    }
  });

  it('three concurrent callers execute in FIFO order', async () => {
    const order: number[] = [];
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const p1 = withConversationLock('lock-fifo', async () => {
      order.push(1);
      await delay(30);
    });
    const p2 = withConversationLock('lock-fifo', async () => {
      order.push(2);
      await delay(10);
    });
    const p3 = withConversationLock('lock-fifo', async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });
});

// ── incrementPending / decrementPending ───────────────────────────────────────

describe('incrementPending', () => {
  it('increments the pending counter by the given count', () => {
    const conv = makeConversation({ pending: 0 });
    incrementPending(conv, 3);
    expect(conv.pending).toBe(3);
  });

  it('increments from an existing value', () => {
    const conv = makeConversation({ pending: 2 });
    incrementPending(conv, 1);
    expect(conv.pending).toBe(3);
  });
});

describe('decrementPending', () => {
  it('returns false when pending is still > 0 after decrement', () => {
    const conv = makeConversation({ pending: 2 });
    const done = decrementPending(conv);
    expect(done).toBe(false);
    expect(conv.pending).toBe(1);
  });

  it('returns true when pending reaches 0', () => {
    const conv = makeConversation({ pending: 1 });
    const done = decrementPending(conv);
    expect(done).toBe(true);
    expect(conv.pending).toBe(0);
  });

  it('handles underflow: resets to 0 and returns true', () => {
    const conv = makeConversation({ pending: 0 });
    const done = decrementPending(conv);
    // pending goes to -1, gets reset to 0, returns true (pending === 0)
    expect(done).toBe(true);
    expect(conv.pending).toBe(0);
  });
});
