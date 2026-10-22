import { EventEmitter } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { emptyState, type ControllerState } from './model.js';

/**
 * Events: 'change' (state), 'online', 'offline' (on transitions of state.online),
 * 'command' (emitted by the command layer).
 */
export class StateStore extends EventEmitter {
  private state: ControllerState = emptyState;

  get(): ControllerState {
    return this.state;
  }

  patch(p: Partial<ControllerState>): void {
    const next = { ...this.state, ...p };
    if (isDeepStrictEqual(next, this.state)) return;
    const wasOnline = this.state.online;
    this.state = next;
    this.emit('change', next);
    if (next.online && !wasOnline) this.emit('online');
    else if (!next.online && wasOnline) this.emit('offline');
  }
}
