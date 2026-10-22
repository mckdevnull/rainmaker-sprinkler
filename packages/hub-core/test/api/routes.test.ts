import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { json, PASSWORD, rainForecastFetch, startHub, stopHubs } from './helpers.js';

afterEach(stopHubs);

const HOUR = 3600e3;

describe('routes', () => {
  it('401 without token', async () => {
    const t = await startHub();
    const res = await fetch(`${t.url}/v1/state`);
    expect(res.status).toBe(401);
    const bad = await fetch(`${t.url}/v1/state`, { headers: { Authorization: 'Bearer not-a-token' } });
    expect(bad.status).toBe(401);
  });

  it('GET /v1/state includes zones and capabilities', async () => {
    const t = await startHub({ config: { zoneDefaults: { 1: { voiceSeconds: 120 } } } });
    await t.hub.settings.update({ zones: { 0: { name: 'Front lawn', voiceSeconds: 300 } } });
    const res = await t.api('GET', '/v1/state');
    expect(res.status).toBe(200);
    const s = await json(res);
    expect(s.online).toBe(true);
    expect(s.zones).toHaveLength(8);
    expect(s.zones[0]).toMatchObject({ id: 0, name: 'Front lawn', voiceSeconds: 300, photo: false, lastRunAt: null });
    expect(s.zones[1]).toMatchObject({ name: 'S02', voiceSeconds: 120 });
    expect(s.zones[2]).toMatchObject({ voiceSeconds: 600 });
    expect(s.capabilities).toEqual({ mqtt: false, pauseUntil: true, maxRainDelayHours: 32767, firmware: 216 });
    expect(s.pause).toEqual({ all: null, schedules: {} });
    expect(s.forecast).toBeNull();
  });

  it('run returns 409 with warnings for source app when rain forecast', async () => {
    const t = await startHub({ config: { location: { lat: 45, lon: -73 } }, deps: { fetchImpl: rainForecastFetch(80) } });
    const res = await t.api('POST', '/v1/zones/2/run', { seconds: 60, source: 'app' });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ warnings: [{ kind: 'rain', probabilityPct: 80 }] });
    expect(t.sim.state.stations[2]?.running).toBe(false);
  });

  it('run with force runs', async () => {
    const t = await startHub({ config: { location: { lat: 45, lon: -73 } }, deps: { fetchImpl: rainForecastFetch(80) } });
    const res = await t.api('POST', '/v1/zones/2/run', { seconds: 60, source: 'app', force: true });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true });
    expect(t.sim.state.stations[2]?.running).toBe(true);
  });

  it('run with source alexa ignores warnings', async () => {
    const t = await startHub({ config: { location: { lat: 45, lon: -73 } }, deps: { fetchImpl: rainForecastFetch(80) } });
    const res = await t.api('POST', '/v1/zones/3/run', { seconds: 60, source: 'alexa' });
    expect(res.status).toBe(200);
    expect(t.sim.state.stations[3]?.running).toBe(true);
  });

  it('pause then state shows rainDelayUntil', async () => {
    const t = await startHub();
    const until = Date.now() + 5 * HOUR;
    const res = await t.api('POST', '/v1/pause', { until });
    expect(res.status).toBe(200);
    const s = await json(await t.api('GET', '/v1/state'));
    expect(s.rainDelayUntil).toBeGreaterThanOrEqual(until);
    expect(s.pause.all).toMatchObject({ owner: 'user', until });
    expect((await t.api('POST', '/v1/resume')).status).toBe(200);
    expect((await json(await t.api('GET', '/v1/state'))).rainDelayUntil).toBeNull();
  });

  it('PUT schedule updates the simulator program', async () => {
    const t = await startHub();
    const [s0] = await json(await t.api('GET', '/v1/schedules'));
    const res = await t.api('PUT', '/v1/schedules/0', {
      ...s0,
      pausedUntil: undefined,
      name: 'Evening',
      weatherAdjust: true,
      days: [true, true, true, true, true, false, false],
      startMinutes: [1200],
      zoneMinutes: { 0: 10, 2: 5 },
    });
    expect(res.status).toBe(200);
    const p = t.sim.state.programs[0];
    expect(p?.name).toBe('Evening');
    expect(p?.flag).toBe(3);
    expect(p?.days0).toBe(0b0011111);
    expect(p?.starts).toEqual([1200, -1, -1, -1]);
    expect(p?.durs).toEqual([600, 0, 300, 0, 0, 0, 0, 0]);
    const [after] = await json(await t.api('GET', '/v1/schedules'));
    expect(after).toMatchObject({ name: 'Evening', zoneMinutes: { 0: 10, 2: 5 } });
  });

  it('PUT schedule rejects read-only and out-of-range fields', async () => {
    const t = await startHub();
    const [s0] = await json(await t.api('GET', '/v1/schedules'));
    const kind = await t.api('PUT', '/v1/schedules/0', { ...s0, kind: 'interval' });
    expect(kind.status).toBe(400);
    expect(await json(kind)).toMatchObject({ field: 'kind' });
    const zone = await t.api('PUT', '/v1/schedules/0', { ...s0, zoneMinutes: { 8: 5 } });
    expect(zone.status).toBe(400);
    expect(await json(zone)).toMatchObject({ field: 'zoneMinutes.8' });
    expect((await t.api('PUT', '/v1/schedules/1', s0)).status).toBe(404);
  });

  it('state response never contains the controller password or its md5', async () => {
    const t = await startHub();
    const md5 = createHash('md5').update(PASSWORD).digest('hex');
    for (const p of ['/v1/state', '/v1/schedules', '/v1/settings', '/v1/devices']) {
      const text = await (await t.api('GET', p)).text();
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(md5);
    }
  });

  it('CORS allows controller origin for POST', async () => {
    const t = await startHub();
    const origin = new URL(t.hub.config.controller.baseUrl).origin;
    const pre = await fetch(`${t.url}/v1/stop-all`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(origin);
    const res = await t.api('POST', '/v1/stop-all', {}, { Origin: origin });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    const evil = await t.api('POST', '/v1/stop-all', {}, { Origin: 'http://evil.example' });
    expect(evil.status).toBe(403);
    const get = await t.api('GET', '/v1/state', undefined, { Origin: 'http://anything.example' });
    expect(get.status).toBe(200);
    expect(get.headers.get('access-control-allow-origin')).toBe('http://anything.example');
  });

  it('loadConfig names a missing field', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rainmaker-cfg-'));
    try {
      const file = path.join(dir, 'hub.json');
      await fs.writeFile(file, JSON.stringify({ controller: { baseUrl: 'http://127.0.0.1:8080' }, dataDir: '.' }));
      expect(() => loadConfig(file)).toThrow('config: controller.password is required');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('routes: validation and the rest of the surface', () => {
  it('validates ids, bodies and sources', async () => {
    const t = await startHub();
    expect((await t.api('POST', '/v1/zones/8/run', { seconds: 60, source: 'app' })).status).toBe(404);
    expect((await t.api('POST', '/v1/zones/abc/run', { seconds: 60, source: 'app' })).status).toBe(404);
    const noSecs = await t.api('POST', '/v1/zones/0/run', { source: 'app' });
    expect(noSecs.status).toBe(400);
    expect(await json(noSecs)).toMatchObject({ field: 'seconds' });
    const src = await t.api('POST', '/v1/zones/0/run', { seconds: 60, source: 'telegram' });
    expect(await json(src)).toMatchObject({ field: 'source' });
    const bad = await fetch(`${t.url}/v1/stop-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
      body: '{nope',
    });
    expect(bad.status).toBe(400);
    const big = await t.api('POST', '/v1/system', { enabled: true, pad: 'x'.repeat(70_000) });
    expect(big.status).toBe(413);
    expect((await t.api('GET', '/v1/nothing')).status).toBe(404);
  });

  it('stops zones, stops all and toggles the system', async () => {
    const t = await startHub();
    await t.api('POST', '/v1/zones/1/run', { seconds: 60, source: 'homekit' });
    expect((await t.api('POST', '/v1/zones/1/stop', { source: 'homekit' })).status).toBe(200);
    expect(t.sim.state.stations[1]?.running).toBe(false);
    expect((await t.api('POST', '/v1/system', { enabled: false })).status).toBe(200);
    expect(t.sim.state.enabled).toBe(false);
    expect(await json(await t.api('POST', '/v1/system', { enabled: 'no' }))).toMatchObject({ field: 'enabled' });
  });

  it('pauses and resumes a schedule', async () => {
    const t = await startHub();
    const until = Date.now() + 2 * HOUR;
    expect((await t.api('POST', '/v1/schedules/0/pause', { until })).status).toBe(200);
    expect((t.sim.state.programs[0]?.flag ?? -1) & 1).toBe(0);
    expect((await json(await t.api('GET', '/v1/schedules')))[0].pausedUntil).toBe(until);
    expect((await t.api('POST', '/v1/schedules/0/resume')).status).toBe(200);
    expect((t.sim.state.programs[0]?.flag ?? -1) & 1).toBe(1);
  });

  it('zoneDefaults still apply after another zone\'s settings are saved', async () => {
    const t = await startHub({ config: { zoneDefaults: { 1: { voiceSeconds: 120 } } } });
    expect((await t.api('PUT', '/v1/settings', { zones: { 2: { name: 'Roses' } } })).status).toBe(200);
    const s = await json(await t.api('GET', '/v1/state'));
    expect(s.zones[1].voiceSeconds).toBe(120);
    expect(s.zones[2]).toMatchObject({ name: 'Roses', voiceSeconds: 600 });
    expect(t.hub.settings.voiceSeconds(1)).toBe(120);
  });

  it('reads and writes settings', async () => {
    const t = await startHub();
    const put = await t.api('PUT', '/v1/settings', {
      warnings: { rainThresholdPct: 70 },
      zones: { 2: { name: 'Roses', order: 1 } },
      notifications: { offline: false },
    });
    expect(put.status).toBe(200);
    const s = await json(await t.api('GET', '/v1/settings'));
    expect(s.warnings).toMatchObject({ rainThresholdPct: 70, rainForecast: true });
    expect(s.zones[2]).toEqual({ name: 'Roses', order: 1, voiceSeconds: 600 });
    expect(s.notifications.offline).toBe(false);
    const bad = await t.api('PUT', '/v1/settings', { zones: { 99: { voiceSeconds: 10 } } });
    expect(await json(bad)).toMatchObject({ field: 'zones.99' });
  });

  it('stores and serves zone photos', async () => {
    const t = await startHub();
    expect((await t.api('GET', '/v1/zones/0/photo')).status).toBe(404);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
    const put = await fetch(`${t.url}/v1/zones/0/photo`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'image/jpeg' },
      body: jpeg,
    });
    expect(put.status).toBe(200);
    const got = await t.api('GET', '/v1/zones/0/photo');
    expect(got.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await got.arrayBuffer())).toEqual(jpeg);
    expect((await json(await t.api('GET', '/v1/state'))).zones[0].photo).toBe(true);
    const notJpeg = await fetch(`${t.url}/v1/zones/0/photo`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'image/png' },
      body: jpeg,
    });
    expect(notJpeg.status).toBe(415);
  });

  it('pairs, lists, registers push and revokes devices', async () => {
    const t = await startHub();
    const { code } = await json(await t.api('POST', '/v1/pairing/start'));
    const wrong = await fetch(`${t.url}/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code === '000000' ? '000001' : '000000', deviceName: 'x' }),
    });
    expect(wrong.status).toBe(403);
    const paired = await fetch(`${t.url}/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'Phone' }),
    });
    const { token, id } = await json(paired);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    const devices = await json(await t.api('GET', '/v1/devices'));
    expect(devices.map((d: { name: string }) => d.name)).toEqual(['test device', 'Phone']);
    expect(devices[1]).toEqual({ id, name: 'Phone', createdAt: expect.any(Number) });
    expect(JSON.stringify(devices)).not.toContain(token);
    const push = await t.api('PUT', `/v1/devices/${id}/push`, { apnsToken: 'ab'.repeat(32) });
    expect(push.status).toBe(200);
    expect((await t.api('PUT', `/v1/devices/${token}/push`, { apnsToken: 'ab'.repeat(32) })).status).toBe(404);
    expect((await t.api('DELETE', `/v1/devices/${token}`)).status).toBe(404); // raw tokens are not ids
    expect((await t.api('DELETE', `/v1/devices/${id}`)).status).toBe(200);
    expect((await fetch(`${t.url}/v1/state`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await t.api('DELETE', `/v1/devices/${id}`)).status).toBe(404);
  });
});
