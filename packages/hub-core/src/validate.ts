/**
 * Hand-written validators shared by config loading and the API. Errors name the field and the
 * problem but never echo the offending value (it may be a password or token).
 */
export class ValidationError extends Error {
  constructor(
    readonly field: string,
    readonly problem: string,
  ) {
    super(`${field} ${problem}`);
    this.name = 'ValidationError';
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function reqObject(v: unknown, field: string): Record<string, unknown> {
  if (!isRecord(v)) throw new ValidationError(field, v === undefined ? 'is required' : 'must be an object');
  return v;
}

export function reqString(v: unknown, field: string, opts: { min?: number; max?: number } = {}): string {
  if (typeof v !== 'string') throw new ValidationError(field, v === undefined ? 'is required' : 'must be a string');
  const { min = 0, max = Infinity } = opts;
  if (v.length < min) throw new ValidationError(field, min === 1 ? 'must not be empty' : `must be at least ${min} characters`);
  if (v.length > max) throw new ValidationError(field, `must be at most ${max} characters`);
  return v;
}

export function reqBool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new ValidationError(field, v === undefined ? 'is required' : 'must be true or false');
  return v;
}

export function reqNumber(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ValidationError(field, v === undefined ? 'is required' : 'must be a number');
  }
  if (v < min || v > max) throw new ValidationError(field, `must be between ${min} and ${max}`);
  return v;
}

export function reqInt(v: unknown, field: string, min: number, max: number): number {
  const n = reqNumber(v, field, min, max);
  if (!Number.isInteger(n)) throw new ValidationError(field, 'must be a whole number');
  return n;
}

export function optional<T>(v: unknown, parse: (v: unknown) => T): T | undefined {
  return v === undefined ? undefined : parse(v);
}

/** A non-negative integer written as an object key ("3"). */
export function intKey(key: string, field: string): number {
  if (!/^\d{1,4}$/.test(key)) throw new ValidationError(field, 'must be a zone number');
  return Number(key);
}

export function rejectUnknown(obj: Record<string, unknown>, allowed: readonly string[], prefix = ''): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new ValidationError(`${prefix}${key}`, 'is not a known field');
  }
}

/** The longest manual run the controller accepts (/cm t=, 18 h). */
export const MAX_RUN_SECONDS = 64800;
