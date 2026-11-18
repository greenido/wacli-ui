import type { Request } from 'express';

/**
 * A query string the caller got wrong. The global error handler answers it
 * 400 with this message: it is about the request, so retrying cannot help.
 */
export class QueryParamError extends Error {
  readonly status = 400;
  readonly expose = true;
}

/**
 * One query parameter as a string, or undefined when it is absent.
 *
 * Express hands a repeated parameter (`?q=a&q=b`) over as an array. Cast
 * `as string`, that threw on the first string method, or reached wacli as
 * whatever its `toString` made of it.
 */
export function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (value === undefined || typeof value === 'string') return value;
  throw new QueryParamError(`Query parameter "${name}" must be given once.`);
}

/**
 * A positive whole number, or undefined when the parameter is absent or empty.
 * Anything else is refused rather than passed on: wacli refuses it too, and
 * that surfaced as a 500.
 */
export function queryLimit(req: Request, name = 'limit'): number | undefined {
  const raw = queryString(req, name);
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new QueryParamError(`Query parameter "${name}" must be a positive whole number.`);
  }
  return Number(raw);
}
