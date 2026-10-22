import { Bonjour } from 'bonjour-service';

/** The parts of bonjour-service the hub uses (injectable for tests). */
export interface BonjourLike {
  publish(opts: { name: string; type: string; port: number; txt: Record<string, string> }): unknown;
  unpublishAll(cb?: () => void): void;
  destroy(cb?: () => void): void;
}

export interface MdnsAdvertiser {
  stop(): Promise<void>;
}

export interface MdnsOptions {
  factory?: () => BonjourLike;
  logger?: Pick<Console, 'error'>;
}

const STOP_TIMEOUT_MS = 2000;

/** Advertises `_rainmaker._tcp` on `port` with TXT `v=1`. Failures are logged, never thrown. */
export function advertise(port: number, opts: MdnsOptions = {}): MdnsAdvertiser {
  const logger = opts.logger ?? console;
  const onError = (err: unknown) => logger.error('rainmaker: mDNS error', err);
  let bonjour: BonjourLike | null = null;
  try {
    bonjour = opts.factory ? opts.factory() : new Bonjour({}, onError);
    bonjour.publish({ name: 'Rainmaker', type: 'rainmaker', port, txt: { v: '1' } });
  } catch (err) {
    onError(err);
  }
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        const b = bonjour;
        bonjour = null;
        if (!b) return resolve();
        // Goodbye packets can stall on a dead interface; never hold up shutdown for long.
        const timer = setTimeout(() => {
          try {
            b.destroy();
          } catch (err) {
            onError(err);
          }
          resolve();
        }, STOP_TIMEOUT_MS);
        timer.unref();
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        try {
          b.unpublishAll(() => b.destroy(done));
        } catch (err) {
          onError(err);
          done();
        }
      }),
  };
}
