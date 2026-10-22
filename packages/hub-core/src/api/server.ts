import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Hub } from '../hub.js';
import { ValidationError } from '../validate.js';
import { HttpError, type ApiResponse } from './handlers/context.js';
import { JSON_LIMIT_BYTES, matchRoute, PHOTO_LIMIT_BYTES, type Route } from './routes.js';
import { WsHub } from './ws.js';

const MAX_TOKEN_LENGTH = 512;
const CORS_MAX_AGE_SEC = 600;
const SAFE_METHODS = new Set(['GET', 'HEAD']);

class TooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) {
    req.resume(); // drain so the 413 reaches the client
    return Promise.reject(new TooLarge());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners('data');
        req.resume();
        reject(new TooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h || h.length > MAX_TOKEN_LENGTH + 7) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m?.[1] ?? null;
}

/** The local HTTP API plus the /v1/ws WebSocket on the same port. */
export class ApiServer {
  private readonly server: Server;
  private readonly ws: WsHub;
  private readonly writeOrigins: ReadonlySet<string>;

  constructor(private readonly hub: Hub) {
    const controller = new URL(hub.config.controller.baseUrl);
    this.writeOrigins = new Set([...hub.config.allowedOrigins, `http://${controller.host}`]);
    this.ws = new WsHub(hub);
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        hub.logger.error('rainmaker: API request failed', err);
        if (!res.headersSent) this.send(res, { status: 500, json: { error: 'internal error' } });
        else res.destroy();
      });
    });
    this.server.on('upgrade', (req, socket, head) => this.ws.handleUpgrade(req, socket, head));
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    this.ws.close();
    this.server.closeAllConnections();
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** GET from any origin; other methods only from allowedOrigins and the controller's own page. */
  private cors(req: IncomingMessage, res: ServerResponse, method: string): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (!SAFE_METHODS.has(method) && !this.writeOrigins.has(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    return true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://hub');
    if (method === 'OPTIONS') return this.preflight(req, res);
    if (!this.cors(req, res, method)) return this.send(res, { status: 403, json: { error: 'origin not allowed' } });
    const match = matchRoute(method, url.pathname);
    if (match.kind === 'not-found') return this.send(res, { status: 404, json: { error: 'not found' } });
    if (match.kind === 'method-not-allowed') {
      res.setHeader('Allow', match.allow.join(', '));
      return this.send(res, { status: 405, json: { error: 'method not allowed' } });
    }
    const { route, params } = match;
    if (!route.public) {
      const token = bearer(req);
      if (!token || !this.hub.pairing.verify(token)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        return this.send(res, { status: 401, json: { error: 'unauthorized' } });
      }
    }
    this.send(res, await this.dispatch(req, route, params));
  }

  private preflight(req: IncomingMessage, res: ServerResponse): void {
    const wanted = String(req.headers['access-control-request-method'] ?? 'GET').toUpperCase();
    if (!this.cors(req, res, wanted)) return this.send(res, { status: 403, json: { error: 'origin not allowed' } });
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', String(CORS_MAX_AGE_SEC));
    res.writeHead(204);
    res.end();
  }

  private async dispatch(req: IncomingMessage, route: Route, params: Record<string, string>): Promise<ApiResponse> {
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    try {
      let body: unknown;
      let raw: Buffer | null = null;
      if (route.body === 'json') {
        const text = (await readBody(req, JSON_LIMIT_BYTES)).toString('utf8');
        try {
          body = text.trim() === '' ? {} : JSON.parse(text);
        } catch {
          return { status: 400, json: { error: 'body is not valid JSON', field: 'body' } };
        }
      } else if (route.body === 'jpeg') {
        raw = await readBody(req, PHOTO_LIMIT_BYTES);
      } else {
        req.resume();
      }
      return await route.handler(this.hub, { params, body, raw, contentType });
    } catch (err) {
      if (err instanceof TooLarge) return { status: 413, json: { error: 'body too large' } };
      if (err instanceof ValidationError) return { status: 400, json: { error: err.message, field: err.field } };
      if (err instanceof HttpError) return { status: err.status, json: { error: err.message } };
      throw err;
    }
  }

  private send(res: ServerResponse, r: ApiResponse): void {
    res.setHeader('Cache-Control', 'no-store');
    if ('bytes' in r) {
      res.writeHead(r.status, { 'Content-Type': r.contentType, 'Content-Length': r.bytes.length });
      res.end(r.bytes);
      return;
    }
    const text = JSON.stringify(r.json);
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }
}
