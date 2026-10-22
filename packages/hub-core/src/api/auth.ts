import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { JsonStore } from '../persist/jsonStore.js';

export const PAIRING_CODE_TTL_MS = 5 * 60_000;
const STORE_KEY = 'devices';
const MAX_FAILED_CLAIMS = 5;
const CODE_PATTERN = /^\d{6}$/;

interface StoredDevice {
  name: string;
  createdAt: number;
  /** SHA-256 of the bearer token, hex; the token itself is never written to disk. */
  hash: string;
}
interface LiveCode {
  code: string;
  expiresAt: number;
  failures: number;
}

/** 32 random bytes, base64url. */
export const newToken = (): string => randomBytes(32).toString('base64url');
const digest = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/**
 * Device pairing and bearer-token auth. Paired devices are persisted under the JsonStore key
 * 'devices'. Emits 'code' ({code, expiresAt}) whenever a code is issued, and 'revoked' (the
 * device id, see `deviceId`) when a device is revoked.
 */
export class Pairing extends EventEmitter {
  private devices: readonly StoredDevice[] = [];
  private trusted: readonly Buffer[] = [];
  private live: LiveCode | null = null;
  /** Codes that expired unclaimed or were locked out by wrong guesses. */
  private burned = 0;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly persist: JsonStore,
    private readonly clock: () => number = Date.now,
    private readonly logger: Pick<Console, 'warn'> = console,
  ) {
    super();
  }

  async load(): Promise<void> {
    const saved = await this.persist.get<StoredDevice[]>(STORE_KEY, []);
    this.devices = Array.isArray(saved) ? saved.filter((d) => typeof d?.hash === 'string' && d.hash.length === 64) : [];
  }

  /** Six digits, valid five minutes; replaces any live code. */
  startPairing(): { code: string; expiresAt: number } {
    if (this.liveExpired()) this.burned += 1;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = this.clock() + PAIRING_CODE_TTL_MS;
    this.live = { code, expiresAt, failures: 0 };
    this.emit('code', { code, expiresAt });
    return { code, expiresAt };
  }

  /**
   * Single use. Anything but six ASCII digits is rejected before comparing (and does not count
   * as a guess); five wrong guesses burn the live code until the next `startPairing()`.
   */
  claim(code: string, deviceName: string): { token: string } | null {
    if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return null;
    const live = this.live;
    if (!live) return null;
    if (this.liveExpired()) {
      this.burned += 1;
      this.live = null;
      return null;
    }
    // Both are six ASCII digits here, so the buffers are six bytes each.
    if (!timingSafeEqual(Buffer.from(code, 'ascii'), Buffer.from(live.code, 'ascii'))) {
      live.failures += 1;
      if (live.failures >= MAX_FAILED_CLAIMS) {
        this.live = null;
        this.burned += 1;
        this.logger.warn(`rainmaker: ${MAX_FAILED_CLAIMS} wrong pairing codes; start pairing again for a new code`);
      }
      return null;
    }
    this.live = null;
    const token = newToken();
    const device: StoredDevice = { name: deviceName, createdAt: this.clock(), hash: digest(token).toString('hex') };
    this.save([...this.devices, device]);
    return { token };
  }

  verify(token: string): boolean {
    return this.find(token) !== null || this.matchesTrusted(token);
  }

  revoke(token: string): void {
    const found = this.find(token);
    if (!found) return;
    this.save(this.devices.filter((d) => d !== found));
    this.emit('revoked', found.hash);
  }

  /** How many codes expired unclaimed or were locked out (the live code counts once expired). */
  burnedCodes(): number {
    return this.burned + (this.liveExpired() ? 1 : 0);
  }

  list(): { name: string; createdAt: number }[] {
    return this.devices.map(({ name, createdAt }) => ({ name, createdAt }));
  }

  /** A stable, non-secret id for a paired device's token (its hash); null when unknown. */
  deviceId(token: string): string | null {
    return this.find(token)?.hash ?? null;
  }

  /** Accept an extra token (the CLI's) that is not a paired device. Kept in memory only. */
  trust(token: string): void {
    this.trusted = [...this.trusted, digest(token)];
  }

  /** Resolves once every device change so far is on disk; rejects if the last write failed. */
  flush(): Promise<void> {
    return this.saving;
  }

  private liveExpired(): boolean {
    return this.live !== null && this.clock() >= this.live.expiresAt;
  }

  private find(token: string): StoredDevice | null {
    const h = digest(token);
    let hit: StoredDevice | null = null;
    // Compare against every entry so timing does not reveal which one matched.
    for (const d of this.devices) if (timingSafeEqual(Buffer.from(d.hash, 'hex'), h)) hit = d;
    return hit;
  }

  private matchesTrusted(token: string): boolean {
    const h = digest(token);
    return this.trusted.reduce((hit, t) => timingSafeEqual(t, h) || hit, false);
  }

  private save(next: readonly StoredDevice[]): void {
    this.devices = next;
    const write = this.saving.catch(() => undefined).then(() => this.persist.set(STORE_KEY, next));
    write.catch((err: unknown) => console.error('rainmaker: could not save paired devices', err));
    this.saving = write;
  }
}
