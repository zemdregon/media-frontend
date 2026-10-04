/**
 * Everything sync needs from the outside world, injected so tests can drive the clock, the
 * jitter, the queue and the origin (SDD INV: injected clock and random, NFR-REL-002).
 */
import { getCredentialRow, type CredentialRow } from '../db/servers';
import { getServiceTokenEnvelope, setServiceTokenEnvelope, type SyncServerRow } from '../db/sync';
import { createLogger, type Logger } from '../platform/logger';
import type { Env } from '../platform/env';
import { ulid } from '../platform/ids';
import { buildProviderContext, getProvider } from '../providers/registry';
import type { MediaProvider, ProviderContext, ServerSecret } from '../providers/types';
import type { RotationTable } from '../vault/rotation';
import { decrypt, encrypt, loadKeyring, VaultError, type Keyring } from '../vault/vault';
import { getSyncConfig, type SyncConfig } from './config';

/** Typed queue messages (LLD-SYNC "Triggers and queues"). */
export type JobMessage =
  | { kind: 'sync'; runId: string; leaseToken?: string }
  /** Master-key rotation (LLD-TOKEN "Rotation"); the cursor lets a job continue across messages. */
  | { kind: 'reencrypt'; table?: RotationTable; after?: number };

export interface OpenedServer {
  provider: MediaProvider;
  ctx: ProviderContext;
}

export interface SyncDeps {
  db: D1Database;
  queue: { send(message: JobMessage): Promise<unknown> };
  config: SyncConfig;
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
  newId(): string;
  logger: Logger;
  /** The credential vault's keys (rotation job). */
  keyring(): Promise<Keyring>;
  /** Decrypts the credential, loads the cached service token and builds the provider context. */
  openServer(server: SyncServerRow): Promise<OpenedServer>;
}

/** Thrown when stored credentials cannot be used; ends the run `failed` (WF-2). */
export class CredentialsUnavailableError extends Error {
  override name = 'CredentialsUnavailableError';
}

async function openSecret(
  keyring: Keyring,
  serverId: string,
  cred: CredentialRow | null,
): Promise<ServerSecret> {
  if (!cred) throw new CredentialsUnavailableError('No stored credentials.');
  try {
    const plain = await decrypt(keyring, 'server_secret', serverId, cred.secret_envelope);
    const parsed = JSON.parse(plain) as Partial<ServerSecret> | null;
    if (parsed?.kind === 'password' && parsed.username && parsed.password) {
      return { kind: 'password', username: parsed.username, password: parsed.password };
    }
    if (parsed?.kind === 'token' && parsed.token) return { kind: 'token', token: parsed.token };
  } catch (err) {
    if (!(err instanceof VaultError)) throw err;
    throw new CredentialsUnavailableError(`Credentials unreadable (${err.code}).`);
  }
  throw new CredentialsUnavailableError('Credentials unreadable.');
}

/**
 * The encrypted service-token cache (LLD-TOKEN "Service-token caching"): the adapter's derived
 * access token is stored sealed in `server_credentials.service_token_envelope`, renewed only
 * when the origin answers 401, and an unreadable cache entry is simply ignored.
 */
export async function openProviderContext(
  env: Pick<Env, 'DB' | 'CREDENTIAL_KEYS' | 'CREDENTIAL_KEY_CURRENT'>,
  server: SyncServerRow,
  fetchImpl: typeof fetch,
  now: () => number,
  logger: Logger,
): Promise<OpenedServer> {
  const provider = getProvider(server.type);
  if (!provider) throw new CredentialsUnavailableError('No adapter for this server type.');
  let keyring: Keyring;
  try {
    keyring = await loadKeyring(env);
  } catch (err) {
    if (!(err instanceof VaultError)) throw err;
    throw new CredentialsUnavailableError(`Vault unavailable (${err.code}).`);
  }
  const secret = await openSecret(keyring, server.id, await getCredentialRow(env.DB, server.id));
  const ctx = buildProviderContext({
    server: {
      id: server.id,
      type: server.type,
      baseUrl: new URL(server.base_url),
      originServerId: server.origin_server_id,
    },
    secret,
    fetchImpl,
    // The orchestrator owns retry and backoff (sync/retry.ts), so the wrapper never multiplies it.
    maxAttempts: 1,
  });
  const envelope = await getServiceTokenEnvelope(env.DB, server.id);
  if (envelope) {
    try {
      ctx.serviceToken = await decrypt(keyring, 'service_token', server.id, envelope);
    } catch (err) {
      if (!(err instanceof VaultError)) throw err;
      logger.warn('sync.service_token_cache_unreadable', { server_id: server.id, code: err.code });
    }
  }
  ctx.onTokenRefresh = async (token) => {
    const sealed = await encrypt(keyring, 'service_token', server.id, token);
    await setServiceTokenEnvelope(env.DB, server.id, sealed.envelope, now());
  };
  return { provider, ctx };
}

export function createSyncDeps(
  env: Env,
  options: { fetchImpl?: typeof fetch; logger?: Logger } = {},
): SyncDeps {
  const logger = options.logger ?? createLogger();
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = () => Date.now();
  return {
    db: env.DB,
    queue: env.JOBS_QUEUE,
    config: getSyncConfig(env),
    now,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    random: Math.random,
    newId: () => ulid(),
    logger,
    keyring: () => loadKeyring(env),
    openServer: (server) => openProviderContext(env, server, fetchImpl, now, logger),
  };
}
