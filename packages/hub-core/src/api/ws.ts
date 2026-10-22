import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Hub } from '../hub.js';
import { isRecord } from '../validate.js';
import { buildState } from './handlers/state.js';

export const WS_PATH = '/v1/ws';
export const WS_AUTH_TIMEOUT_MS = 2000;
export const WS_CLOSE_UNAUTHORIZED = 4401;
const MAX_MESSAGE_BYTES = 4096;

type EventName = 'command' | 'offline' | 'online' | 'power-cycle' | 'recovery-exhausted';

/**
 * Pushes state and events to authenticated WebSocket clients. Browser-compatible auth: the
 * first message must be `{type:'auth', token}` within 2 s, else the socket closes with 4401.
 */
export class WsHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  /** Authenticated sockets and the device id they authenticated as (null for the CLI token). */
  private readonly authed = new Map<WebSocket, string | null>();
  /** Serializes outgoing messages so state snapshots arrive in the order changes happened. */
  private chain: Promise<void> = Promise.resolve();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly hub: Hub) {
    this.listen(hub.store, 'change', () => this.broadcastState());
    for (const name of ['command', 'offline', 'online'] as const) {
      this.listen(hub.store, name, (payload?: unknown) => this.broadcastEvent(name, payload));
    }
    for (const name of ['power-cycle', 'recovery-exhausted'] as const) {
      this.listen(hub.watchdog, name, (payload?: unknown) => this.broadcastEvent(name, payload));
    }
    this.listen(hub.pairing, 'revoked', (deviceId?: unknown) => this.closeRevoked(deviceId));
  }

  /** A revoked device loses its live sockets at once, not just its next request. */
  private closeRevoked(deviceId: unknown): void {
    for (const [ws, id] of this.authed) {
      if (id !== null && id === deviceId) {
        this.authed.delete(ws);
        ws.close(WS_CLOSE_UNAUTHORIZED, 'revoked');
      }
    }
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = new URL(req.url ?? '/', 'http://hub').pathname;
    if (pathname !== WS_PATH) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  }

  close(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    for (const ws of this.wss.clients) ws.terminate();
    this.authed.clear();
    this.wss.close();
  }

  private listen(emitter: NodeJS.EventEmitter, event: string, fn: (payload?: unknown) => void): void {
    emitter.on(event, fn);
    this.unsubscribe.push(() => emitter.off(event, fn));
  }

  private accept(ws: WebSocket): void {
    const reject = () => ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
    const timer = setTimeout(reject, WS_AUTH_TIMEOUT_MS);
    ws.on('error', (err) => this.hub.logger.warn('rainmaker: WebSocket error', err.message));
    ws.on('close', () => {
      clearTimeout(timer);
      this.authed.delete(ws);
    });
    ws.once('message', (data: RawData) => {
      clearTimeout(timer);
      const token = this.authToken(data);
      if (token === null) return reject();
      this.authed.set(ws, this.hub.pairing.deviceId(token));
      this.enqueue(async () => this.send(ws, { type: 'state', state: await buildState(this.hub) }));
    });
  }

  /** The verified token from an auth message, or null. */
  private authToken(data: RawData): string | null {
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return null;
    }
    if (!isRecord(msg) || msg.type !== 'auth' || typeof msg.token !== 'string') return null;
    return this.hub.pairing.verify(msg.token) ? msg.token : null;
  }

  private broadcastState(): void {
    if (this.authed.size === 0) return;
    this.enqueue(async () => {
      const msg = { type: 'state', state: await buildState(this.hub) };
      for (const ws of this.authed.keys()) this.send(ws, msg);
    });
  }

  private broadcastEvent(name: EventName, payload: unknown): void {
    if (this.authed.size === 0) return;
    const msg = { type: 'event', name, payload: payload ?? null };
    this.enqueue(async () => {
      for (const ws of this.authed.keys()) this.send(ws, msg);
    });
  }

  private enqueue(job: () => Promise<void>): void {
    this.chain = this.chain
      .then(job)
      .catch((err: unknown) => this.hub.logger.error('rainmaker: WebSocket push failed', err));
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === ws.OPEN && this.authed.has(ws)) ws.send(JSON.stringify(msg));
  }
}
