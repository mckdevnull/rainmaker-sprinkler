import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { emptyState, type ControllerState } from './model.js';

/**
 * Events: 'change' (state), 'online', 'offline' (on transitions of state.online,
 * including from null = unknown),
 * 'command' (emitted by the command layer).
 */
export class StateStore extends EventEmitter {
  private state: ControllerState = emptyState;

  get(): ControllerState {
    return this.state;
  }

  patch(p: Partial<ControllerState>): void {
    const next = { ...this.state, ...p };
    const wasOnline = this.state.online;
    const prev = this.state;
    this.state = next;
    // lastSeenAt is kept current for readers but never counts as a change.
    if (isDeepStrictEqual({ ...next, lastSeenAt: null }, { ...prev, lastSeenAt: null })) return;
    this.emit('change', next);
    if (next.online === true && wasOnline !== true) this.emit('online');
    else if (next.online === false && wasOnline !== false) this.emit('offline');
  }
}
