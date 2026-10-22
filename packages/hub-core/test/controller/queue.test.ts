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
