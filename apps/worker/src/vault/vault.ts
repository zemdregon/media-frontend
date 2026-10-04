/**
 * Credential vault (DR-002, NFR-SEC-001, ADR-0008, LLD-TOKEN "Envelope format").
 *
 *   cw1.<keyVersion>.<base64url(iv: 12 random bytes)>.<base64url(AES-256-GCM ciphertext || tag)>
 *   AAD = "cinewren|" + purpose + "|" + rowId
 *
 * The AAD binds a ciphertext to its row and purpose, so an envelope copied into another row, or
 * used for another purpose, fails to decrypt. Keys come from `CREDENTIAL_KEYS` (a JSON object
 * mapping a key version to a base64 32-byte key) and are imported once per isolate as
 * non-extractable CryptoKeys. Plaintext exists only in local variables; errors never include
 * plaintext, key material or ciphertext.
 */

export type VaultPurpose = 'server_secret' | 'service_token' | 'session_cred' | 'cursor';

export type VaultErrorCode =
  /** `CREDENTIAL_KEYS` or `CREDENTIAL_KEY_CURRENT` is unset or malformed. */
  | 'CREDENTIAL_KEYS_INVALID'
  /** The envelope names a key version that is not in `CREDENTIAL_KEYS` (DR-002 key loss). */
  | 'CREDENTIAL_KEY_MISSING'
  /** Wrong key, tampered data, or an envelope used for another row or purpose. */
  | 'DECRYPT_FAILED'
  | 'ENVELOPE_INVALID';

export class VaultError extends Error {
  override name = 'VaultError';
  constructor(
    readonly code: VaultErrorCode,
    message: string,
    readonly keyVersion?: number,
  ) {
    super(message);
  }
}

export interface Keyring {
  /** The version used for new encryptions. */
  readonly current: number;
  readonly keys: ReadonlyMap<number, CryptoKey>;
}

export interface KeyringEnv {
  CREDENTIAL_KEYS?: string | undefined;
  CREDENTIAL_KEY_CURRENT?: string | undefined;
}

const ENVELOPE = /^cw1\.(\d{1,9})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded = text.replaceAll('-', '+').replaceAll('_', '/');
    const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const invalidKeys = (why: string) => new VaultError('CREDENTIAL_KEYS_INVALID', why);

async function importKeyring(env: KeyringEnv): Promise<Keyring> {
  if (!env.CREDENTIAL_KEYS) throw invalidKeys('CREDENTIAL_KEYS is not set.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.CREDENTIAL_KEYS);
  } catch {
    throw invalidKeys('CREDENTIAL_KEYS is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidKeys('CREDENTIAL_KEYS must be a JSON object of key version to key.');
  }
  const keys = new Map<number, CryptoKey>();
  for (const [version, value] of Object.entries(parsed)) {
    if (!/^[1-9]\d{0,8}$/.test(version))
      throw invalidKeys('Key versions must be positive integers.');
    const raw = typeof value === 'string' ? fromBase64Url(value) : null;
    if (raw?.length !== KEY_BYTES) throw invalidKeys('Every key must be 32 bytes, base64 encoded.');
    keys.set(
      Number(version),
      await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
    );
  }
  const current = Number(env.CREDENTIAL_KEY_CURRENT);
  if (!Number.isInteger(current) || !keys.has(current)) {
    throw invalidKeys('CREDENTIAL_KEY_CURRENT must name a version present in CREDENTIAL_KEYS.');
  }
  return { current, keys };
}

const cache = new Map<string, Promise<Keyring>>();

/**
 * Parses and imports the keys once per isolate. Fails closed: a missing, malformed or
 * inconsistent configuration throws `CREDENTIAL_KEYS_INVALID` (TDD section 4).
 */
export function loadKeyring(env: KeyringEnv): Promise<Keyring> {
  const id = `${env.CREDENTIAL_KEY_CURRENT ?? ''}|${env.CREDENTIAL_KEYS ?? ''}`;
  let pending = cache.get(id);
  if (!pending) {
    pending = importKeyring(env);
    cache.set(id, pending);
    pending.catch(() => cache.delete(id));
  }
  return pending;
}

const aad = (purpose: VaultPurpose, rowId: string) =>
  encoder.encode(`cinewren|${purpose}|${rowId}`);

/** The key version an envelope was written with, or null when it is not an envelope. */
export function envelopeKeyVersion(envelope: string): number | null {
  const match = ENVELOPE.exec(envelope);
  return match?.[1] ? Number(match[1]) : null;
}

export interface Sealed {
  envelope: string;
  keyVersion: number;
}

/** Encrypts `plaintext` under the current key with a fresh random IV. */
export async function encrypt(
  keyring: Keyring,
  purpose: VaultPurpose,
  rowId: string,
  plaintext: string,
): Promise<Sealed> {
  const key = keyring.keys.get(keyring.current);
  if (!key) throw invalidKeys('The current key is not loaded.');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(purpose, rowId), tagLength: 128 },
    key,
    encoder.encode(plaintext),
  );
  const envelope = `cw1.${keyring.current}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
  return { envelope, keyVersion: keyring.current };
}

/** Decrypts an envelope for `purpose` and `rowId`. */
export async function decrypt(
  keyring: Keyring,
  purpose: VaultPurpose,
  rowId: string,
  envelope: string,
): Promise<string> {
  const match = ENVELOPE.exec(envelope);
  const version = Number(match?.[1]);
  const iv = match?.[2] ? fromBase64Url(match[2]) : null;
  const data = match?.[3] ? fromBase64Url(match[3]) : null;
  if (!match || iv?.length !== IV_BYTES || !data || data.length < 16) {
    throw new VaultError('ENVELOPE_INVALID', 'The stored credential is not a valid envelope.');
  }
  const key = keyring.keys.get(version);
  if (!key) {
    throw new VaultError(
      'CREDENTIAL_KEY_MISSING',
      'The key that protects this credential is not configured.',
      version,
    );
  }
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(purpose, rowId), tagLength: 128 },
      key,
      data,
    );
    return decoder.decode(plain);
  } catch {
    throw new VaultError(
      'DECRYPT_FAILED',
      'The stored credential could not be decrypted.',
      version,
    );
  }
}

/** Decrypts with the version the envelope names and seals again under the current key. */
export async function reencrypt(
  keyring: Keyring,
  purpose: VaultPurpose,
  rowId: string,
  envelope: string,
): Promise<Sealed> {
  return encrypt(keyring, purpose, rowId, await decrypt(keyring, purpose, rowId, envelope));
}
