import { plugGet, sleep, type SmartPlug } from './plug.js';

/** Shelly Gen1: GET /relay/0?turn=off|on */
export class ShellyPlug implements SmartPlug {
  constructor(
    private readonly host: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async powerCycle(offMs: number): Promise<void> {
    await plugGet(this.fetchImpl, `http://${this.host}/relay/0?turn=off`);
    await sleep(offMs);
    await plugGet(this.fetchImpl, `http://${this.host}/relay/0?turn=on`);
  }
}
