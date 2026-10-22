import { plugGet, sleep, turnOnQuietly, type SmartPlug } from './plug.js';

/**
 * Shelly Gen1: GET /relay/0?turn=off&timer=<s> makes the plug switch itself back on after <s>
 * seconds, even if the hub stops or the explicit "on" below never arrives.
 */
export class ShellyPlug implements SmartPlug {
  constructor(
    private readonly host: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async powerCycle(offMs: number): Promise<void> {
    const offSec = Math.max(1, Math.round(offMs / 1000));
    await plugGet(this.fetchImpl, `http://${this.host}/relay/0?turn=off&timer=${offSec}`);
    await sleep(offMs);
    await turnOnQuietly(this.fetchImpl, `http://${this.host}/relay/0?turn=on`);
  }
}
