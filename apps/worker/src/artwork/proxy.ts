/**
 * Artwork proxy with edge cache (T2.5; FR-CAT-009, FR-CAT-006, ADR-0012, NFR-SEC-001,
 * NFR-SEC-005). The order is fixed:
 *
 *  1. Authorize: the candidate query joins the BR-1 predicate, so an entity the caller may not see
 *     has no candidates and answers 404, exactly like an unknown ID. This runs before the cache
 *     is consulted, so the cache is only a speed layer and a cached image is never served to
 *     someone who may not see its title.
 *  2. Cache: keyed by entity, slot and artwork tag, never by user.
 *  3. Origin: fetched through the host-pinned origin fetch with the server's own credential. The
 *     response carries only image bytes, a content type and cache headers; no origin URL, header
 *     or credential is copied into it.
 *
 * No resizing in v1 (ADR-0012). Content types are allowlisted and size is capped.
 */
import type { Context } from 'hono';
import type { ArtworkSlot } from '@cinewren/shared';
import type { AppEnv } from '../api/context';
import { AppError } from '../api/errors';
import { viewerOf } from '../catalog/service';
import {
  entityArtworkCandidates,
  itemArtworkCandidates,
  type ArtworkCandidate,
} from '../db/catalog';
import { ProviderError } from '../providers/errors';
import { getProvider } from '../providers/registry';
import { originError, providerContextForServer } from '../servers/service';

export const ARTWORK_MAX_BYTES = 10 * 1024 * 1024;
/** One week; artwork is addressed by its tag, so a changed image has a new URL (ADR-0012). */
export const ARTWORK_MAX_AGE_S = 604_800;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const MAX_ATTEMPTS = 3;

export type ArtworkTarget =
  { kind: 'item'; id: string; slot: ArtworkSlot } | { kind: 'person' | 'collection'; id: string };

const notFound = () => new AppError('NOT_FOUND', 'Not found.');

function browserResponse(body: BodyInit | null, contentType: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      // Private: the browser may keep it, a shared cache may not (the check is per user).
      'Cache-Control': `private, max-age=${ARTWORK_MAX_AGE_S}, immutable`,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

async function readCapped(res: Response): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > ARTWORK_MAX_BYTES) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = (await reader.read()) as ReadableStreamReadResult<Uint8Array>;
    if (done) break;
    size += value.byteLength;
    if (size > ARTWORK_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

interface Fetched {
  bytes: Uint8Array;
  contentType: string;
}

/** Tries one candidate; returns null when this source cannot supply the image. */
async function fetchFromOrigin(
  c: Context<AppEnv>,
  cand: ArtworkCandidate,
  slot: ArtworkSlot,
): Promise<{ image: Fetched | null; notFound: boolean }> {
  let resolved;
  try {
    resolved = await providerContextForServer(c, cand.server_id);
  } catch (err) {
    if (err instanceof AppError) return { image: null, notFound: false };
    throw err;
  }
  const provider = resolved ? getProvider(resolved.type) : null;
  if (!resolved || !provider) return { image: null, notFound: false };
  const { ctx } = resolved;
  try {
    const request = provider.getArtworkRequest(
      ctx,
      { providerItemId: cand.provider_id, tag: cand.tag },
      slot,
    );
    const target = new URL(request.url);
    const base = ctx.server.baseUrl;
    if (target.origin !== base.origin) return { image: null, notFound: false };
    const prefix = base.pathname.replace(/\/+$/, '');
    const path = `${target.pathname.slice(prefix.length)}${target.search}`;
    const res = await ctx.fetch(path, { headers: Object.fromEntries(request.headers) });
    if (!res.ok) {
      await res.body?.cancel();
      return { image: null, notFound: res.status === 404 };
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (!contentType || !ALLOWED_TYPES.has(contentType)) {
      await res.body?.cancel();
      return { image: null, notFound: false };
    }
    const bytes = await readCapped(res);
    return bytes
      ? { image: { bytes, contentType }, notFound: false }
      : { image: null, notFound: false };
  } catch (err) {
    if (err instanceof ProviderError) {
      c.get('logger').warn('artwork.origin_failed', { server_id: cand.server_id, code: err.code });
      return { image: null, notFound: err.code === 'NOT_FOUND' };
    }
    throw err;
  }
}

export async function serveArtwork(
  c: Context<AppEnv>,
  target: ArtworkTarget,
  requestedTag: string | undefined,
): Promise<Response> {
  const viewer = viewerOf(c);
  const slot: ArtworkSlot = target.kind === 'item' ? target.slot : 'poster';
  const candidates =
    target.kind === 'item'
      ? await itemArtworkCandidates(c.env.DB, viewer, target.id, slot)
      : await entityArtworkCandidates(c.env.DB, viewer, target.kind, target.id);
  if (candidates.length === 0) throw notFound(); // not visible, unknown, or no such image

  // Honour the requested tag only when it names one of the caller's own candidates.
  const preferred = candidates.find((cand) => cand.tag === requestedTag) ?? candidates[0];
  if (!preferred) throw notFound();
  const ordered = [preferred, ...candidates.filter((cand) => cand !== preferred)];

  // The key names the source server as well as the tag, and an image is stored only under the
  // key of the candidate that supplied it: two copies whose tags happen to be equal (Plex tags
  // are timestamps) never share an entry, so a caller is only ever served bytes from a source
  // they may see (T5.8 SR-05, ADR-0012).
  const cache = caches.default;
  const appOrigin = c.get('config').appOrigin;
  const keyOf = (cand: ArtworkCandidate) =>
    new Request(
      `${appOrigin}/__artwork/${target.kind}/${encodeURIComponent(target.id)}/${slot}/${encodeURIComponent(cand.server_id)}/${encodeURIComponent(cand.tag)}`,
    );
  const tries = ordered.slice(0, MAX_ATTEMPTS);
  for (const cand of tries) {
    const hit = await cache.match(keyOf(cand));
    if (hit) {
      return browserResponse(
        hit.body,
        hit.headers.get('content-type') ?? 'application/octet-stream',
      );
    }
  }

  let sawNotFound = false;
  for (const cand of tries) {
    const key = keyOf(cand);
    const { image, notFound: missing } = await fetchFromOrigin(c, cand, slot);
    sawNotFound ||= missing;
    if (!image) continue;
    await cache.put(
      key,
      new Response(image.bytes, {
        headers: {
          'Content-Type': image.contentType,
          'Cache-Control': `public, max-age=${ARTWORK_MAX_AGE_S}`,
        },
      }),
    );
    return browserResponse(image.bytes, image.contentType);
  }
  if (sawNotFound) throw notFound();
  throw originError(new ProviderError('UNAVAILABLE', 'Artwork is unavailable.'));
}
