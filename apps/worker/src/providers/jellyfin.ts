/**
 * Jellyfin adapter (IR-003, FR-SRV-002, FR-SRV-003, NFR-SEC-005; spike 2026-provider-spike.md).
 * Verified against Jellyfin 12.1.0 only.
 *
 * Auth: the service account is a non-admin username and password. `AuthenticateByName` returns
 * an access token that is derived at runtime and sent as
 * `Authorization: MediaBrowser ..., Token="..."` (12.1 rejects `X-Emby-*` and `api_key=`).
 * The password is the only stored secret; the token is never persisted by Cinewren.
 */
import { ProviderError } from './errors';
import { asRec, normalizeCollection, normalizeItem } from './jellyfin-normalize';
import {
  JELLYFIN_FLAVOR,
  mintSessionToken,
  negotiate,
  report,
  revokeSessionToken,
  streamDeviceId,
} from './mediabrowser-playback';
import { statusError } from './origin-fetch';
import type {
  ArtworkKind,
  ArtworkRef,
  ItemsPage,
  ListItemsRequest,
  MediaProvider,
  NormalizedCollection,
  NormalizedItem,
  NormalizedLibrary,
  ProbeResult,
  ProviderContext,
  ValidationFailureReason,
  ValidationResult,
} from './types';
import { parseVersion, versionAtLeast } from './version';

/** IR-003: versions verified in the spike. */
export const JELLYFIN_MIN_VERSION = '12.1';
const MIN_VERSION_PARTS = [12, 1];

const CLIENT =
  'MediaBrowser Client="Cinewren", Device="Cinewren Sync", DeviceId="cinewren-svc-main", Version="0.0.1"';
const ITEM_FIELDS =
  'ProviderIds,MediaSources,MediaStreams,Overview,Genres,DateCreated,DateLastSaved,Path,SortName,OriginalTitle,ProductionYear,RunTimeTicks,ParentId,Etag,People';
const MAX_PAGE_SIZE = 200;

interface Session {
  userId: string;
  token: string;
}

/** The cached token is `<userId>:<token>`: both are needed for later calls and neither is a secret to the other. */
function encodeSession(s: Session): string {
  return `${s.userId}:${s.token}`;
}
function decodeSession(raw: string | undefined): Session | null {
  if (!raw) return null;
  const at = raw.indexOf(':');
  return at > 0 && at < raw.length - 1
    ? { userId: raw.slice(0, at), token: raw.slice(at + 1) }
    : null;
}

interface AuthResult extends Session {
  isAdministrator: unknown;
  isDisabled: unknown;
  serverId: string | undefined;
}

const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new ProviderError('PROTOCOL', 'The origin sent an unreadable response.', false);
  }
}

async function authenticate(ctx: ProviderContext): Promise<AuthResult> {
  if (ctx.secret.kind !== 'password') {
    throw new ProviderError('UNSUPPORTED', 'Jellyfin needs a username and password.', false);
  }
  const res = await ctx.fetch('/Users/AuthenticateByName', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: CLIENT,
    },
    body: JSON.stringify({ Username: ctx.secret.username, Pw: ctx.secret.password }),
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new ProviderError('AUTH', 'The origin refused the credentials.', false);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw statusError(res.status);
  }
  const body = asRec(await readJson(res));
  const user = asRec(body?.User);
  const token = text(body?.AccessToken);
  const userId = text(user?.Id);
  if (!token || !userId) {
    throw new ProviderError('PROTOCOL', 'The origin sent an unexpected sign-in response.', false);
  }
  const policy = asRec(user?.Policy);
  return {
    token,
    userId,
    isAdministrator: policy?.IsAdministrator,
    isDisabled: policy?.IsDisabled,
    serverId: text(body?.ServerId),
  };
}

async function signIn(ctx: ProviderContext): Promise<Session> {
  const { token, userId } = await authenticate(ctx);
  const session = { token, userId };
  ctx.serviceToken = encodeSession(session);
  await ctx.onTokenRefresh(ctx.serviceToken);
  return session;
}

/**
 * An authenticated GET/POST. On a 401 the token is refreshed exactly once (LLD-ERR), then the
 * call is retried; a second 401 is an `AUTH` error.
 */
async function call(
  ctx: ProviderContext,
  path: (userId: string) => string,
  init: { method?: 'GET' | 'POST'; body?: string } = {},
): Promise<Response> {
  let session = decodeSession(ctx.serviceToken) ?? (await signIn(ctx));
  for (let attempt = 0; ; attempt++) {
    const res = await ctx.fetch(path(session.userId), {
      method: init.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `${CLIENT}, Token="${session.token}"`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    if (res.status !== 401 || attempt > 0) return res;
    await res.body?.cancel();
    session = await signIn(ctx);
  }
}

async function okJson(res: Response): Promise<Rec> {
  if (!res.ok) {
    await res.body?.cancel();
    throw statusError(res.status);
  }
  const body = asRec(await readJson(res));
  if (!body) throw new ProviderError('PROTOCOL', 'The origin sent an unexpected response.', false);
  return body;
}
type Rec = Record<string, unknown>;

function failureReason(err: ProviderError): ValidationFailureReason {
  if (err.code === 'TIMEOUT') return 'timeout';
  if (err.code === 'REDIRECT_REFUSED') return 'redirect_refused';
  return 'unreachable';
}

/** Best effort: do not leave a session behind for an account we are about to refuse. */
async function logout(ctx: ProviderContext, session: Session): Promise<void> {
  try {
    const res = await ctx.fetch('/Sessions/Logout', {
      method: 'POST',
      headers: { Authorization: `${CLIENT}, Token="${session.token}"` },
    });
    await res.body?.cancel();
  } catch {
    // Nothing more to do; the refusal is what matters.
  }
}

async function validate(ctx: ProviderContext): Promise<ValidationResult> {
  // 1. tls: the identity endpoint answers over the registered scheme with a valid certificate.
  let pub: Rec | null;
  try {
    const res = await ctx.fetch('/System/Info/Public', { headers: { Accept: 'application/json' } });
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      await res.body?.cancel();
      return { ok: false, check: 'tls', reason: 'unreachable' };
    }
    pub = res.ok ? asRec(await res.json().catch(() => null)) : null;
  } catch (err) {
    if (err instanceof ProviderError) {
      return { ok: false, check: 'tls', reason: failureReason(err) };
    }
    throw err;
  }
  // Not a Jellyfin identity answer: refuse before any password is sent to this host.
  const originServerId = text(pub?.Id);
  const product = text(pub?.ProductName);
  if (!pub || !originServerId || (product !== undefined && !/jellyfin/i.test(product))) {
    return { ok: false, check: 'identity', reason: 'not_a_server' };
  }

  // 2. credentials: authentication succeeds and the account is not an administrator.
  if (ctx.secret.kind !== 'password') {
    return { ok: false, check: 'credentials', reason: 'unsupported_credential' };
  }
  let auth: AuthResult;
  try {
    auth = await authenticate(ctx);
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.code === 'AUTH')
      return { ok: false, check: 'credentials', reason: 'invalid_credentials' };
    if (err.code === 'PROTOCOL' || err.code === 'NOT_FOUND') {
      return { ok: false, check: 'identity', reason: 'not_a_server' };
    }
    return { ok: false, check: 'tls', reason: failureReason(err) };
  }
  if (auth.isAdministrator !== false || auth.isDisabled === true) {
    await logout(ctx, auth);
    if (auth.isDisabled === true)
      return { ok: false, check: 'credentials', reason: 'account_disabled' };
    return {
      ok: false,
      check: 'credentials',
      reason: auth.isAdministrator === true ? 'admin_account' : 'admin_status_unknown',
    };
  }
  ctx.serviceToken = encodeSession(auth);
  await ctx.onTokenRefresh(ctx.serviceToken);

  // 3. identity: the server ID is stable and, on re-validation, equals the stored one.
  if (auth.serverId !== undefined && auth.serverId !== originServerId) {
    return { ok: false, check: 'identity', reason: 'not_a_server' };
  }
  if (ctx.server.originServerId !== undefined && ctx.server.originServerId !== originServerId) {
    return { ok: false, check: 'identity', reason: 'server_id_mismatch' };
  }

  // 4. version.
  const version = text(pub.Version) ?? '';
  const parts = parseVersion(version);
  if (!parts) return { ok: false, check: 'version', reason: 'version_unparseable' };
  if (!versionAtLeast(parts, MIN_VERSION_PARTS)) {
    return {
      ok: false,
      check: 'version',
      reason: 'version_too_old',
      minimumVersion: JELLYFIN_MIN_VERSION,
    };
  }
  const serverName = text(pub.ServerName);
  return {
    ok: true,
    originServerId,
    version: parts.join('.'),
    ...(serverName ? { serverName } : {}),
  };
}

async function listLibraries(ctx: ProviderContext): Promise<NormalizedLibrary[]> {
  const body = await okJson(
    await call(ctx, (userId) => `/UserViews?userId=${encodeURIComponent(userId)}`),
  );
  const libraries: NormalizedLibrary[] = [];
  for (const entry of Array.isArray(body.Items) ? (body.Items as unknown[]) : []) {
    const view = asRec(entry);
    const id = text(view?.Id);
    const name = text(view?.Name);
    const type = view?.CollectionType;
    if (!id || !name) continue;
    if (type === 'movies') libraries.push({ providerLibraryId: id, name, kind: 'movies' });
    else if (type === 'tvshows') libraries.push({ providerLibraryId: id, name, kind: 'tv' });
  }
  return libraries;
}

async function listItems(ctx: ProviderContext, req: ListItemsRequest): Promise<ItemsPage> {
  if (req.cursor !== undefined && !/^\d{1,9}$/.test(req.cursor)) {
    throw new ProviderError('PROTOCOL', 'Invalid page cursor.', false);
  }
  const start = req.cursor === undefined ? 0 : Number(req.cursor);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(req.pageSize)));
  const body = await okJson(
    await call(ctx, (userId) => {
      const q = new URLSearchParams({
        userId,
        ParentId: req.libraryId,
        Recursive: 'true',
        IncludeItemTypes: 'Movie,Series,Season,Episode',
        Fields: ITEM_FIELDS,
        SortBy: 'SortName',
        SortOrder: 'Ascending',
        StartIndex: String(start),
        Limit: String(limit),
        EnableTotalRecordCount: 'true',
      });
      // Verified parameter name (spike 2, row 3c). Unknown parameters are silently ignored by the
      // origin, so the contract suite proves this one is applied.
      if (req.since !== undefined) q.set('MinDateLastSaved', new Date(req.since).toISOString());
      return `/Items?${q.toString()}`;
    }),
  );
  const raw = Array.isArray(body.Items) ? (body.Items as unknown[]) : [];
  const total = typeof body.TotalRecordCount === 'number' ? body.TotalRecordCount : 0;
  const items = raw.flatMap((r) => normalizeItem(r) ?? []);
  const next = start + raw.length;
  return { items, nextCursor: raw.length > 0 && next < total ? String(next) : null };
}

/**
 * Box sets (FR-SYNC-008, spike section 4b): `GET /Items?IncludeItemTypes=BoxSet&Recursive=true`
 * lists them server-wide (a box set is not inside a movie library, so `libraryId` is not used),
 * and `GET /Items?ParentId=<boxSetId>` lists its members. The cursor is an offset into the box
 * set list; each page also fetches the members of the box sets on it.
 */
async function listCollections(
  ctx: ProviderContext,
  req: { libraryId?: string; cursor?: string; pageSize: number },
): Promise<{ collections: NormalizedCollection[]; nextCursor: string | null }> {
  if (req.cursor !== undefined && !/^\d{1,9}$/.test(req.cursor)) {
    throw new ProviderError('PROTOCOL', 'Invalid page cursor.', false);
  }
  const start = req.cursor === undefined ? 0 : Number(req.cursor);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(req.pageSize)));
  const body = await okJson(
    await call(ctx, (userId) => {
      const q = new URLSearchParams({
        userId,
        IncludeItemTypes: 'BoxSet',
        Recursive: 'true',
        Fields: 'ProviderIds,Overview,DateLastSaved,ChildCount',
        StartIndex: String(start),
        Limit: String(limit),
        EnableTotalRecordCount: 'true',
      });
      return `/Items?${q.toString()}`;
    }),
  );
  const raw = Array.isArray(body.Items) ? (body.Items as unknown[]) : [];
  const total = typeof body.TotalRecordCount === 'number' ? body.TotalRecordCount : 0;
  const collections: NormalizedCollection[] = [];
  for (const entry of raw) {
    const setId = text(asRec(entry)?.Id);
    if (!setId) continue;
    const members: unknown[] = [];
    for (let at = 0; ;) {
      const page = await okJson(
        await call(ctx, (userId) => {
          const q = new URLSearchParams({
            userId,
            ParentId: setId,
            Fields: 'ProviderIds',
            StartIndex: String(at),
            Limit: String(MAX_PAGE_SIZE),
            EnableTotalRecordCount: 'true',
          });
          return `/Items?${q.toString()}`;
        }),
      );
      const items = Array.isArray(page.Items) ? (page.Items as unknown[]) : [];
      members.push(...items);
      at += items.length;
      const memberTotal = typeof page.TotalRecordCount === 'number' ? page.TotalRecordCount : 0;
      if (items.length === 0 || at >= memberTotal) break;
    }
    const normalized = normalizeCollection(entry, members);
    if (normalized) collections.push(normalized);
  }
  const next = start + raw.length;
  return { collections, nextCursor: raw.length > 0 && next < total ? String(next) : null };
}

async function getItem(
  ctx: ProviderContext,
  providerItemId: string,
): Promise<NormalizedItem | null> {
  const res = await call(
    ctx,
    (userId) =>
      `/Items/${encodeURIComponent(providerItemId)}?userId=${encodeURIComponent(userId)}&Fields=People,ProviderIds`,
  );
  if (res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  return normalizeItem(await okJson(res));
}

function getArtworkRequest(ctx: ProviderContext, ref: ArtworkRef, kind: ArtworkKind): Request {
  const slot = kind === 'poster' ? 'Primary' : kind === 'backdrop' ? 'Backdrop' : 'Thumb';
  // Jellyfin serves images without auth (spike section 5), so no credential is attached.
  const prefix = ctx.server.baseUrl.pathname.replace(/\/+$/, '');
  const url = new URL(
    `${ctx.server.baseUrl.origin}${prefix}/Items/${encodeURIComponent(ref.providerItemId)}/Images/${slot}`,
  );
  url.searchParams.set('tag', ref.tag);
  return new Request(url, { method: 'GET', redirect: 'manual' });
}

async function probe(ctx: ProviderContext): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await ctx.fetch('/System/Info/Public', {
      headers: { Accept: 'application/json' },
      timeoutMs: 5000,
    });
    await res.body?.cancel();
    const latencyMs = Date.now() - started;
    return res.ok
      ? { ok: true, latencyMs }
      : { ok: false, latencyMs, errorCode: `HTTP_${res.status}` };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      errorCode: err instanceof ProviderError ? err.code : 'UNAVAILABLE',
    };
  }
}

export const jellyfinProvider: MediaProvider = {
  type: 'jellyfin',
  validate,
  listLibraries,
  listItems,
  getItem,
  getArtworkRequest,
  probe,
  listCollections,
  // Playback (M3, ADR-0013). Owner decision 2026-10-04: Jellyfin always streams through
  // token-gated HLS and never `static=true` direct play, which the origin does not authenticate.
  // Re-auth on one DeviceId kills its previous token, so every session gets its own DeviceId.
  streamDevices: 'per_session',
  createSessionCredential: (ctx, sessionId) => mintSessionToken(ctx, streamDeviceId(sessionId)),
  revokeSessionCredential: revokeSessionToken,
  negotiatePlayback: (ctx, req) => negotiate(ctx, JELLYFIN_FLAVOR, req),
  reportPlayback: report,
};
