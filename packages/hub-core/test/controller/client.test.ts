import { createHash } from 'node:crypto';
import { createSimulator, type PasswordMode, type Simulator } from '@rainmaker/controller-sim';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControllerClient } from '../../src/controller/client.js';
import { ControllerUnauthorized, ControllerUnreachable } from '../../src/controller/errors.js';

const PASSWORD = 'opendoor';
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const NOW = 1_700_000_000_000;

let sim: Simulator | undefined;

async function setup(
  simOpts: Parameters<typeof createSimulator>[0] = {},
  cfg: { timeoutMs?: number; password?: string } = {},
) {
  sim = createSimulator({ password: PASSWORD, responseDelayMs: 5, clock: () => NOW, ...simOpts });
  const { baseUrl } = await sim.listen(0);
  const client = new ControllerClient({ baseUrl, password: cfg.password ?? PASSWORD, timeoutMs: cfg.timeoutMs });
  return { sim, client, baseUrl };
}

afterEach(async () => {
  vi.useRealTimers();
  await sim?.close();
  sim = undefined;
});

describe('ControllerClient', () => {
  it('negotiates md5 then plaintext on a 2.1.6 controller', async () => {
    const { sim, client } = await setup({ passwordMode: 'plain' });
    await expect(client.getStatus()).resolves.toMatchObject({ nbrd: 1 });
    expect(client.passwordMode).toBe('plain');
    expect(sim.requestCount).toBe(2);
  });

  it('uses md5 directly on a 2.1.7 controller', async () => {
    const { sim, client } = await setup({ passwordMode: 'md5' });
    await client.getStatus();
    expect(sim.requestCount).toBe(1);
    expect(client.passwordMode).toBe('md5');
  });

  it('getOptions treats a fwv-only body as unauthorized', async () => {
    for (const mode of ['plain', 'md5'] as PasswordMode[]) {
      const { client } = await setup({ passwordMode: mode }, { password: 'wrong' });
      const result = await client.getOptions().then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.e).toBeInstanceOf(ControllerUnauthorized);
      await sim?.close();
    }
  });

  it('getOptions first negotiates on jc', async () => {
    const { sim, client } = await setup({ passwordMode: 'md5' });
    const paths: string[] = [];
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      paths.push(new URL(String(input)).pathname);
      return realFetch(input, init);
    });
    await expect(client.getOptions()).resolves.toMatchObject({ fwv: 216 });
    spy.mockRestore();
    expect(paths).toEqual(['/jc', '/jo']);
    expect(sim.requestCount).toBe(2);
  });

  it('setProgram always sends name and preserves flag bits', async () => {
    const { sim, client } = await setup({ passwordMode: 'md5' });
    await client.setProgram(0, [0b110, 127, 0, [360, -1, -1, -1], [300, 300], 'Lawn']);
    expect(sim.state.programs[0]).toMatchObject({ flag: 0b110, name: 'Lawn', durs: [300, 300] });
  });

  it('deadline bounds a call even when a poll is in flight', async () => {
    const { client } = await setup({ passwordMode: 'md5', responseDelayMs: 2000 });
    const poll = client.getStatus().catch((e: unknown) => e);
    const t0 = Date.now();
    await expect(client.runStation(0, 60, { deadlineMs: 1000 })).rejects.toBeInstanceOf(ControllerUnreachable);
    expect(Date.now() - t0).toBeLessThan(1100);
    await poll;
  });

  it('throws ControllerUnauthorized after one re-negotiation when the password changes', async () => {
    const { sim, client } = await setup({ passwordMode: 'plain' });
    await client.getStatus();
    sim.setPassword('changed');
    const before = sim.requestCount;
    await expect(client.getStatus()).rejects.toBeInstanceOf(ControllerUnauthorized);
    expect(sim.requestCount).toBe(before + 2);

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const settled = sim.requestCount;
    await expect(client.getStatus()).rejects.toBeInstanceOf(ControllerUnauthorized);
    vi.advanceTimersByTime(29_000);
    await expect(client.getStatus()).rejects.toBeInstanceOf(ControllerUnauthorized);
    expect(sim.requestCount).toBe(settled);
    vi.advanceTimersByTime(2_000);
    await expect(client.getStatus()).rejects.toBeInstanceOf(ControllerUnauthorized);
    expect(sim.requestCount).toBe(settled + 2);
  });

  it('times out and throws ControllerUnreachable', async () => {
    const { client } = await setup({ responseDelayMs: 1000 }, { timeoutMs: 200 });
    const t0 = Date.now();
    await expect(client.getStatus()).rejects.toBeInstanceOf(ControllerUnreachable);
    expect(Date.now() - t0).toBeLessThan(300);
  });

  it('throws ControllerUnreachable when offline', async () => {
    const { sim, client } = await setup({ passwordMode: 'md5' });
    sim.setOffline(true);
    await expect(client.getStatus()).rejects.toBeInstanceOf(ControllerUnreachable);
  });

  it('runStation sends cm with en=1 and t', async () => {
    const { sim, client } = await setup({ passwordMode: 'md5' });
    await client.runStation(2, 90);
    expect(sim.state.stations[2]).toMatchObject({ running: true, remainingSec: 90 });
  });

  it('setRainDelayHours caps at 32767', async () => {
    const { sim, client } = await setup({ passwordMode: 'md5' });
    await client.setRainDelayHours(50_000);
    expect(sim.state.rainDelayUntil).toBe(NOW + 32767 * 3600e3);
  });

  it('never includes the password in error messages', async () => {
    const { client } = await setup({ responseDelayMs: 500 }, { timeoutMs: 50 });
    const err = await client.getStatus().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControllerUnreachable);
    const message = (err as Error).message;
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain(md5(PASSWORD));
    expect(message).not.toContain('pw=');
  });

  it('getLog resolves null when the controller has no log', async () => {
    const { client } = await setup({ passwordMode: 'md5', hasLog: false });
    await expect(client.getLog(0, 86400)).resolves.toBeNull();
  });
});
