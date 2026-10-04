/**
 * Test harness for the auth integration tests: the real app and local D1, a swappable rate
 * limiter (the `RL_AUTH` test seam) and helpers that drive the WebAuthn ceremonies with the
 * virtual authenticator.
 */
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { createApp } from '../src/api/app';
import type { Env } from '../src/platform/env';
import { VirtualAuthenticator } from './virtual-authenticator';

export const ORIGIN = 'http://localhost:8787';
export const SETUP_TOKEN = 'test-setup-token-0123456789abcdefghijklmnop';

export const limiter = {
  allow: true,
  keys: [] as string[],
};

const rateLimit: RateLimit = {
  limit: ({ key }) => {
    limiter.keys.push(key);
    return Promise.resolve({ success: limiter.allow });
  },
};

export function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, SETUP_TOKEN, RL_AUTH: rateLimit, ...overrides };
}

const app = createApp();

export interface CallOptions {
  body?: unknown;
  cookie?: string | undefined;
  origin?: string | null;
  headers?: Record<string, string>;
  env?: Partial<Env>;
  /** An app built with `createApp({ originFetch })`, for routes that call origin servers. */
  app?: ReturnType<typeof createApp>;
}

export async function call(
  method: string,
  path: string,
  opts: CallOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.origin = origin;
  if (opts.cookie) headers.cookie = opts.cookie;
  return (opts.app ?? app).request(
    path,
    { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) },
    testEnv(opts.env),
  );
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return res.json<T>();
}

export async function errorCode(res: Response): Promise<string> {
  return (await res.json<{ error: { code: string } }>()).error.code;
}

/** `name=value` for a request Cookie header, from the Set-Cookie of a response. */
export function sessionCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  const match = /(__Host-cw_session=[^;]+)/.exec(raw);
  if (!match?.[1]) throw new Error(`No session cookie in: ${raw}`);
  return match[1];
}

export async function resetDb(): Promise<void> {
  const db = env.DB;
  await db.batch(
    [
      'DELETE FROM users',
      'DELETE FROM webauthn_challenges',
      'DELETE FROM servers',
      'DELETE FROM audit_log',
      'DELETE FROM meta',
    ].map((sql) => db.prepare(sql)),
  );
  limiter.allow = true;
  limiter.keys = [];
}

interface Ceremony<T> {
  challengeId: string;
  options: T;
}

export async function setupOperator(auth = new VirtualAuthenticator(), displayName = 'Olivia') {
  const optRes = await call('POST', '/api/v1/setup/options', {
    body: { setupToken: SETUP_TOKEN, displayName },
  });
  expect(optRes.status).toBe(200);
  const { challengeId, options } =
    await json<Ceremony<PublicKeyCredentialCreationOptionsJSON>>(optRes);
  const response = await auth.register(options, ORIGIN);
  const res = await call('POST', '/api/v1/setup/verify', {
    body: { setupToken: SETUP_TOKEN, displayName, challengeId, response },
  });
  expect(res.status).toBe(201);
  return {
    auth,
    cookie: sessionCookie(res),
    res,
    user: (await json<{ user: { id: string } }>(res)).user,
  };
}

export async function createInvite(operatorCookie: string, body: Record<string, unknown>) {
  const res = await call('POST', '/api/v1/admin/invites', { cookie: operatorCookie, body });
  expect(res.status).toBe(201);
  const invite = await json<{ id: string; userId: string; link: string; expiresAt: number }>(res);
  const token = new URL(invite.link).hash.replace(/^#t=/, '');
  return { ...invite, token };
}

export async function redeemOptions(token: string) {
  const res = await call('POST', '/api/v1/invites/redeem/options', { body: { token } });
  return {
    res,
    body: res.ok ? await json<Ceremony<PublicKeyCredentialCreationOptionsJSON>>(res) : null,
  };
}

export async function redeem(token: string, auth = new VirtualAuthenticator()) {
  const opts = await redeemOptions(token);
  expect(opts.res.status).toBe(200);
  const { challengeId, options } = opts.body as Ceremony<PublicKeyCredentialCreationOptionsJSON>;
  const response = await auth.register(options, ORIGIN);
  const res = await call('POST', '/api/v1/invites/redeem/verify', {
    body: { token, challengeId, response },
  });
  return { res, auth };
}

export async function loginOptions() {
  const res = await call('POST', '/api/v1/auth/login/options');
  expect(res.status).toBe(200);
  return json<Ceremony<PublicKeyCredentialRequestOptionsJSON>>(res);
}

export async function login(auth: VirtualAuthenticator, which = 0, origin = ORIGIN) {
  const { challengeId, options } = await loginOptions();
  const response = await auth.authenticate(options, origin, which);
  return call('POST', '/api/v1/auth/login/verify', { body: { challengeId, response } });
}

export async function addPasskey(cookie: string, auth: VirtualAuthenticator) {
  const optRes = await call('POST', '/api/v1/me/passkeys/options', { cookie });
  expect(optRes.status).toBe(200);
  const { challengeId, options } =
    await json<Ceremony<PublicKeyCredentialCreationOptionsJSON>>(optRes);
  const response = await auth.register(options, ORIGIN);
  return call('POST', '/api/v1/me/passkeys/verify', {
    cookie,
    body: { challengeId, response, label: 'Laptop' },
  });
}

export async function sha256Hex(value: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
