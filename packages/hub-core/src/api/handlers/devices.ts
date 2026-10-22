import { reqObject, reqString, ValidationError } from '../../validate.js';
import { HttpError, ok, type ApiRequest, type Handler } from './context.js';
import type { Hub } from '../../hub.js';

const APNS_TOKEN = /^[0-9a-fA-F]{64,200}$/;
const DEVICE_ID = /^[0-9a-f]{64}$/;

/** Unauthenticated: trades a live pairing code for a bearer token and its device id. */
export const pair: Handler = async (hub, req) => {
  const body = reqObject(req.body, 'body');
  const code = reqString(body.code, 'code', { max: 16 });
  const deviceName = reqString(body.deviceName, 'deviceName', { min: 1, max: 64 });
  const claimed = hub.pairing.claim(code, deviceName);
  if (!claimed) throw new HttpError(403, 'invalid or expired pairing code');
  await hub.pairing.flush().catch(() => undefined); // already logged; the token works until restart
  return ok({ token: claimed.token, id: hub.pairing.deviceId(claimed.token) });
};

export const startPairing: Handler = async (hub) => ok(hub.pairing.startPairing());

export const listDevices: Handler = async (hub) => ok(hub.pairing.list());

/** Devices are addressed by id (token hash), never by token: tokens must not appear in URLs. */
function knownDevice(hub: Hub, req: ApiRequest): string {
  const id = req.params.id ?? '';
  if (!DEVICE_ID.test(id) || !hub.pairing.list().some((d) => d.id === id)) throw new HttpError(404, 'no such device');
  return id;
}

export const deleteDevice: Handler = async (hub, req) => {
  const id = knownDevice(hub, req);
  hub.pairing.revoke(id);
  await hub.notifier.unregisterPush(id);
  await hub.pairing.flush();
  return ok({ ok: true });
};

export const registerPush: Handler = async (hub, req) => {
  const id = knownDevice(hub, req);
  const apnsToken = reqString(reqObject(req.body, 'body').apnsToken, 'apnsToken');
  if (!APNS_TOKEN.test(apnsToken)) throw new ValidationError('apnsToken', 'must be a hex APNs device token');
  await hub.notifier.registerPush(id, apnsToken);
  return ok({ ok: true });
};
