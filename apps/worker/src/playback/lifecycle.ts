/**
 * Playback credentials and the session lifecycle (BR-9, FR-PLAY-007, FR-PLAY-009, ADR-0013,
 * LLD-TOKEN "Playback session lifecycle").
 *
 * - Stream credentials are sealed with the vault (`session_cred`, bound to the session ID) in
 *   `playback_sessions.credential_envelope`, and set to NULL once the origin has revoked them.
 * - Revocation always reports `stop` to the origin first, then logs the token out, one after the
 *   other: Emby keeps serving HLS segments of a live transcode until the stop is reported.
 * - A revocation that fails stays `revoke_pending` and every sweep retries it; after 24 h it is
 *   abandoned with an operator-visible error log.
 * - `sweepPlaybackSessions` runs on the five-minute cron tick: it expires unstarted (5 min) and
 *   silent (4 h) sessions, retries pending revocations and recovers orphaned pool leases.
 */
import {
  clearCredential,
  endSession,
  getPlaybackServer,
  getProgress,
  listExpirable,
  listOrphanLeases,
  listRevokePending,
  releaseLease,
  type PlaybackServerRow,
  type SessionRow,
} from '../db/playback';
import { getCredentialRow } from '../db/servers';
import { ProviderError } from '../providers/errors';
import { buildProviderContext, getPlaybackProvider } from '../providers/registry';
import type {
  PlaybackProvider,
  ProviderContext,
  ServerSecret,
  SessionCredential,
} from '../providers/types';
import { decrypt, encrypt, loadKeyring, VaultError, type Keyring } from '../vault/vault';
import type { PlaybackDeps } from './deps';

/** The server cannot be used for playback right now (no adapter, no readable credentials). */
export class PlaybackUnavailableError extends Error {
  override name = 'PlaybackUnavailableError';
}

export interface OpenedPlayback {
  provider: PlaybackProvider;
  ctx: ProviderContext;
  keyring: Keyring;
}

async function keyringOf(deps: PlaybackDeps): Promise<Keyring> {
  try {
    return await loadKeyring(deps.env);
  } catch (err) {
    if (err instanceof VaultError) throw new PlaybackUnavailableError(`Vault: ${err.code}`);
    throw err;
  }
}

/**
 * A provider context for playback. Only the decrypted service secret is needed: stream
 * credentials are minted from it directly and never use the cached service token.
 */
export async function openPlayback(
  deps: PlaybackDeps,
  server: PlaybackServerRow,
): Promise<OpenedPlayback> {
  const provider = getPlaybackProvider(server.type);
  if (!provider) throw new PlaybackUnavailableError('No playback adapter for this server type.');
  const keyring = await keyringOf(deps);
  const row = await getCredentialRow(deps.db, server.id);
  if (!row) throw new PlaybackUnavailableError('No stored credentials.');
  let secret: ServerSecret | null = null;
  try {
    const parsed = JSON.parse(
      await decrypt(keyring, 'server_secret', server.id, row.secret_envelope),
    ) as Partial<ServerSecret> | null;
    if (parsed?.kind === 'password' && parsed.username && parsed.password) {
      secret = { kind: 'password', username: parsed.username, password: parsed.password };
    } else if (parsed?.kind === 'token' && parsed.token) {
      secret = { kind: 'token', token: parsed.token };
    }
  } catch (err) {
    if (!(err instanceof VaultError) && !(err instanceof SyntaxError)) throw err;
  }
  if (!secret) throw new PlaybackUnavailableError('Credentials unreadable.');
  const ctx = buildProviderContext({
    server: {
      id: server.id,
      type: server.type,
      baseUrl: new URL(server.base_url),
      originServerId: server.origin_server_id,
    },
    secret,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.config.originTimeoutMs,
    maxAttempts: 1,
  });
  return { provider, ctx, keyring };
}

export async function sealCredential(
  keyring: Keyring,
  sessionId: string,
  cred: SessionCredential,
): Promise<string> {
  return (await encrypt(keyring, 'session_cred', sessionId, JSON.stringify(cred))).envelope;
}

export async function openCredential(
  keyring: Keyring,
  sessionId: string,
  envelope: string,
): Promise<SessionCredential | null> {
  try {
    const parsed = JSON.parse(
      await decrypt(keyring, 'session_cred', sessionId, envelope),
    ) as Partial<SessionCredential> | null;
    if (!parsed || typeof parsed.token !== 'string' || typeof parsed.kind !== 'string') return null;
    return parsed as SessionCredential;
  } catch (err) {
    if (err instanceof VaultError || err instanceof SyntaxError) return null;
    throw err;
  }
}

export type RevokeOutcome = 'revoked' | 'pending' | 'abandoned' | 'nothing';

/**
 * Reports stop (when a stream was negotiated) and then revokes the session's credential. Never
 * throws for origin trouble: the outcome says whether the sweep has to try again.
 */
export async function revokeSession(
  deps: PlaybackDeps,
  session: SessionRow,
  positionMs?: number,
): Promise<RevokeOutcome> {
  const { db, logger } = deps;
  const log = { session_id: session.id, server_id: session.server_id };
  if (!session.credential_envelope) {
    await releaseLease(db, session.id);
    return 'nothing';
  }
  const server = session.server_id ? await getPlaybackServer(db, session.server_id) : null;
  if (!server) {
    // The server row is gone (its credentials with it); nothing can reach the origin any more.
    await clearCredential(db, session.id);
    await releaseLease(db, session.id);
    return 'nothing';
  }
  try {
    const opened = await openPlayback(deps, server);
    const cred = await openCredential(opened.keyring, session.id, session.credential_envelope);
    if (!cred) {
      logger.error('playback.credential_unreadable', log);
      await clearCredential(db, session.id);
      return 'abandoned';
    }
    if (session.provider_session_ref) {
      let position = positionMs;
      if (position === undefined && session.media_item_id) {
        position = (await getProgress(db, session.user_id, session.media_item_id))?.position_ms;
      }
      try {
        await opened.provider.reportPlayback(opened.ctx, cred, {
          type: 'stop',
          positionMs: position ?? 0,
          stream: {
            mode: session.mode,
            streamType: session.mode === 'direct_play' ? 'progressive' : 'hls',
            url: '',
            subtitleUrls: {},
            providerSessionRef: session.provider_session_ref,
          },
        });
      } catch (err) {
        // An origin that cannot take the stop cannot take the logout either: retry both later.
        // A rejected token (already dead) or a protocol hiccup does not block the revoke.
        if (err instanceof ProviderError && err.retryable) throw err;
        if (!(err instanceof ProviderError)) throw err;
        logger.warn('playback.stop_report_failed', { ...log, code: err.code });
      }
    }
    await opened.provider.revokeSessionCredential(opened.ctx, cred);
    await clearCredential(db, session.id);
    await releaseLease(db, session.id);
    logger.info('playback.credential_revoked', log);
    return 'revoked';
  } catch (err) {
    if (!(err instanceof ProviderError) && !(err instanceof PlaybackUnavailableError)) throw err;
    const ended = session.ended_at ?? session.authorized_at;
    if (deps.now() - ended > deps.config.revokeGiveUpMs) {
      // The pool slot (Emby) stays leased: re-auth on it could hand back the live token.
      logger.error('playback.revoke_abandoned', {
        ...log,
        code: err instanceof ProviderError ? err.code : 'UNAVAILABLE',
      });
      await clearCredential(db, session.id);
      return 'abandoned';
    }
    logger.warn('playback.revoke_failed', {
      ...log,
      code: err instanceof ProviderError ? err.code : 'UNAVAILABLE',
    });
    return 'pending';
  }
}

/** Recovers the token of a pool slot whose session row never got written, and logs it out. */
async function recoverOrphanLease(
  deps: PlaybackDeps,
  lease: { server_id: string; slot: number; session_id: string },
): Promise<boolean> {
  const server = await getPlaybackServer(deps.db, lease.server_id);
  if (!server) {
    await releaseLease(deps.db, lease.session_id);
    return true;
  }
  try {
    const { provider, ctx } = await openPlayback(deps, server);
    // Emby returns the same token for the same DeviceId until it is logged out (spike section 3).
    const cred = await provider.createSessionCredential(ctx, lease.session_id, {
      slot: lease.slot,
    });
    await provider.revokeSessionCredential(ctx, cred);
    await releaseLease(deps.db, lease.session_id);
    return true;
  } catch (err) {
    if (!(err instanceof ProviderError) && !(err instanceof PlaybackUnavailableError)) throw err;
    deps.logger.warn('playback.orphan_lease_failed', { server_id: lease.server_id });
    return false;
  }
}

export interface SweepResult {
  expired: number;
  revoked: number;
  pending: number;
  abandoned: number;
  orphansRecovered: number;
}

const SWEEP_BATCH = 100;

/** The BR-9 sweep (LLD-TOKEN), on the five-minute tick. */
export async function sweepPlaybackSessions(deps: PlaybackDeps): Promise<SweepResult> {
  const { db, config } = deps;
  const now = deps.now();
  const out: SweepResult = {
    expired: 0,
    revoked: 0,
    pending: 0,
    abandoned: 0,
    orphansRecovered: 0,
  };
  for (const s of await listExpirable(db, now, now - config.idleTimeoutMs, SWEEP_BATCH)) {
    const reason = s.status === 'authorized' ? 'not_started' : 'idle';
    if (await endSession(db, s.id, 'expired', reason, now, [s.status])) out.expired++;
  }
  for (const s of await listRevokePending(db, SWEEP_BATCH)) {
    const r = await revokeSession(deps, s);
    if (r === 'revoked' || r === 'nothing') out.revoked++;
    else if (r === 'pending') out.pending++;
    else out.abandoned++;
  }
  for (const lease of await listOrphanLeases(db, now - config.orphanLeaseMs, SWEEP_BATCH)) {
    if (await recoverOrphanLease(deps, lease)) out.orphansRecovered++;
  }
  return out;
}

/** Ends a live session and revokes its credential now (stop first, then logout). */
export async function endAndRevoke(
  deps: PlaybackDeps,
  session: SessionRow,
  to: 'ended' | 'expired' | 'failed',
  reason: string,
  positionMs?: number,
): Promise<RevokeOutcome> {
  await endSession(deps.db, session.id, to, reason, deps.now(), [session.status]);
  return revokeSession(deps, session, positionMs);
}
