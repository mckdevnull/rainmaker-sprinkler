import { plugGet, sleep, turnOnQuietly, type SmartPlug } from './plug.js';

/**
 * Tasmota: one Backlog "Power Off; Delay <n>; Power On" (Delay is in 0.1 s steps), so the plug
 * turns itself back on even if the hub stops or the explicit "on" below never arrives.
 */
export class TasmotaPlug implements SmartPlug {
  constructor(
    private readonly host: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async powerCycle(offMs: number): Promise<void> {
    const tenths = Math.max(1, Math.round(offMs / 100));
    await plugGet(this.fetchImpl, `http://${this.host}/cm?cmnd=Backlog%20Power%20Off%3B%20Delay%20${tenths}%3B%20Power%20On`);
    await sleep(offMs);
    await turnOnQuietly(this.fetchImpl, `http://${this.host}/cm?cmnd=Power%20On`);
  }
}
