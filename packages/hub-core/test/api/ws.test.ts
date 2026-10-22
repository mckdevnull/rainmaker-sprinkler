import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { eventually, startHub, stopHubs, type TestHub } from './helpers.js';

interface Client {
  ws: WebSocket;
  messages: { type: string; name?: string; state?: Record<string, unknown>; payload?: unknown }[];
  closed: Promise<number>;
}

const clients: WebSocket[] = [];

async function connect(t: TestHub): Promise<Client> {
  const ws = new WebSocket(`${t.url.replace('http', 'ws')}/v1/ws`);
  clients.push(ws);
  const messages: Client['messages'] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, messages, closed };
}

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  await stopHubs();
});

describe('WebSocket', () => {
  it('receives state after auth message', async () => {
    const t = await startHub();
    const c = await connect(t);
    c.ws.send(JSON.stringify({ type: 'auth', token: t.token }));
    expect(await eventually(() => c.messages.length > 0)).toBe(true);
    const [first] = c.messages;
    expect(first?.type).toBe('state');
    expect(first?.state?.zones).toHaveLength(8);
    expect(first?.state?.capabilities).toMatchObject({ pauseUntil: true });
  });

  it('closes with 4401 and sends nothing on a bad token', async () => {
    const t = await startHub();
    const c = await connect(t);
    c.ws.send(JSON.stringify({ type: 'auth', token: 'wrong' }));
    expect(await c.closed).toBe(4401);
    expect(c.messages).toEqual([]);
  });

  it('closes with 4401 when no auth within 2 s', async () => {
    const t = await startHub();
    const c = await connect(t);
    const t0 = Date.now();
    expect(await c.closed).toBe(4401);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    expect(c.messages).toEqual([]);
  });

  it('receives state within 100 ms of a store change', async () => {
    const t = await startHub();
    const c = await connect(t);
    c.ws.send(JSON.stringify({ type: 'auth', token: t.token }));
    await eventually(() => c.messages.length > 0);
    const enabled = t.hub.store.get().enabled;
    const t0 = Date.now();
    t.hub.store.patch({ enabled: !enabled });
    expect(await eventually(() => c.messages.some((m) => m.type === 'state' && m.state?.enabled === !enabled), 100)).toBe(
      true,
    );
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('receives offline event', async () => {
    const t = await startHub();
    const c = await connect(t);
    c.ws.send(JSON.stringify({ type: 'auth', token: t.token }));
    await eventually(() => c.messages.length > 0);
    t.hub.store.patch({ online: false });
    expect(await eventually(() => c.messages.some((m) => m.type === 'event' && m.name === 'offline'))).toBe(true);
  });

  it('revoking a device closes its WebSocket with 4401', async () => {
    const t = await startHub();
    const other = t.hub.pairing.claim(t.hub.pairing.startPairing().code, 'other')?.token ?? '';
    const victim = await connect(t);
    victim.ws.send(JSON.stringify({ type: 'auth', token: t.token }));
    const bystander = await connect(t);
    bystander.ws.send(JSON.stringify({ type: 'auth', token: other }));
    await eventually(() => victim.messages.length > 0 && bystander.messages.length > 0);
    const res = await fetch(`${t.url}/v1/devices/${t.token}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${other}` },
    });
    expect(res.status).toBe(200);
    expect(await victim.closed).toBe(4401);
    expect(bystander.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('pushes command events and rejects other paths', async () => {
    const t = await startHub();
    const c = await connect(t);
    c.ws.send(JSON.stringify({ type: 'auth', token: t.token }));
    await eventually(() => c.messages.length > 0);
    await t.api('POST', '/v1/zones/0/run', { seconds: 30, source: 'homekit' });
    const cmd = c.messages.find((m) => m.type === 'event' && m.name === 'command');
    expect(cmd?.payload).toMatchObject({ type: 'runZone', id: 0, seconds: 30, source: 'homekit' });
    const other = new WebSocket(`${t.url.replace('http', 'ws')}/v1/other`);
    clients.push(other);
    await expect(
      new Promise((resolve, reject) => {
        other.once('open', resolve);
        other.once('error', reject);
      }),
    ).rejects.toThrow(/404/);
  });
});
