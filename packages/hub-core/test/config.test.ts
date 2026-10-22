import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, validateConfig } from '../src/config.js';
import { JsonStore } from '../src/persist/jsonStore.js';
import { SettingsStore } from '../src/settings/settingsStore.js';

const minimal = () => ({ controller: { baseUrl: 'http://127.0.0.1:8080', password: 'opendoor' }, dataDir: '/tmp/x' });

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rainmaker-config-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('validateConfig', () => {
  it('applies defaults', () => {
    const cfg = validateConfig(minimal());
    expect(cfg.apiPort).toBe(8787);
    expect(cfg.allowedOrigins).toEqual([]);
    expect(cfg.location).toBeNull();
    expect(cfg.warnings).toEqual({ rainForecast: true, rainThresholdPct: 50, recentRun: true, recentRunWindowMin: 60 });
    expect(cfg.plug).toEqual({ type: 'none' });
    expect(cfg.notifications).toEqual({ offline: true });
    expect(cfg.zoneDefaults).toEqual({});
  });

  it('accepts apiPort 0 and a full config', () => {
    const cfg = validateConfig({
      ...minimal(),
      apiPort: 0,
      allowedOrigins: ['http://192.0.2.10'],
      location: { lat: 45.5, lon: -73.6 },
      warnings: { rainThresholdPct: 70 },
      plug: { type: 'shelly', host: '192.0.2.20' },
      notifications: { offline: false, ntfyTopic: 'my-sprinklers' },
      zoneDefaults: { '2': { voiceSeconds: 300 } },
    });
    expect(cfg.apiPort).toBe(0);
    expect(cfg.warnings.rainThresholdPct).toBe(70);
    expect(cfg.warnings.recentRun).toBe(true);
    expect(cfg.zoneDefaults[2]).toEqual({ voiceSeconds: 300 });
  });

  it.each([
    [{ controller: { baseUrl: 'http://127.0.0.1' }, dataDir: 'd' }, 'controller.password'],
    [{ controller: { baseUrl: 'ftp://x', password: 'p' }, dataDir: 'd' }, 'controller.baseUrl'],
    [{ ...minimal(), apiPort: 70000 }, 'apiPort'],
    [{ ...minimal(), allowedOrigins: ['not a url'] }, 'allowedOrigins[0]'],
    [{ ...minimal(), location: { lat: 100, lon: 0 } }, 'location.lat'],
    [{ ...minimal(), plug: { type: 'shelly', host: 'http://x/y' } }, 'plug.host'],
    [{ ...minimal(), notifications: { apnsKeyPath: '/k.p8' } }, 'notifications.apnsKeyId'],
    [{ ...minimal(), zoneDefaults: { x: { voiceSeconds: 1 } } }, 'zoneDefaults.x'],
    [{ ...minimal(), surprise: 1 }, 'surprise'],
  ])('rejects bad field %#', (input, field) => {
    expect(() => validateConfig(input)).toThrow(new RegExp(`^config: ${field.replace(/[[\].]/g, '\\$&')} `));
  });

  it('never echoes the password in an error', () => {
    expect(() => validateConfig({ controller: { baseUrl: 'nope', password: 'hunter2-secret' }, dataDir: 'd' })).toThrow(
      /^config: controller\.baseUrl/,
    );
    try {
      validateConfig({ controller: { baseUrl: 'http://x', password: 42 }, dataDir: 'd' });
    } catch (err) {
      expect(String(err)).not.toContain('42');
    }
  });
});

describe('loadConfig', () => {
  it('resolves a relative dataDir against the config file directory', async () => {
    const file = path.join(dir, 'hub.config.json');
    await fs.writeFile(file, JSON.stringify({ ...minimal(), dataDir: './data' }));
    expect(loadConfig(file).dataDir).toBe(path.join(dir, 'data'));
  });

  it('accepts the shipped example config', () => {
    const file = path.resolve(import.meta.dirname, '../../../examples/hub.config.json');
    const cfg = loadConfig(file);
    expect(cfg.controller.baseUrl).toBe('http://127.0.0.1:8080');
    expect(cfg.dataDir).toBe(path.resolve(path.dirname(file), 'rainmaker-data'));
  });

  it('reports unreadable and malformed files', async () => {
    expect(() => loadConfig(path.join(dir, 'missing.json'))).toThrow(/^config: /);
    const file = path.join(dir, 'bad.json');
    await fs.writeFile(file, '{ nope');
    expect(() => loadConfig(file)).toThrow(/^config: .*JSON/);
  });
});

describe('SettingsStore', () => {
  const cfg = () => validateConfig({ ...minimal(), dataDir: dir, zoneDefaults: { 1: { voiceSeconds: 120 } } });

  it('defaults from config, persists updates, reloads them', async () => {
    const s = new SettingsStore(new JsonStore(dir), cfg());
    await s.load();
    expect(s.get().zones[1]).toEqual({ voiceSeconds: 120 });
    expect(s.get().notifications.offline).toBe(true);
    await s.update({ notifications: { offline: false }, zones: { 0: { name: 'Lawn', voiceSeconds: 300 } } });
    const again = new SettingsStore(new JsonStore(dir), cfg());
    await again.load();
    expect(again.get().notifications.offline).toBe(false);
    expect(again.get().zones[0]).toEqual({ name: 'Lawn', voiceSeconds: 300 });
    expect(again.get().warnings.rainThresholdPct).toBe(50);
  });

  it('does not let callers mutate the stored settings', async () => {
    const s = new SettingsStore(new JsonStore(dir), cfg());
    await s.load();
    const got = s.get();
    expect(Object.isFrozen(got)).toBe(true);
  });
});
