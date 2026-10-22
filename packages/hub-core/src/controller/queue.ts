/**
 * 'history' is a one-off read (the run log) that must not be lost to the poller: it waits behind
 * commands and confirms, is never superseded by polls, and is aborted by a command like a poll.
 */
export type Priority = 'command' | 'confirm' | 'history' | 'poll';

export class PollSuperseded extends Error {
  constructor() {
    super('poll superseded by a newer request');
    this.name = 'PollSuperseded';
  }
}

interface Task {
  readonly priority: Priority;
  readonly fn: (signal: AbortSignal) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

interface Running {
  readonly priority: Priority;
  readonly controller: AbortController;
}

const ORDER: readonly Priority[] = ['command', 'confirm', 'history', 'poll'];
const PREEMPTIBLE: readonly Priority[] = ['history', 'poll'];

/** Runs one task at a time; commands beat confirms beat history beats polls; a new poll replaces a waiting one. */
export class SerialQueue {
  private readonly waiting: Record<Priority, Task[]> = { command: [], confirm: [], history: [], poll: [] };
  private running: Running | null = null;
  private readonly maxPollBacklog: number;

  constructor(opts: { maxPollBacklog?: number } = {}) {
    this.maxPollBacklog = Math.max(1, opts.maxPollBacklog ?? 1);
  }

  get inFlight(): boolean {
    return this.running !== null;
  }

  run<T>(priority: Priority, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (priority === 'poll') this.supersedeOldestPolls();
      this.waiting[priority].push({ priority, fn, resolve: resolve as (v: unknown) => void, reject });
      if (priority === 'command' && this.running && PREEMPTIBLE.includes(this.running.priority)) {
        this.running.controller.abort(new PollSuperseded());
      }
      this.pump();
    });
  }

  private supersedeOldestPolls(): void {
    const polls = this.waiting.poll;
    while (polls.length >= this.maxPollBacklog) polls.shift()?.reject(new PollSuperseded());
  }

  private next(): Task | undefined {
    for (const p of ORDER) {
      const task = this.waiting[p].shift();
      if (task) return task;
    }
    return undefined;
  }

  private pump(): void {
    if (this.running) return;
    const task = this.next();
    if (!task) return;
    const controller = new AbortController();
    this.running = { priority: task.priority, controller };
    const settle = () => {
      this.running = null;
      this.pump();
    };
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(task.fn(controller.signal));
    } catch (err) {
      result = Promise.reject(err);
    }
    result.then(
      (value) => {
        task.resolve(value);
        settle();
      },
      (err: unknown) => {
        task.reject(err);
        settle();
      },
    );
  }
}
