import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSimulator, type SimOptions, type Simulator } from '../src/index.js';

const T0 = 1_700_000_000_000;
const PW = 'opendoor';
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

const running: Simulator[] = [];

async function start(opts: Partial<SimOptions> = {}) {
  const sim = createSimulator({ responseDelayMs: 0, clock: () => T0, ...opts });
  running.push(sim);
  const { baseUrl } = await sim.listen(0);
  const get = async (path: string) => {
    const res = await fetch(baseUrl + path);
    return { status: res.status, text: await res.text() };
  };
  const json = async (path: string) => JSON.parse((await get(path)).text);
  return { sim, baseUrl, get, json };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => s.close()));
});

describe('controller simulator', () => {
  it('rejects wrong password with result 2', async () => {
    const { get } = await start();
    expect((await get('/jc?pw=nope')).text).toBe('{"result":2}');
  });

  it('jo with wrong password returns only fwv', async () => {
    const { get } = await start();
    const res = await get('/jo?pw=nope');
    expect(res.status).toBe(200);
    expect(res.text).toBe('{"fwv":216}');
  });

  it('cp without name renames the program', async () => {
    const { json } = await start();
    const v = encodeURIComponent('[1,127,0,[360,-1,-1,-1],[600,600,600,600,600,600,600,600]]');
    expect(await json(`/cp?pw=${PW}&pid=0&v=${v}&name=Lawn`)).toEqual({ result: 1 });
    expect((await json(`/jp?pw=${PW}`)).pd[0].at(-1)).toBe('Lawn');
    expect(await json(`/cp?pw=${PW}&pid=0&v=${v}`)).toEqual({ result: 1 });
    expect((await json(`/jp?pw=${PW}`)).pd[0].at(-1)).toBe('Program 1');
  });

  it('times are controller-local', async () => {
    const { json } = await start({ tzOffsetSec: -21600 });
    expect((await json(`/jc?pw=${PW}`)).devt).toBe(Math.floor(T0 / 1000) - 21600);
  });

  it('plain mode accepts plaintext, md5 mode accepts md5 hex', async () => {
    const plain = await start({ passwordMode: 'plain', password: 'hunter2' });
    const hashed = await start({ passwordMode: 'md5', password: 'hunter2' });
    expect((await plain.json('/jo?pw=hunter2')).hwv).toBe(22);
    expect(await plain.json(`/jc?pw=${md5('hunter2')}`)).toEqual({ result: 2 });
    expect((await hashed.json(`/jo?pw=${md5('hunter2')}`)).hwv).toBe(22);
    expect(await hashed.json('/jc?pw=hunter2')).toEqual({ result: 2 });
  });

  it('serves one request at a time', async () => {
    const { baseUrl } = await start({ responseDelayMs: 300 });
    const t0 = Date.now();
    const timeOne = async () => {
      await (await fetch(`${baseUrl}/js?pw=${PW}`)).text();
      return Date.now() - t0;
    };
    const [first, second] = (await Promise.all([timeOne(), timeOne()])).sort((x, y) => x - y);
    expect(second! - first!).toBeGreaterThanOrEqual(250);
  });

  it('cm runs a station and queues a second', async () => {
    const { sim, json } = await start();
    await json(`/cm?pw=${PW}&sid=0&en=1&t=60`);
    await json(`/cm?pw=${PW}&sid=1&en=1&t=30`);
    expect(sim.state.stations[0]?.running).toBe(true);
    expect(sim.state.queue).toEqual([{ sid: 1, sec: 30 }]);
    sim.tick(60_000);
    expect(sim.state.stations[0]?.running).toBe(false);
    expect(sim.state.stations[1]?.running).toBe(true);
  });

  it('cm works while disabled', async () => {
    const { sim, json } = await start();
    await json(`/cv?pw=${PW}&en=0`);
    expect(sim.state.enabled).toBe(false);
    expect(await json(`/cm?pw=${PW}&sid=2&en=1&t=10`)).toEqual({ result: 1 });
    expect(sim.state.stations[2]?.running).toBe(true);
  });

  it('rsn stops everything', async () => {
    const { sim, json } = await start();
    await json(`/cm?pw=${PW}&sid=2&en=1&t=10`);
    await json(`/cm?pw=${PW}&sid=3&en=1&t=10`);
    await json(`/cv?pw=${PW}&rsn=1`);
    expect(sim.state.stations.some((s) => s.running)).toBe(false);
    expect(sim.state.queue).toEqual([]);
  });

  it('rd sets rain delay in hours', async () => {
    const { sim, json } = await start({ tzOffsetSec: -21600 });
    await json(`/cv?pw=${PW}&rd=48`);
    const until = T0 + 48 * 3600e3;
    expect(sim.state.rainDelayUntil).toBe(until);
    const jc = await json(`/jc?pw=${PW}`);
    expect(jc.rd).toBe(1);
    expect(jc.rdst).toBe(Math.floor(until / 1000) - 21600);
  });

  it('setOffline refuses connections', async () => {
    const { sim, baseUrl } = await start();
    sim.setOffline(true);
    await expect(fetch(`${baseUrl}/js?pw=${PW}`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  });

  it('cp toggles program enable bit', async () => {
    const { json } = await start();
    const v = encodeURIComponent('[0,127,0,[360,-1,-1,-1],[600,600,600,600,600,600,600,600]]');
    await json(`/cp?pw=${PW}&pid=0&v=${v}&name=Lawn`);
    const flag = (await json(`/jp?pw=${PW}`)).pd[0][0];
    expect(flag & 1).toBe(0);
  });
});
