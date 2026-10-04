/**
 * Server registration (WF-1; FR-SRV-001 to FR-SRV-003, FR-SRV-007, DR-002, NFR-SEC-001,
 * NFR-SEC-005). Operator-only; every mutation writes its audit row in the same batch.
 *
 * Failure paths and their codes:
 * - `VALIDATION_FAILED`          the request is malformed, or names a provider with no adapter yet
 * - `INSECURE_ORIGIN_URL`        `http://` without the local flag (FR-SRV-007)
 * - `BLOCKED_ORIGIN_URL`         IP literal, internal host, userinfo or query (LLD-PROV)
 * - `SERVER_VALIDATION_FAILED`   one of tls, credentials, identity or version failed (FR-SRV-002);
 *                                `details.reason` is `admin_account` for an administrator
 * - `SERVER_ALREADY_REGISTERED`  the origin's server ID is already known (WF-1 failure path)
 * - `ORIGIN_*`                   the origin failed while discovering libraries
 * - `CREDENTIAL_KEY_MISSING`     the vault key is not configured; checked before any origin call
 */
import type { Context } from 'hono';
import type { z } from 'zod';
import type {
  Library,
  registerServerRequest,
  Server,
  ServerDetail,
  UpdateServerRequest,
  ValidationReport,
} from '@cinewren/shared';
import type { AppEnv } from '../api/context';
import { AppError } from '../api/errors';
import { currentUser } from '../auth/sessions';
import { auditStmt } from '../db/auth';
import {
  findServerByOriginId,
  getCredentialRow,
  getLibrary,
  getServer,
  insertCredentialStmt,
  insertServerStmt,
  listLibraries,
  listServers,
  markValidatedStmt,
  setLibraryEnabledStmt,
  updateServerStmt,
  upsertLibraryStmt,
  type LibraryRow,
  type ServerPatch,
  type ServerRow,
} from '../db/servers';
import { ulid } from '../platform/ids';
import { ProviderError } from '../providers/errors';
import { buildProviderContext, getProvider } from '../providers/registry';
import type { ProviderContext, ServerSecret, ValidationResult } from '../providers/types';
import { checkBaseUrl } from '../providers/url-policy';
import { decrypt, encrypt, loadKeyring, VaultError, type Keyring } from '../vault/vault';

// --- mapping helpers ---

function toServer(row: ServerRow): Server {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    baseUrl: row.base_url,
    priority: row.priority,
    status: row.status,
    version: row.version,
    lastValidatedAt: row.last_validated_at,
    keyVersion: row.key_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    libraryCount: row.library_count,
    enabledLibraryCount: row.enabled_library_count,
  };
}

function toLibrary(row: LibraryRow): Library {
  return {
    id: row.id,
    serverId: row.server_id,
    providerLibraryId: row.provider_library_id,
    name: row.name,
    kind: row.kind,
    enabled: row.enabled === 1,
  };
}

const notFound = () => new AppError('NOT_FOUND', 'Not found.');

/** Maps a provider failure on the request path to the LLD-ERR origin codes (no origin text). */
export function originError(err: unknown): AppError {
  if (!(err instanceof ProviderError)) throw err;
  switch (err.code) {
    case 'UNAVAILABLE':
      return new AppError('ORIGIN_UNAVAILABLE', 'The server could not be reached.');
    case 'TIMEOUT':
      return new AppError('ORIGIN_TIMEOUT', 'The server did not answer in time.');
    case 'REDIRECT_REFUSED':
      return new AppError(
        'ORIGIN_REDIRECT_REFUSED',
        'The server tried to send Cinewren to a different address, which is not allowed.',
      );
    default:
      return new AppError('ORIGIN_PROTOCOL', 'The server sent a response Cinewren did not expect.');
  }
}

const FAILURE_MESSAGES = {
  tls: 'Cinewren could not reach the server over HTTPS. Check the address and that its certificate is valid.',
  credentials: 'The server did not accept the service account.',
  identity: 'The address does not belong to the server Cinewren expected.',
  version: 'The server version is not supported.',
} as const;

const REASON_MESSAGES: Record<string, string> = {
  invalid_credentials: 'The server rejected the username or password.',
  admin_account:
    'That account is an administrator. Create a dedicated non-admin account for Cinewren and use it instead.',
  admin_status_unknown:
    'Cinewren could not confirm that this account is not an administrator, so it was refused.',
  account_disabled: 'That account is disabled on the server.',
  unsupported_credential: 'This server type needs a username and password.',
  not_a_server: 'The address did not answer like a server of this type.',
  server_id_mismatch: 'This address belongs to a different server than the one registered.',
  redirect_refused:
    'The server tried to send Cinewren to a different address, which is not allowed.',
  timeout: 'The server did not answer in time.',
};

function validationError(result: Extract<ValidationResult, { ok: false }>): AppError {
  const base = FAILURE_MESSAGES[result.check];
  const message =
    result.reason === 'version_too_old' && result.minimumVersion
      ? `Version ${result.minimumVersion} or later is required.`
      : (REASON_MESSAGES[result.reason] ?? base);
  return new AppError('SERVER_VALIDATION_FAILED', message, {
    check: result.check,
    reason: result.reason,
    ...(result.minimumVersion ? { minimumVersion: result.minimumVersion } : {}),
  });
}

async function keyringOrFail(c: Context<AppEnv>): Promise<Keyring> {
  try {
    return await loadKeyring(c.env);
  } catch (err) {
    if (!(err instanceof VaultError)) throw err;
    c.get('logger').error('vault.unavailable', { code: err.code });
    throw new AppError(
      'CREDENTIAL_KEY_MISSING',
      'The credential encryption key is not configured correctly. See the setup guide.',
    );
  }
}

async function openSecret(
  c: Context<AppEnv>,
  keyring: Keyring,
  row: ServerRow,
): Promise<ServerSecret> {
  const cred = await getCredentialRow(c.env.DB, row.id);
  if (!cred) throw notFound();
  try {
    const plain = await decrypt(keyring, 'server_secret', row.id, cred.secret_envelope);
    const parsed = JSON.parse(plain) as Partial<ServerSecret> | null;
    if (parsed?.kind === 'password' && parsed.username && parsed.password) {
      return { kind: 'password', username: parsed.username, password: parsed.password };
    }
    if (parsed?.kind === 'token' && parsed.token) return { kind: 'token', token: parsed.token };
    throw new VaultError('ENVELOPE_INVALID', 'The stored credential is unreadable.');
  } catch (err) {
    if (!(err instanceof VaultError)) throw err;
    c.get('logger').error('vault.decrypt_failed', { code: err.code, server_id: row.id });
    throw new AppError(
      'CREDENTIAL_KEY_MISSING',
      "This server's credentials can no longer be read. Re-enter them.",
    );
  }
}

function contextFor(
  c: Context<AppEnv>,
  server: { id: string; type: ServerRow['type']; baseUrl: URL; originServerId?: string },
  secret: ServerSecret,
): ProviderContext {
  return buildProviderContext({ server, secret, fetchImpl: c.get('originFetch') });
}

function parseBaseUrl(c: Context<AppEnv>, raw: string): URL {
  const config = c.get('config');
  if (c.env.ALLOW_INSECURE_ORIGINS === 'true' && !config.local) {
    c.get('logger').error('config.insecure_origins_ignored', { environment: c.env.ENVIRONMENT });
  }
  const result = checkBaseUrl(raw, {
    local: config.local,
    allowInsecure: config.allowInsecureOrigins,
  });
  if (result.ok) return result.baseUrl;
  switch (result.code) {
    case 'VALIDATION_FAILED':
      throw new AppError(
        'VALIDATION_FAILED',
        'Enter a full web address such as https://media.example.com.',
        {
          fields: ['baseUrl'],
        },
      );
    case 'INSECURE_ORIGIN_URL':
      throw new AppError(
        'INSECURE_ORIGIN_URL',
        'The address must start with https://. Plain http:// is not allowed.',
      );
    case 'BLOCKED_ORIGIN_URL':
      throw new AppError(
        'BLOCKED_ORIGIN_URL',
        "That address is not allowed. Use the server's public https:// hostname, without a username, query or IP address.",
        { reason: result.reason },
      );
  }
}

async function discover(
  c: Context<AppEnv>,
  ctx: ProviderContext,
  serverId: string,
): Promise<D1PreparedStatement[]> {
  const provider = getProvider(ctx.server.type);
  if (!provider)
    throw new AppError('VALIDATION_FAILED', 'Unsupported server type.', { fields: ['type'] });
  try {
    const libraries = await provider.listLibraries(ctx);
    return libraries.map((l) =>
      upsertLibraryStmt(c.env.DB, {
        id: ulid(),
        serverId,
        providerLibraryId: l.providerLibraryId,
        name: l.name,
        kind: l.kind,
      }),
    );
  } catch (err) {
    throw originError(err);
  }
}

async function detail(c: Context<AppEnv>, id: string): Promise<ServerDetail> {
  const row = await getServer(c.env.DB, id);
  if (!row) throw notFound();
  return { ...toServer(row), libraries: (await listLibraries(c.env.DB, id)).map(toLibrary) };
}

// --- operations ---

export async function register(
  c: Context<AppEnv>,
  body: z.output<typeof registerServerRequest>,
): Promise<ServerDetail> {
  const db = c.env.DB;
  const operator = currentUser(c);
  const provider = getProvider(body.type);
  if (!provider) {
    throw new AppError('VALIDATION_FAILED', 'That server type is not supported yet.', {
      fields: ['type'],
    });
  }
  if (!('username' in body.credentials)) {
    throw new AppError('VALIDATION_FAILED', 'This server type needs a username and password.', {
      fields: ['credentials'],
    });
  }
  const secret: ServerSecret = {
    kind: 'password',
    username: body.credentials.username,
    password: body.credentials.password,
  };
  const baseUrl = parseBaseUrl(c, body.baseUrl);
  // Fail before any credential leaves for the origin if it could not be stored afterwards.
  const keyring = await keyringOrFail(c);

  const id = ulid();
  const ctx = contextFor(c, { id, type: body.type, baseUrl }, secret);
  let result: ValidationResult;
  try {
    result = await provider.validate(ctx);
  } catch (err) {
    throw originError(err);
  }
  if (!result.ok) {
    c.get('logger').info('server.validation_failed', {
      check: result.check,
      reason: result.reason,
    });
    throw validationError(result); // nothing is saved (FR-SRV-002)
  }
  const existing = await findServerByOriginId(db, result.originServerId);
  if (existing) throw duplicate(existing);

  const now = Date.now();
  const sealed = await encrypt(keyring, 'server_secret', id, JSON.stringify(secret));
  try {
    await db.batch([
      insertServerStmt(db, {
        id,
        type: body.type,
        name: body.name,
        baseUrl: baseUrl.href.replace(/\/+$/, ''),
        originServerId: result.originServerId,
        version: result.version,
        priority: body.priority ?? 0,
        now,
      }),
      insertCredentialStmt(db, {
        serverId: id,
        keyVersion: sealed.keyVersion,
        envelope: sealed.envelope,
        now,
      }),
      auditStmt(db, {
        id: ulid(),
        now,
        actorUserId: operator.userId,
        action: 'server.register',
        targetType: 'server',
        targetId: id,
        details: { type: body.type, keyVersion: sealed.keyVersion },
        requestId: c.get('requestId'),
      }),
    ]);
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      const raced = await findServerByOriginId(db, result.originServerId);
      if (raced) throw duplicate(raced);
    }
    throw err;
  }

  // WF-1 steps 5 and 6: discover libraries, then the server becomes active. If the origin fails
  // here the server stays `pending_validation`; POST .../validate retries the discovery.
  let libraryStmts: D1PreparedStatement[];
  try {
    libraryStmts = await discover(c, ctx, id);
  } catch (err) {
    if (err instanceof AppError) {
      throw new AppError(
        err.code,
        `${err.message} The server was saved but is not active yet; validate it again to retry.`,
        {
          serverId: id,
        },
      );
    }
    throw err;
  }
  await db.batch([...libraryStmts, markValidatedStmt(db, id, result.version, Date.now(), true)]);
  return detail(c, id);
}

function duplicate(existing: { id: string; name: string }): AppError {
  return new AppError(
    'SERVER_ALREADY_REGISTERED',
    `This server is already registered as "${existing.name}".`,
    {
      existing: { id: existing.id, name: existing.name },
    },
  );
}

export async function list(c: Context<AppEnv>): Promise<Server[]> {
  return (await listServers(c.env.DB)).map(toServer);
}

export async function get(c: Context<AppEnv>, id: string): Promise<ServerDetail> {
  return detail(c, id);
}

export async function libraries(c: Context<AppEnv>, id: string): Promise<Library[]> {
  if (!(await getServer(c.env.DB, id))) throw notFound();
  return (await listLibraries(c.env.DB, id)).map(toLibrary);
}

/** Re-runs the four checks (identity must equal the stored server ID) and refreshes libraries. */
export async function validate(c: Context<AppEnv>, id: string): Promise<ValidationReport> {
  const row = await getServer(c.env.DB, id);
  if (!row) throw notFound();
  const keyring = await keyringOrFail(c);
  const result = await revalidate(c, keyring, row, new URL(row.base_url));
  const activate = row.status === 'pending_validation';
  const ctx = result.ctx;
  const libraryStmts = await discover(c, ctx, id);
  const now = Date.now();
  await c.env.DB.batch([
    ...libraryStmts,
    markValidatedStmt(c.env.DB, id, result.version, now, activate),
    auditStmt(c.env.DB, {
      id: ulid(),
      now,
      actorUserId: currentUser(c).userId,
      action: 'server.validate',
      targetType: 'server',
      targetId: id,
      details: { activated: activate },
      requestId: c.get('requestId'),
    }),
  ]);
  return {
    ok: true,
    checks: { tls: 'passed', credentials: 'passed', identity: 'passed', version: 'passed' },
    version: result.version,
  };
}

async function revalidate(
  c: Context<AppEnv>,
  keyring: Keyring,
  row: ServerRow,
  baseUrl: URL,
): Promise<{ ctx: ProviderContext; version: string }> {
  const provider = getProvider(row.type);
  if (!provider)
    throw new AppError('VALIDATION_FAILED', 'Unsupported server type.', { fields: ['type'] });
  const secret = await openSecret(c, keyring, row);
  const ctx = contextFor(
    c,
    { id: row.id, type: row.type, baseUrl, originServerId: row.origin_server_id },
    secret,
  );
  let result: ValidationResult;
  try {
    result = await provider.validate(ctx);
  } catch (err) {
    throw originError(err);
  }
  if (!result.ok) throw validationError(result);
  return { ctx, version: result.version };
}

export async function update(
  c: Context<AppEnv>,
  id: string,
  body: UpdateServerRequest,
): Promise<Server> {
  const db = c.env.DB;
  const row = await getServer(db, id);
  if (!row) throw notFound();
  const operator = currentUser(c);

  const patch: ServerPatch = {};
  const audits: { action: string; details: Record<string, unknown> }[] = [];
  let needsRevalidation = false;
  let newBase = new URL(row.base_url);

  if (body.baseUrl !== undefined) {
    newBase = parseBaseUrl(c, body.baseUrl);
    const href = newBase.href.replace(/\/+$/, '');
    if (href !== row.base_url) {
      patch.baseUrl = href;
      needsRevalidation = true; // WF-1: a URL change re-runs the checks
    }
  }
  if (body.name !== undefined && body.name !== row.name) patch.name = body.name;
  if (body.priority !== undefined && body.priority !== row.priority) patch.priority = body.priority;

  const wasDisabled = row.status === 'disabled';
  if (body.enabled === true && wasDisabled) {
    needsRevalidation = true; // re-enable re-validates (LLD-API PATCH)
    patch.status = 'active';
    audits.push({ action: 'server.enable', details: {} });
  } else if (body.enabled === false && !wasDisabled) {
    patch.status = 'disabled';
    audits.push({ action: 'server.disable', details: {} });
  }
  const changed = Object.keys(patch).filter((k) => k !== 'status');
  if (changed.length > 0) {
    audits.push({ action: 'server.update', details: { fields: changed } });
  }
  if (audits.length === 0) return toServer(row); // nothing changed: idempotent, not audited

  let validated: { version: string } | null = null;
  if (needsRevalidation) {
    const keyring = await keyringOrFail(c);
    validated = await revalidate(c, keyring, row, newBase); // throws 422: nothing is changed
  }
  const now = Date.now();
  const statements = [
    updateServerStmt(db, id, patch, now),
    ...(validated ? [markValidatedStmt(db, id, validated.version, now, false)] : []),
    ...audits.map((a) =>
      auditStmt(db, {
        id: ulid(),
        now,
        actorUserId: operator.userId,
        action: a.action,
        targetType: 'server',
        targetId: id,
        details: a.details,
        requestId: c.get('requestId'),
      }),
    ),
  ];
  await db.batch(statements);
  const fresh = await getServer(db, id);
  if (!fresh) throw notFound();
  return toServer(fresh);
}

export async function setLibraryEnabled(
  c: Context<AppEnv>,
  id: string,
  enabled: boolean,
): Promise<Library> {
  const db = c.env.DB;
  const row = await getLibrary(db, id);
  if (!row) throw notFound();
  if ((row.enabled === 1) === enabled) return toLibrary(row); // idempotent, not audited
  const now = Date.now();
  await db.batch([
    setLibraryEnabledStmt(db, id, enabled),
    auditStmt(db, {
      id: ulid(),
      now,
      actorUserId: currentUser(c).userId,
      action: enabled ? 'library.enable' : 'library.disable',
      targetType: 'library',
      targetId: id,
      details: { serverId: row.server_id },
      requestId: c.get('requestId'),
    }),
  ]);
  const fresh = await getLibrary(db, id);
  if (!fresh) throw notFound();
  return toLibrary(fresh);
}
