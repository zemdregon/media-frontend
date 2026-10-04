import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ERROR_STATUS, type ErrorCode, type ErrorEnvelope } from '@cinewren/shared';
import type { AppEnv } from './context';

/** Throw from any handler; `onError` turns it into the JSON envelope (LLD-ERR). */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorResponse(
  c: Context<AppEnv>,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): Response {
  const body: ErrorEnvelope = {
    error: {
      code,
      message,
      requestId: c.get('requestId'),
      ...(details ? { details } : {}),
    },
  };
  return c.json(body, ERROR_STATUS[code]);
}

export function notFoundHandler(c: Context<AppEnv>): Response {
  return errorResponse(c, 'NOT_FOUND', 'Not found.');
}

/** The single error handler. Unknown errors become INTERNAL with a generic message. */
export function errorHandler(err: Error, c: Context<AppEnv>): Response {
  if (err instanceof AppError) return errorResponse(c, err.code, err.message, err.details);
  if (err instanceof HTTPException && err.status === 404) return notFoundHandler(c);
  if (err instanceof HTTPException && err.status === 400) {
    return errorResponse(c, 'VALIDATION_FAILED', 'The request was invalid.');
  }
  c.get('logger').error('error', { error: err });
  return errorResponse(c, 'INTERNAL', 'Something went wrong.');
}
