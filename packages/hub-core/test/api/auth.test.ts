import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pairing } from '../../src/api/auth.js';
import { JsonStore } from '../../src/persist/jsonStore.js';
import { json, startHub, stopHubs } from './helpers.js';

const MIN = 60_000;
let dir: string;
let now: number;
const clock = () => now;
const made: Pairing[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rainmaker-auth-'));
  now = 1_700_000_000_000;
});
afterEach(async () => {
  await Promise.allSettled(made.splice(0).map((p) => p.flush()));
  await fs.rm(dir, { recursive: true, force: true });
});

async function pairing(): Promise<Pairing> {
  const p = new Pairing(new JsonStore(dir), clock);
  await p.load();
  made.push(p);
  return p;
}

describe('Pairing', () => {
  it('claim with valid code returns token', async () => {
    const p = await pairing();
    const codes: unknown[] = [];
    p.on('code', (c) => codes.push(c));
    const { code, expiresAt } = p.startPairing();
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBe(now + 5 * MIN);
    expect(codes).toEqual([{ code, expiresAt }]);
    const claimed = p.claim(code, 'Kitchen iPad');
    expect(claimed?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.verify(claimed?.token ?? '')).toBe(true);
    expect(p.list()).toEqual([{ name: 'Kitchen iPad', createdAt: now }]);
    expect(p.claim(code, 'again')).toBeNull(); // single use
  });

  it('code expires after 5 min', async () => {
    const p = await pairing();
    const { code } = p.startPairing();
    now += 5 * MIN;
    expect(p.claim(code, 'late')).toBeNull();
  });

  it('verify false for unknown token', async () => {
    const p = await pairing();
    expect(p.verify('nope')).toBe(false);
    expect(p.verify('')).toBe(false);
    expect(p.verify('A'.repeat(43))).toBe(false);
  });

  it('revoke', async () => {
    const p = await pairing();
    const token = p.claim(p.startPairing().code, 'Phone')?.token ?? '';
    p.revoke(token);
    expect(p.verify(token)).toBe(false);
    expect(p.list()).toEqual([]);
  });

  it('startPairing after expiry issues a new code', async () => {
    const p = await pairing();
    p.startPairing();
    now += 6 * MIN;
    const second = p.startPairing();
    expect(second.expiresAt).toBe(now + 5 * MIN);
    expect(p.claim(second.code, 'Phone')).not.toBeNull();
  });

  it('a new code replaces the live one', async () => {
    const p = await pairing();
    let first = p.startPairing();
    let second = p.startPairing();
    while (second.code === first.code) [first, second] = [second, p.startPairing()];
    expect(p.claim(first.code, 'old')).toBeNull();
    expect(p.claim(second.code, 'new')).not.toBeNull();
  });

  it('five wrong claims invalidate the code', async () => {
    const warn = vi.fn();
    const p = new Pairing(new JsonStore(dir), clock, { warn });
    await p.load();
    made.push(p);
    const { code } = p.startPairing();
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 4; i++) expect(p.claim(wrong, 'guess')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(p.claim(wrong, 'guess')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wrong'));
    expect(p.claim(code, 'owner')).toBeNull();
    const fresh = p.startPairing();
    expect(p.claim(fresh.code, 'owner')).not.toBeNull();
  });

  it('claim rejects a non-digit code without throwing', async () => {
    const p = await pairing();
    const { code } = p.startPairing();
    for (const bad of ['é1234', '１２３４５６', '12345', '1234567', 'abcdef', '', '12 456']) {
      expect(() => p.claim(bad, 'x')).not.toThrow();
      expect(p.claim(bad, 'x')).toBeNull();
    }
    // Malformed input does not count towards the brute-force limit.
    expect(p.claim(code, 'owner')).not.toBeNull();
  });

  it('persists hashed tokens and reloads them', async () => {
    const p = await pairing();
    const token = p.claim(p.startPairing().code, 'Phone')?.token ?? '';
    await p.flush();
    const raw = await fs.readFile(path.join(dir, 'devices.json'), 'utf8');
    expect(raw).not.toContain(token);
    const again = await pairing();
    expect(again.verify(token)).toBe(true);
    expect(again.list()).toHaveLength(1);
  });

  it('trusted (CLI) tokens verify but are not listed as devices', async () => {
    const p = await pairing();
    p.trust('cli-token-value-0123456789');
    expect(p.verify('cli-token-value-0123456789')).toBe(true);
    expect(p.list()).toEqual([]);
  });
});

describe('Pairing through the hub', () => {
  afterEach(async () => {
    vi.useRealTimers();
    await stopHubs();
  });

  it('hub start with no devices issues a code and re-issues after 5 min', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const t = await startHub({ pair: false });
    const logged = () => t.logger.log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('pairing code'));
    expect(logged()).toHaveLength(1);
    expect(logged()[0]).toMatch(/\b\d{6}\b/);
    vi.advanceTimersByTime(5 * MIN);
    expect(logged()).toHaveLength(2);
    t.hub.pairing.claim(t.hub.pairing.startPairing().code, 'Phone');
    vi.advanceTimersByTime(5 * MIN);
    expect(logged()).toHaveLength(2);
  });

  it('pairing/start route returns a claimable code', async () => {
    const t = await startHub();
    const res = await t.api('POST', '/v1/pairing/start');
    expect(res.status).toBe(200);
    const { code, expiresAt } = await json(res);
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
    const pair = await fetch(`${t.url}/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'Second phone' }),
    });
    expect(pair.status).toBe(200);
    const { token } = await json(pair);
    expect(t.hub.pairing.verify(token)).toBe(true);
    expect((await fetch(`${t.url}/v1/pairing/start`, { method: 'POST' })).status).toBe(401);
  });

  it('writes a 0600 cli-token on first start that authenticates', async () => {
    const t = await startHub({ pair: false });
    const file = path.join(t.dir, 'cli-token');
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    const token = (await fs.readFile(file, 'utf8')).trim();
    const res = await fetch(`${t.url}/v1/pairing/start`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(t.hub.pairing.list()).toEqual([]);
  });
});
