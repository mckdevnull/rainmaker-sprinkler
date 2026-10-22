#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type HubConfig } from '../config.js';
import { createHub } from '../hub.js';

const USAGE = `usage:
  rainmaker-hub --config <path>        start the hub
  rainmaker-hub pair --config <path>   print a pairing code for a new device`;

interface Args {
  command: 'run' | 'pair';
  config: string;
}

function parseArgs(argv: readonly string[]): Args {
  let command: Args['command'] = 'run';
  let config: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'pair' && i === 0) command = 'pair';
    else if (a === '--config' || a === '-c') config = argv[++i];
    else if (a?.startsWith('--config=')) config = a.slice('--config='.length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!config) throw new Error('--config <path> is required');
  return { command, config };
}

async function run(config: HubConfig): Promise<void> {
  const hub = createHub(config);
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Rainmaker hub stopping (${signal})`);
    hub.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error('rainmaker: error while stopping', err);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  await hub.start(); // logs "Rainmaker hub listening on <port>" and any pairing code
}

async function pair(config: HubConfig): Promise<void> {
  if (config.apiPort === 0) throw new Error('pair needs a fixed apiPort in the config (not 0)');
  const token = (await readFile(path.join(config.dataDir, 'cli-token'), 'utf8')).trim();
  const res = await fetch(`http://127.0.0.1:${config.apiPort}/v1/pairing/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`the hub answered HTTP ${res.status}`);
  const { code, expiresAt } = (await res.json()) as { code: string; expiresAt: number };
  console.log(`Pairing code: ${code} (valid until ${new Date(expiresAt).toLocaleTimeString()})`);
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  const config = loadConfig(args.config);
  await (args.command === 'pair' ? pair(config) : run(config));
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`rainmaker-hub: ${msg}`);
  process.exit(1);
});
