import { afterEach, describe, expect, it } from 'vitest';
import { Characteristic as C, HapStatusError, Service as S } from './fakes.js';
import { toHubConfig } from '../src/hubConfig.js';
import { cleanup, launch, shutdown } from './harness.js';

afterEach(cleanup);

describe('RainmakerPlatform', () => {
  it('with a bad config, cached accessories stay but answer every write with an error', async () => {
    const first = await launch();
    const cached = first.api.registered;
    await shutdown(first);

    const r = await launch({ dir: first.dir, cached, config: { controller: { baseUrl: 'not a url', password: 'x' } } });
    expect(r.platform.hub).toBeNull();
    expect(r.log.error).toHaveBeenCalledWith(expect.stringContaining('controller.baseUrl'));
    expect(r.api.unregisterPlatformAccessories).not.toHaveBeenCalled();
    const on = r.api.accessory('Sprinkler Pause').getService(S.Switch)!.getCharacteristic(C.On);
    await expect(on.set(true)).rejects.toBeInstanceOf(HapStatusError);
    await expect(on.get()).rejects.toBeInstanceOf(HapStatusError);
  });

  it('reads the Homebridge platform block as a hub config', () => {
    const cfg = toHubConfig(
      {
        platform: 'Rainmaker',
        name: 'Rainmaker',
        _bridge: { username: '0E:00:00:00:00:01', port: 51830 },
        controller: { baseUrl: 'http://192.0.2.10', password: 'pw' },
        location: {},
        zoneDefaults: [{ zone: 2, voiceSeconds: 300 }],
      },
      '/homebridge',
    );
    expect(cfg.dataDir).toBe('/homebridge/rainmaker');
    expect(cfg.location).toBeNull();
    expect(cfg.zoneDefaults).toEqual({ 2: { voiceSeconds: 300 } });
    expect(() => toHubConfig({ controller: cfg.controller, zoneDefaults: [{ zone: 1, voiceSeconds: 0 }] }, '/hb')).toThrow(
      /zoneDefaults\.1\.voiceSeconds/,
    );
  });
});
