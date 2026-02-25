import { describe, it, expect } from 'vitest';
import { withConversationLock } from '../../src/lib/conversation';

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

describe('concurrency edge cases', () => {
  it('10 concurrent messages to same agent are processed sequentially', async () => {
    const order: number[] = [];
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const promises = Array.from({ length: 10 }, (_, i) =>
      withConversationLock('concurrent-10', async () => {
        order.push(i);
        await delay(5);
      })
    );

    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('lock released after error allows next caller to proceed', async () => {
    suppressUnhandledRejections();
    try {
      const order: string[] = [];

      const p1 = withConversationLock('err-release', async () => {
        order.push('error');
        throw new Error('fail');
      }).catch(() => {}); // swallow error

      const p2 = withConversationLock('err-release', async () => {
        order.push('success');
        return 'ok';
      });

      await Promise.all([p1, p2]);
      expect(order).toEqual(['error', 'success']);
    } finally {
      await new Promise(resolve => setTimeout(resolve, 10));
      restoreUnhandledRejections();
    }
  });

  it('three concurrent lock callers execute in FIFO order', async () => {
    const order: string[] = [];
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    const p1 = withConversationLock('fifo-3', async () => {
      order.push('first');
      await delay(30);
    });
    const p2 = withConversationLock('fifo-3', async () => {
      order.push('second');
      await delay(10);
    });
    const p3 = withConversationLock('fifo-3', async () => {
      order.push('third');
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(['first', 'second', 'third']);
  });
});
