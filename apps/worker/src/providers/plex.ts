/**
 * Plex adapter (IR-005, FR-SRV-002, FR-SRV-003, NFR-SEC-005; spike 2026-provider-spike.md).
 * Verified against Plex Media Server 1.43.4 only.
 *
 * Auth: the credential is the access token of a restricted managed (Home) user created for
 * Cinewren (owner decision 2026-10-04). Owner tokens are refused at registration, and an owner
 * token is never sent to a browser. It is sent as `X-Plex-Token` and `Accept: application/json`
 * selects JSON over XML. The token is the stored secret itself; there is no derived token.
 *
 * OPEN, blocked on B-3 (the owner creating the managed user), not verifiable from the spike:
 * 1. How the managed user's token is obtained (Plex Home user switch through plex.tv, or a PIN
 *    link). Until then registration accepts a pasted `token` credential.
 * 2. That a managed user's token gets 401 or 403 on `GET /:/prefs` (the admin probe below). The
 *    spike saw 200 for the owner token and for its transient token.
 * 3. Whether that token can stream: part and `start.m3u8` URLs, and `/:/timeline`.
 * 4. Whether a transient token minted by the managed user (`/security/token`) is accepted and is
 *    restricted, and its lifetime, which would allow per-session revocation.
 * Until 1 to 4 are verified, `playbackVerified` is false: browse, search and sync work, and
 * selection excludes Plex copies from playback with reason `provider_unverified`.
 */
import { ProviderError } from './errors';
import { statusError } from './origin-fetch';
import { normalizePlexCollection, normalizePlexItem } from './plex-normalize';
import {
  issueManagedUserCredential,
  negotiate,
  plexHeaders,
  report,
  tokenIsAdmin,
} from './plex-playback';
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

/** IR-005: 1.43.4 was verified in the spike. */
export const PLEX_MIN_VERSION = '1.43';
const MIN_VERSION_PARTS = [1, 43];
const MAX_PAGE_SIZE = 200;

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : null;
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;
const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

function tokenOf(ctx: ProviderContext): string {
  if (ctx.secret.kind !== 'token') {
    throw new ProviderError('UNSUPPORTED', 'Plex needs the access token of a managed user.', false);
  }
  return ctx.secret.token;
}

/** An authenticated GET. A 401 is an `AUTH` error: the token is static, so there is nothing to refresh. */
async function get(ctx: ProviderContext, pathAndQuery: string): Promise<Response> {
  return ctx.fetch(pathAndQuery, { headers: plexHeaders(tokenOf(ctx)) });
}

/** The `MediaContainer` of a successful JSON response. */
async function container(res: Response): Promise<Rec> {
  if (!res.ok) {
    await res.body?.cancel();
    throw statusError(res.status);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ProviderError('PROTOCOL', 'The origin sent an unreadable response.', false);
  }
  const mc = asRec(asRec(body)?.MediaContainer);
  if (!mc) throw new ProviderError('PROTOCOL', 'The origin sent an unexpected response.', false);
  return mc;
}

function failureReason(err: ProviderError): ValidationFailureReason {
  if (err.code === 'TIMEOUT') return 'timeout';
  if (err.code === 'REDIRECT_REFUSED') return 'redirect_refused';
  return 'unreachable';
}

async function validate(ctx: ProviderContext): Promise<ValidationResult> {
  // 1. tls and 3. identity source: `/identity` needs no token, so no credential is sent to a host
  // before it has answered like a Plex server.
  let identity: Rec | null;
  try {
    const res = await ctx.fetch('/identity', { headers: plexHeaders(undefined) });
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      await res.body?.cancel();
      return { ok: false, check: 'tls', reason: 'unreachable' };
    }
    identity = res.ok ? asRec(asRec(await res.json().catch(() => null))?.MediaContainer) : null;
  } catch (err) {
    if (err instanceof ProviderError) {
      return { ok: false, check: 'tls', reason: failureReason(err) };
    }
    throw err;
  }
  const originServerId = text(identity?.machineIdentifier);
  if (!identity || !originServerId) {
    return { ok: false, check: 'identity', reason: 'not_a_server' };
  }

  // 2. credentials: a token, accepted by the server, that cannot do administrator things.
  if (ctx.secret.kind !== 'token') {
    return { ok: false, check: 'credentials', reason: 'unsupported_credential' };
  }
  const token = ctx.secret.token;
  try {
    const sections = await ctx.fetch('/library/sections', { headers: plexHeaders(token) });
    await sections.body?.cancel();
    if (sections.status === 401 || sections.status === 403) {
      return { ok: false, check: 'credentials', reason: 'invalid_credentials' };
    }
    if (!sections.ok) {
      return { ok: false, check: 'tls', reason: 'unreachable' };
    }
    const admin = await tokenIsAdmin(ctx, token);
    if (admin !== false) {
      return {
        ok: false,
        check: 'credentials',
        reason: admin === true ? 'admin_account' : 'admin_status_unknown',
      };
    }
  } catch (err) {
    if (err instanceof ProviderError) {
      return { ok: false, check: 'tls', reason: failureReason(err) };
    }
    throw err;
  }

  // 3. identity: the machine identifier is stable and, on re-validation, equals the stored one.
  if (ctx.server.originServerId !== undefined && ctx.server.originServerId !== originServerId) {
    return { ok: false, check: 'identity', reason: 'server_id_mismatch' };
  }

  // 4. version.
  const version = text(identity.version) ?? '';
  const parts = parseVersion(version);
  if (!parts) return { ok: false, check: 'version', reason: 'version_unparseable' };
  if (!versionAtLeast(parts, MIN_VERSION_PARTS)) {
    return {
      ok: false,
      check: 'version',
      reason: 'version_too_old',
      minimumVersion: PLEX_MIN_VERSION,
    };
  }
  return { ok: true, originServerId, version: parts.join('.') };
}

async function listLibraries(ctx: ProviderContext): Promise<NormalizedLibrary[]> {
  const mc = await container(await get(ctx, '/library/sections'));
  const libraries: NormalizedLibrary[] = [];
  for (const entry of asArr(mc.Directory)) {
    const dir = asRec(entry);
    const id = text(dir?.key);
    const name = text(dir?.title);
    if (!id || !name || dir?.hidden === 1 || dir?.hidden === 2) continue;
    if (dir?.type === 'movie') libraries.push({ providerLibraryId: id, name, kind: 'movies' });
    else if (dir?.type === 'show') libraries.push({ providerLibraryId: id, name, kind: 'tv' });
  }
  return libraries;
}

/**
 * Items are listed in phases because Plex lists one level at a time: phase 0 is the section's
 * default level (movies, or shows), then seasons (`type=3`) and episodes (`type=4`) for a show
 * section. The cursor is `<phase>:<offset>`.
 */
const PHASE_TYPE = [undefined, '3', '4'] as const;

function parseCursor(cursor: string | undefined): { phase: number; offset: number } {
  if (cursor === undefined) return { phase: 0, offset: 0 };
  const m = /^([0-2]):(\d{1,9})$/.exec(cursor);
  if (!m) throw new ProviderError('PROTOCOL', 'Invalid page cursor.', false);
  return { phase: Number(m[1]), offset: Number(m[2]) };
}

async function listItems(ctx: ProviderContext, req: ListItemsRequest): Promise<ItemsPage> {
  const { phase, offset } = parseCursor(req.cursor);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(req.pageSize)));
  const q = new URLSearchParams({ includeGuids: '1' });
  const type = PHASE_TYPE[phase];
  if (type) q.set('type', type);
  // Verified filter (spike 3c): `updatedAt>=<unix seconds>`. Unknown parameters are silently
  // ignored by the origin, so the contract suite proves this one is applied.
  if (req.since !== undefined) q.set('updatedAt>', String(Math.floor(req.since / 1000)));
  q.set('X-Plex-Container-Start', String(offset));
  q.set('X-Plex-Container-Size', String(limit));
  const mc = await container(
    await get(ctx, `/library/sections/${encodeURIComponent(req.libraryId)}/all?${q.toString()}`),
  );
  const raw = asArr(mc.Metadata);
  const total = count(mc.totalSize) ?? count(mc.size) ?? 0;
  const items = raw.flatMap((r) => normalizePlexItem(r) ?? []);
  const next = offset + raw.length;
  let nextCursor: string | null = null;
  if (raw.length > 0 && next < total) nextCursor = `${phase}:${next}`;
  else if ((phase > 0 || mc.viewGroup === 'show') && phase < 2) nextCursor = `${phase + 1}:0`;
  return { items, nextCursor };
}

/** Section collections, then members: a collection lives in a section and lists children. */
async function listCollections(
  ctx: ProviderContext,
  req: { libraryId?: string; cursor?: string; pageSize: number },
): Promise<{ collections: NormalizedCollection[]; nextCursor: string | null }> {
  if (req.cursor !== undefined && !/^\d{1,9}$/.test(req.cursor)) {
    throw new ProviderError('PROTOCOL', 'Invalid page cursor.', false);
  }
  const start = req.cursor === undefined ? 0 : Number(req.cursor);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(req.pageSize)));
  const sectionIds = req.libraryId
    ? [req.libraryId]
    : (await listLibraries(ctx)).map((l) => l.providerLibraryId);
  const all: unknown[] = [];
  for (const sectionId of sectionIds) {
    const mc = await container(
      await get(
        ctx,
        `/library/sections/${encodeURIComponent(sectionId)}/collections?includeGuids=1`,
      ),
    );
    all.push(...asArr(mc.Metadata));
  }
  const slice = all.slice(start, start + limit);
  const collections: NormalizedCollection[] = [];
  for (const entry of slice) {
    const ratingKey = (asRec(entry) ?? {}).ratingKey;
    const id = typeof ratingKey === 'string' || typeof ratingKey === 'number' ? ratingKey : null;
    if (id === null) continue;
    const children = await container(
      await get(ctx, `/library/collections/${encodeURIComponent(String(id))}/children`),
    );
    const normalized = normalizePlexCollection(entry, asArr(children.Metadata));
    if (normalized) collections.push(normalized);
  }
  const next = start + slice.length;
  return { collections, nextCursor: next < all.length ? String(next) : null };
}

async function getItem(
  ctx: ProviderContext,
  providerItemId: string,
): Promise<NormalizedItem | null> {
  const res = await get(
    ctx,
    `/library/metadata/${encodeURIComponent(providerItemId)}?includeGuids=1`,
  );
  if (res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  const mc = await container(res);
  return normalizePlexItem(asArr(mc.Metadata)[0]);
}

/**
 * The image request is built for the Worker's own fetch (the artwork proxy) and carries the token
 * as a header, never in the URL, so it cannot leak through a log line or a redirect target.
 */
function getArtworkRequest(ctx: ProviderContext, ref: ArtworkRef, kind: ArtworkKind): Request {
  const slot = kind === 'backdrop' ? 'art' : 'thumb';
  const prefix = ctx.server.baseUrl.pathname.replace(/\/+$/, '');
  const url = new URL(
    `${ctx.server.baseUrl.origin}${prefix}/library/metadata/${encodeURIComponent(ref.providerItemId)}/${slot}/${encodeURIComponent(ref.tag)}`,
  );
  return new Request(url, {
    method: 'GET',
    redirect: 'manual',
    headers: ctx.secret.kind === 'token' ? { 'X-Plex-Token': ctx.secret.token } : {},
  });
}

async function probe(ctx: ProviderContext): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await ctx.fetch('/identity', {
      headers: plexHeaders(undefined),
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

export interface PlexProviderOptions {
  /** Set true only after B-3 verifies the managed-user token model. */
  playbackVerified: boolean;
}

export function createPlexProvider(options: PlexProviderOptions): MediaProvider {
  return {
    type: 'plex',
    validate,
    listLibraries,
    listItems,
    getItem,
    getArtworkRequest,
    probe,
    listCollections,
    playbackVerified: options.playbackVerified,
    // One token for every session: the managed user's own (`shared_restricted`, ADR-0013
    // fallback shape), so revocation is a no-op and the stop report ends the transcode.
    createSessionCredential: (ctx) => {
      if (!options.playbackVerified) {
        return Promise.reject(
          new ProviderError('UNSUPPORTED', 'Plex playback is not verified yet.', false),
        );
      }
      return issueManagedUserCredential(ctx);
    },
    revokeSessionCredential: () => Promise.resolve(),
    negotiatePlayback: (ctx, req) => {
      if (!options.playbackVerified) {
        return Promise.reject(
          new ProviderError('UNSUPPORTED', 'Plex playback is not verified yet.', false),
        );
      }
      return negotiate(ctx, req);
    },
    reportPlayback: report,
  };
}

/** Catalog only until B-3. */
export const plexProvider: MediaProvider = createPlexProvider({ playbackVerified: false });
