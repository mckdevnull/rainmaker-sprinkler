import type { Handler } from './handlers/context.js';
import { deleteDevice, listDevices, pair, registerPush, startPairing } from './handlers/devices.js';
import {
  listSchedules,
  pauseAll,
  pauseSchedule,
  putSchedule,
  resumeAll,
  resumeSchedule,
} from './handlers/schedules.js';
import { getSettings, putSettings } from './handlers/settings.js';
import { getState } from './handlers/state.js';
import { getPhoto, putPhoto, runZone, setSystem, stopAll, stopZone } from './handlers/zones.js';

export type BodyKind = 'none' | 'json' | 'jpeg';
export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface Route {
  method: Method;
  path: string;
  handler: Handler;
  body: BodyKind;
  /** No bearer token needed (only pairing itself). */
  public?: boolean;
}

export const JSON_LIMIT_BYTES = 64 * 1024;
export const PHOTO_LIMIT_BYTES = 2 * 1024 * 1024;

const r = (method: Method, path: string, handler: Handler, body: BodyKind = 'none', isPublic = false): Route => ({
  method,
  path,
  handler,
  body,
  ...(isPublic && { public: true }),
});

/** Every route of the local API. WebSocket upgrades on /v1/ws are handled by ws.ts. */
export const ROUTES: readonly Route[] = [
  r('GET', '/v1/state', getState),
  r('POST', '/v1/zones/:id/run', runZone, 'json'),
  r('POST', '/v1/zones/:id/stop', stopZone, 'json'),
  r('POST', '/v1/stop-all', stopAll, 'json'),
  r('POST', '/v1/system', setSystem, 'json'),
  r('POST', '/v1/pause', pauseAll, 'json'),
  r('POST', '/v1/resume', resumeAll, 'json'),
  r('POST', '/v1/schedules/:id/pause', pauseSchedule, 'json'),
  r('POST', '/v1/schedules/:id/resume', resumeSchedule, 'json'),
  r('GET', '/v1/schedules', listSchedules),
  r('PUT', '/v1/schedules/:id', putSchedule, 'json'),
  r('GET', '/v1/settings', getSettings),
  r('PUT', '/v1/settings', putSettings, 'json'),
  r('GET', '/v1/zones/:id/photo', getPhoto),
  r('PUT', '/v1/zones/:id/photo', putPhoto, 'jpeg'),
  r('POST', '/v1/pair', pair, 'json', true),
  r('POST', '/v1/pairing/start', startPairing, 'json'),
  r('GET', '/v1/devices', listDevices),
  r('DELETE', '/v1/devices/:token', deleteDevice),
  r('PUT', '/v1/devices/:token/push', registerPush, 'json'),
];

export type Match =
  | { kind: 'route'; route: Route; params: Record<string, string> }
  | { kind: 'method-not-allowed'; allow: Method[] }
  | { kind: 'not-found' };

function matchPath(template: string, pathname: string): Record<string, string> | null {
  const want = template.split('/');
  const got = pathname.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i] as string;
    const g = got[i] as string;
    if (w.startsWith(':')) {
      if (g === '') return null;
      try {
        params[w.slice(1)] = decodeURIComponent(g);
      } catch {
        return null;
      }
    } else if (w !== g) return null;
  }
  return params;
}

export function matchRoute(method: string, pathname: string): Match {
  const allow: Method[] = [];
  for (const route of ROUTES) {
    const params = matchPath(route.path, pathname);
    if (!params) continue;
    if (route.method === method) return { kind: 'route', route, params };
    allow.push(route.method);
  }
  return allow.length > 0 ? { kind: 'method-not-allowed', allow } : { kind: 'not-found' };
}
