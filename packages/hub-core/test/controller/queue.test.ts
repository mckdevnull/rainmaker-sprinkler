import { describe, expect, it } from 'vitest';
import { PollSuperseded, SerialQueue } from '../../src/controller/queue.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('SerialQueue', () => {
  it('runs tasks one at a time', async () => {
    const q = new SerialQueue();
    const events: string[] = [];
    const task = (name: string) => async () => {
      events.push(`start ${name}`);
      await sleep(100);
      events.push(`end ${name}`);
    };
    const a = q.run('command', task('a'));
    const b = q.run('command', task('b'));
    expect(q.inFlight).toBe(true);
    await Promise.all([a, b]);
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b']);
    expect(q.inFlight).toBe(false);
  });

  it('command jumps ahead of waiting polls', async () => {
    const q = new SerialQueue({ maxPollBacklog: 5 });
    const order: string[] = [];
    const task = (name: string) => async () => {
      await sleep(20);
      order.push(name);
    };
    await Promise.all([q.run('poll', task('A')), q.run('poll', task('B')), q.run('command', task('C'))]);
    expect(order).toEqual(['A', 'C', 'B']);
  });

  it('a new poll replaces a waiting poll', async () => {
    const q = new SerialQueue();
    const order: string[] = [];
    const task = (name: string) => async () => {
      await sleep(20);
      order.push(name);
    };
    const a = q.run('poll', task('A'));
    const b = q.run('poll', task('B'));
    const c = q.run('poll', task('C'));
    await expect(b).rejects.toBeInstanceOf(PollSuperseded);
    await Promise.all([a, c]);
    expect(order).toEqual(['A', 'C']);
  });

  it('history is never superseded by polls', async () => {
    const q = new SerialQueue();
    const order: string[] = [];
    const task = (name: string) => async () => {
      await sleep(10);
      order.push(name);
    };
    const first = q.run('poll', task('P0'));
    const h = q.run('history', task('H'));
    const polls = [1, 2, 3, 4].map((i) => q.run('poll', task(`P${i}`)).catch((e: unknown) => e));
    await expect(h).resolves.toBeUndefined();
    await first;
    const results = await Promise.all(polls);
    expect(results.slice(0, 3).every((r) => r instanceof PollSuperseded)).toBe(true);
    expect(order).toEqual(['P0', 'H', 'P4']);
  });

  it('history waits behind commands and confirms, and a command aborts it in flight', async () => {
    const q = new SerialQueue();
    const order: string[] = [];
    let historySignal: AbortSignal | undefined;
    const blocker = q.run('poll', () => sleep(10));
    const h = q.run('history', (signal) => {
      historySignal = signal;
      order.push('H');
      return new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    });
    q.run('confirm', async () => void order.push('C'));
    await blocker;
    await sleep(0);
    expect(order).toEqual(['C', 'H']);
    const cmd = q.run('command', async () => void order.push('X'));
    expect(historySignal?.aborted).toBe(true);
    await expect(h).rejects.toBeInstanceOf(PollSuperseded);
    await cmd;
    expect(order).toEqual(['C', 'H', 'X']);
  });

  it('a failing task does not block the queue', async () => {
    const q = new SerialQueue();
    const bad = q.run('command', async () => {
      throw new Error('boom');
    });
    const good = q.run('command', async () => 'ok');
    await expect(bad).rejects.toThrow('boom');
    await expect(good).resolves.toBe('ok');
  });

  it('a queued command aborts the in-flight poll', async () => {
    const q = new SerialQueue();
    let pollSignal: AbortSignal | undefined;
    let pollSettledAt = 0;
    let commandStartedAt = 0;
    const a = q.run('poll', (signal) => {
      pollSignal = signal;
      return new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => {
            pollSettledAt = Date.now();
            reject(new Error('aborted'));
          }, 30);
        });
      });
    });
    const aSettled = a.catch(() => undefined);
    expect(pollSignal?.aborted).toBe(false);
    const c = q.run('command', async () => {
      commandStartedAt = Date.now();
    });
    expect(pollSignal?.aborted).toBe(true);
    await aSettled;
    await c;
    expect(commandStartedAt - pollSettledAt).toBeLessThan(10);
    await expect(a).rejects.toThrow('aborted');
  });

  it('confirm is never superseded', async () => {
    const q = new SerialQueue();
    const order: string[] = [];
    const task = (name: string) => async () => {
      await sleep(20);
      order.push(name);
    };
    const x = q.run('confirm', task('X'));
    const y = q.run('poll', task('Y'));
    const z = q.run('poll', task('Z'));
    await expect(y).rejects.toBeInstanceOf(PollSuperseded);
    await Promise.all([x, z]);
    expect(order).toEqual(['X', 'Z']);
  });
});
