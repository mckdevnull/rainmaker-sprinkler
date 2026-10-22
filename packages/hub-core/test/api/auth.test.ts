import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pairing } from '../../src/api/auth.js';
import { JsonStore } from '../../src/persist/jsonStore.js';

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

  it('invalidates the code after repeated wrong guesses', async () => {
    const p = await pairing();
    const { code } = p.startPairing();
    const wrong = code === '000000' ? '000001' : '000000';
    for (let i = 0; i < 10; i++) expect(p.claim(wrong, 'guess')).toBeNull();
    expect(p.claim(code, 'owner')).toBeNull();
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
