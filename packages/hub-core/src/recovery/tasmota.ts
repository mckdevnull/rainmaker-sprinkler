import { plugGet, sleep, type SmartPlug } from './plug.js';

/** Tasmota: GET /cm?cmnd=Power%20Off|On */
export class TasmotaPlug implements SmartPlug {
  constructor(
    private readonly host: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async powerCycle(offMs: number): Promise<void> {
    await plugGet(this.fetchImpl, `http://${this.host}/cm?cmnd=Power%20Off`);
    await sleep(offMs);
    await plugGet(this.fetchImpl, `http://${this.host}/cm?cmnd=Power%20On`);
  }
}
