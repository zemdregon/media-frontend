/** Minimal JSON client for `/api/v1` with the LLD-API error envelope. Same-origin only. */
import type { ErrorCode, ErrorEnvelope } from '@cinewren/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK',
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  opts: { headers?: Record<string, string>; keepalive?: boolean } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...opts.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(opts.keepalive ? { keepalive: true } : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', "Can't reach Cinewren. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const envelope = data as Partial<ErrorEnvelope> | null;
    throw new ApiError(
      res.status,
      envelope?.error?.code ?? 'INTERNAL',
      envelope?.error?.message ?? 'Something went wrong.',
    );
  }
  return data as T;
}
