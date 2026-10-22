import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as http2Connect, type ClientHttp2Session } from 'node:http2';
import type { NotificationConfig } from '../config.js';
import type { JsonStore } from '../persist/jsonStore.js';

export type NotifyKind = 'offline' | 'online' | 'recovery-exhausted';
export type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

export interface NotifierDeps {
  fetchImpl?: typeof fetch;
  /** Opens an HTTP/2 session to an authority such as https://api.push.apple.com. */
  connect?: (authority: string) => ClientHttp2Session;
  logger?: Logger;
  clock?: () => number;
}

const STORE_KEY = 'pushTokens';
const APNS_HOST = 'https://api.push.apple.com';
const JWT_MAX_AGE_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const TITLE = 'Rainmaker';

type PushTokens = Record<string, string>;

/**
 * Sends owner notifications over the first configured channel: APNs (all four APNs fields set),
 * else ntfy, else Pushover, else the log. `notify` never throws; failures are logged.
 */
export class Notifier {
  private readonly fetchImpl: typeof fetch;
  private readonly connect: (authority: string) => ClientHttp2Session;
  private readonly logger: Logger;
  private readonly clock: () => number;
  private jwt: { token: string; at: number } | null = null;
  private key: KeyObject | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cfg: NotificationConfig,
    private readonly persist: JsonStore,
    deps: NotifierDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.connect = deps.connect ?? ((authority) => http2Connect(authority));
    this.logger = deps.logger ?? console;
    this.clock = deps.clock ?? Date.now;
  }

  async notify(kind: NotifyKind, text: string): Promise<void> {
    try {
      if (this.cfg.apnsKeyPath && this.cfg.apnsKeyId && this.cfg.apnsTeamId && this.cfg.apnsBundleId) {
        await this.sendApns(text);
      } else if (this.cfg.ntfyTopic) {
        await this.post(`https://ntfy.sh/${this.cfg.ntfyTopic}`, { Title: TITLE }, text, 'ntfy');
      } else if (this.cfg.pushoverToken && this.cfg.pushoverUser) {
        const form = new URLSearchParams({
          token: this.cfg.pushoverToken,
          user: this.cfg.pushoverUser,
          title: TITLE,
          message: text,
        });
        const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        await this.post('https://api.pushover.net/1/messages.json', headers, form.toString(), 'Pushover');
      } else {
        this.logger.log(`rainmaker notification (${kind}): ${text}`);
      }
    } catch (err) {
      this.logger.error(`rainmaker: ${kind} notification failed: ${(err as Error).message ?? err}`);
    }
  }

  registerPush(deviceToken: string, apnsToken: string): Promise<void> {
    return this.updateTokens((t) => ({ ...t, [deviceToken]: apnsToken }));
  }

  unregisterPush(deviceToken: string): Promise<void> {
    return this.updateTokens((t) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== deviceToken)));
  }

  private updateTokens(change: (t: PushTokens) => PushTokens): Promise<void> {
    const run = this.chain.then(async () => {
      const current = await this.persist.get<PushTokens>(STORE_KEY, {});
      await this.persist.set(STORE_KEY, change(current));
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Errors name the service and status only: URLs and bodies may hold secrets. */
  private async post(url: string, headers: Record<string, string>, body: string, service: string): Promise<void> {
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${service} answered HTTP ${res.status}`);
  }

  // ---- APNs --------------------------------------------------------------------------------

  private async sendApns(text: string): Promise<void> {
    const tokens = [...new Set(Object.values(await this.persist.get<PushTokens>(STORE_KEY, {})))];
    if (tokens.length === 0) {
      this.logger.log(`rainmaker notification (no registered devices): ${text}`);
      return;
    }
    const jwt = this.apnsJwt();
    const body = JSON.stringify({ aps: { alert: { title: TITLE, body: text }, sound: 'default' } });
    const session = this.connect(APNS_HOST);
    session.on('error', (err) => this.logger.error(`rainmaker: APNs connection error: ${err.message}`));
    try {
      await Promise.all(tokens.map((t) => this.pushOne(session, jwt, t, body)));
    } finally {
      session.close();
    }
  }

  private pushOne(session: ClientHttp2Session, jwt: string, deviceToken: string, body: string): Promise<void> {
    return new Promise((resolve) => {
      const req = session.request({
        ':method': 'POST',
        ':path': `/3/device/${encodeURIComponent(deviceToken)}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': this.cfg.apnsBundleId ?? '',
        'apns-push-type': 'alert',
        'content-type': 'application/json',
      });
      let status = 0;
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.close());
      req.on('response', (h) => {
        status = Number(h[':status'] ?? 0);
      });
      req.on('data', () => undefined);
      req.on('end', () => {
        if (status !== 200) this.logger.error(`rainmaker: APNs answered HTTP ${status || 'none'}`);
        resolve();
      });
      req.on('error', (err) => {
        this.logger.error(`rainmaker: APNs request failed: ${err.message}`);
        resolve();
      });
      req.end(body);
    });
  }

  /** ES256 provider token, reused for up to 50 minutes (Apple allows 60). */
  private apnsJwt(): string {
    const now = this.clock();
    if (this.jwt && now - this.jwt.at < JWT_MAX_AGE_MS) return this.jwt.token;
    this.key ??= createPrivateKey(readFileSync(this.cfg.apnsKeyPath ?? '', 'utf8'));
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'ES256', kid: this.cfg.apnsKeyId })}.${enc({ iss: this.cfg.apnsTeamId, iat: Math.floor(now / 1000) })}`;
    const signature = sign('sha256', Buffer.from(unsigned), { key: this.key, dsaEncoding: 'ieee-p1363' });
    const token = `${unsigned}.${signature.toString('base64url')}`;
    this.jwt = { token, at: now };
    return token;
  }
}
