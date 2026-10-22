import { promises as fs } from 'node:fs';
import { optional, reqBool, reqInt, reqObject, MAX_RUN_SECONDS, ValidationError } from '../../validate.js';
import { evaluateWarnings } from '../../warnings/warnings.js';
import type { CommandSource } from '../../commands/commands.js';
import { commandResponse, HttpError, ok, parseSource, zoneId, type Handler } from './context.js';
import { forecastOrNull, photoDir, photoPath } from './state.js';

/** Sources a person is looking at; the others (HomeKit, Alexa) never get warnings. */
const WARNED_SOURCES: readonly CommandSource[] = ['app', 'web', 'siri-intent'];
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

export const runZone: Handler = async (hub, req) => {
  const id = zoneId(hub, req);
  const body = reqObject(req.body, 'body');
  const seconds = reqInt(body.seconds, 'seconds', 1, MAX_RUN_SECONDS);
  const source = parseSource(body.source);
  const force = optional(body.force, (v) => reqBool(v, 'force')) ?? false;
  if (!force && WARNED_SOURCES.includes(source)) {
    const zone = hub.store.get().zones[id];
    const lastRunAt = Math.max(hub.history.lastRunAt(id) ?? -Infinity, zone?.lastRunAt ?? -Infinity);
    const warnings = evaluateWarnings(
      id,
      hub.settings.get().warnings,
      await forecastOrNull(hub), // a dead network must not hold up a run
      Number.isFinite(lastRunAt) ? lastRunAt : null,
      Date.now(),
    );
    if (warnings.length > 0) return ok({ warnings }, 409);
  }
  return commandResponse(await hub.commands.runZone(id, seconds, source));
};

export const stopZone: Handler = async (hub, req) => {
  const id = zoneId(hub, req);
  const source = parseSource(reqObject(req.body, 'body').source, 'app');
  return commandResponse(await hub.commands.stopZone(id, source));
};

export const stopAll: Handler = async (hub, req) => {
  const source = parseSource(reqObject(req.body, 'body').source, 'app');
  return commandResponse(await hub.commands.stopAll(source));
};

export const setSystem: Handler = async (hub, req) => {
  const body = reqObject(req.body, 'body');
  const enabled = reqBool(body.enabled, 'enabled');
  return commandResponse(await hub.commands.setSystemEnabled(enabled, parseSource(body.source, 'app')));
};

export const getPhoto: Handler = async (hub, req) => {
  const id = zoneId(hub, req);
  try {
    return { status: 200, bytes: await fs.readFile(photoPath(hub, id)), contentType: 'image/jpeg' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'no photo for this zone');
    throw err;
  }
};

export const putPhoto: Handler = async (hub, req) => {
  const id = zoneId(hub, req);
  if (req.contentType !== 'image/jpeg') throw new HttpError(415, 'photos must be sent as image/jpeg');
  const bytes = req.raw ?? Buffer.alloc(0);
  if (bytes.length < JPEG_MAGIC.length || !bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    throw new ValidationError('body', 'is not a JPEG image');
  }
  await fs.mkdir(photoDir(hub), { recursive: true });
  const file = photoPath(hub, id);
  await fs.writeFile(`${file}.tmp`, bytes);
  await fs.rename(`${file}.tmp`, file);
  return ok({ ok: true });
};
