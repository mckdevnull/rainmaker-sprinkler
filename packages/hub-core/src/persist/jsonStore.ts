import { promises as fs } from 'node:fs';
import path from 'node:path';

const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

/** One JSON file per key under `dir`; writes are atomic (tmp + rename) and serialized per key. */
export class JsonStore {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly dir: string) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const file = this.file(key);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw err;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      console.warn(`rainmaker: ignoring corrupt store file ${file}`);
      return fallback;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const file = this.file(key);
    const body = JSON.stringify(value);
    const prev = this.tails.get(key) ?? Promise.resolve();
    const run = prev.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, file);
    });
    // Keep the chain alive after a failure so later writes still run.
    this.tails.set(key, run.catch(() => undefined));
    return run;
  }

  private file(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error(`invalid store key: ${key}`);
    return path.join(this.dir, `${key}.json`);
  }
}
