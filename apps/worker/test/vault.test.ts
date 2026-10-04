// T1.3: credential vault (DR-002, NFR-SEC-001, ADR-0008, LLD-TOKEN). The API and log hygiene
// tests (ciphertext and plaintext never leave the Worker) are in servers.test.ts.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { reencryptServerCredentials } from '../src/vault/rotation';
import {
  decrypt,
  encrypt,
  envelopeKeyVersion,
  loadKeyring,
  reencrypt,
  VaultError,
  type Keyring,
} from '../src/vault/vault';

const key = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));
const keysJson = (versions: Record<string, number>) =>
  JSON.stringify(Object.fromEntries(Object.entries(versions).map(([v, b]) => [v, key(b)])));

async function ring(versions: Record<string, number>, current: number): Promise<Keyring> {
  return loadKeyring({
    CREDENTIAL_KEYS: keysJson(versions),
    CREDENTIAL_KEY_CURRENT: String(current),
  });
}

const SECRET = JSON.stringify({ kind: 'password', username: 'svc', password: 'p@ss w0rd/é' });

describe('envelope format (LLD-TOKEN)', () => {
  it('round-trips and uses cw1.<version>.<iv>.<ciphertext>', async () => {
    const keyring = await ring({ '1': 1 }, 1);
    const sealed = await encrypt(keyring, 'server_secret', 'srv1', SECRET);
    expect(sealed.envelope).toMatch(/^cw1\.1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed.keyVersion).toBe(1);
    expect(envelopeKeyVersion(sealed.envelope)).toBe(1);
    expect(await decrypt(keyring, 'server_secret', 'srv1', sealed.envelope)).toBe(SECRET);
  });

  it('never contains the plaintext, and uses a fresh IV for every encryption', async () => {
    const keyring = await ring({ '1': 1 }, 1);
    const a = await encrypt(keyring, 'server_secret', 'srv1', SECRET);
    const b = await encrypt(keyring, 'server_secret', 'srv1', SECRET);
    expect(a.envelope).not.toBe(b.envelope);
    expect(a.envelope.split('.')[2]).not.toBe(b.envelope.split('.')[2]);
    expect(a.envelope).not.toContain('p@ss');
    expect(a.envelope).not.toContain(btoa('p@ss'));
  });

  it('is bound to its row and purpose by the AAD', async () => {
    const keyring = await ring({ '1': 1 }, 1);
    const { envelope } = await encrypt(keyring, 'server_secret', 'srv1', SECRET);
    await expect(decrypt(keyring, 'server_secret', 'srv2', envelope)).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
    await expect(decrypt(keyring, 'service_token', 'srv1', envelope)).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
  });

  it('detects tampering with the ciphertext', async () => {
    const keyring = await ring({ '1': 1 }, 1);
    const { envelope } = await encrypt(keyring, 'server_secret', 'srv1', SECRET);
    const parts = envelope.split('.');
    const body = parts[3] ?? '';
    parts[3] = (body.startsWith('A') ? 'B' : 'A') + body.slice(1);
    await expect(decrypt(keyring, 'server_secret', 'srv1', parts.join('.'))).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
  });

  it.each(['', 'cw1', 'cw2.1.aaaa.bbbb', 'cw1.1.short.AAAA', 'plain text secret'])(
    'rejects the malformed envelope %j',
    async (bad) => {
      const keyring = await ring({ '1': 1 }, 1);
      await expect(decrypt(keyring, 'server_secret', 'srv1', bad)).rejects.toMatchObject({
        code: 'ENVELOPE_INVALID',
      });
    },
  );
});

describe('keys', () => {
  it('fails to decrypt with the wrong key', async () => {
    const sealed = await encrypt(await ring({ '1': 1 }, 1), 'server_secret', 'srv1', SECRET);
    const wrong = await ring({ '1': 9 }, 1); // same version, different key material
    await expect(decrypt(wrong, 'server_secret', 'srv1', sealed.envelope)).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
  });

  it('reports CREDENTIAL_KEY_MISSING when the envelope names a version that is gone (key loss)', async () => {
    const sealed = await encrypt(await ring({ '1': 1 }, 1), 'server_secret', 'srv1', SECRET);
    const rotated = await ring({ '2': 2 }, 2);
    const err = await decrypt(rotated, 'server_secret', 'srv1', sealed.envelope).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VaultError);
    expect(err).toMatchObject({ code: 'CREDENTIAL_KEY_MISSING', keyVersion: 1 });
  });

  it('encrypts new data under CREDENTIAL_KEY_CURRENT', async () => {
    const keyring = await ring({ '1': 1, '2': 2 }, 2);
    expect((await encrypt(keyring, 'cursor', 'x', 'v')).keyVersion).toBe(2);
  });

  it('keeps the keys non-extractable', async () => {
    const keyring = await ring({ '1': 1 }, 1);
    const k = keyring.keys.get(1);
    expect(k?.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', k as CryptoKey)).rejects.toThrow();
  });

  it.each([
    ['unset', undefined, '1'],
    ['not JSON', 'not json', '1'],
    ['an array', '[]', '1'],
    ['a 16-byte key', JSON.stringify({ '1': btoa('0123456789abcdef') }), '1'],
    ['a non-numeric version', JSON.stringify({ v1: key(1) }), '1'],
    ['a current version that is missing', JSON.stringify({ '1': key(1) }), '2'],
    ['no current version', JSON.stringify({ '1': key(1) }), undefined],
  ])('fails closed when CREDENTIAL_KEYS is %s', async (_name, keys, current) => {
    const err = await loadKeyring({ CREDENTIAL_KEYS: keys, CREDENTIAL_KEY_CURRENT: current }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ name: 'VaultError', code: 'CREDENTIAL_KEYS_INVALID' });
    // The message must not echo key material.
    expect((err as Error).message).not.toContain(key(1));
  });

  it('loads the test environment keys', async () => {
    const keyring = await loadKeyring(env);
    expect([...keyring.keys.keys()]).toEqual([1, 2]);
    expect(keyring.current).toBe(1);
  });
});

describe('rotation (WF-11)', () => {
  const db = env.DB;
  beforeEach(async () => {
    await db.batch([db.prepare('DELETE FROM servers')]);
  });

  async function insert(id: string, keyring: Keyring, plaintext: string, withToken = false) {
    const now = Date.now();
    const secret = await encrypt(keyring, 'server_secret', id, plaintext);
    const token = withToken ? await encrypt(keyring, 'service_token', id, 'cached-token') : null;
    await db.batch([
      db
        .prepare(
          `INSERT INTO servers (id, type, name, base_url, origin_server_id, status, created_at, updated_at)
           VALUES (?, 'jellyfin', ?, ?, ?, 'active', ?, ?)`,
        )
        .bind(id, id, `https://${id}.example.test`, `origin-${id}`, now, now),
      db
        .prepare(
          `INSERT INTO server_credentials (server_id, key_version, secret_envelope, service_token_envelope, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(id, secret.keyVersion, secret.envelope, token?.envelope ?? null, now),
    ]);
  }

  const row = (id: string) =>
    db
      .prepare(
        'SELECT key_version, secret_envelope, service_token_envelope FROM server_credentials WHERE server_id = ?',
      )
      .bind(id)
      .first<{
        key_version: number;
        secret_envelope: string;
        service_token_envelope: string | null;
      }>();

  it('re-encrypts rows from an old key version to the current one', async () => {
    const v1 = await ring({ '1': 1 }, 1);
    await insert('a', v1, SECRET, true);
    await insert('b', v1, SECRET);
    const both = await ring({ '1': 1, '2': 2 }, 2);
    await insert('c', both, SECRET); // already current

    const before = await row('a');
    const result = await reencryptServerCredentials(db, both);
    expect(result).toEqual({ reencrypted: 2, failed: 0, remaining: 0 });

    const after = await row('a');
    expect(after?.key_version).toBe(2);
    expect(after?.secret_envelope).toMatch(/^cw1\.2\./);
    expect(after?.secret_envelope).not.toBe(before?.secret_envelope);
    expect(after?.service_token_envelope).toMatch(/^cw1\.2\./);
    // Same plaintext, now readable with the new key alone.
    const onlyNew = await ring({ '2': 2 }, 2);
    expect(await decrypt(onlyNew, 'server_secret', 'a', after?.secret_envelope ?? '')).toBe(SECRET);
    expect(await decrypt(onlyNew, 'service_token', 'a', after?.service_token_envelope ?? '')).toBe(
      'cached-token',
    );
    expect((await row('b'))?.key_version).toBe(2);
    // A second run has nothing left to do.
    expect(await reencryptServerCredentials(db, both)).toEqual({
      reencrypted: 0,
      failed: 0,
      remaining: 0,
    });
  });

  it('works in batches and reports what remains', async () => {
    const v1 = await ring({ '1': 1 }, 1);
    for (const id of ['a', 'b', 'c']) await insert(id, v1, SECRET);
    const both = await ring({ '1': 1, '2': 2 }, 2);
    expect(await reencryptServerCredentials(db, both, 2)).toEqual({
      reencrypted: 2,
      failed: 0,
      remaining: 1,
    });
    expect(await reencryptServerCredentials(db, both, 2)).toEqual({
      reencrypted: 1,
      failed: 0,
      remaining: 0,
    });
  });

  it('leaves a row whose key is gone untouched and counts it as failed', async () => {
    const v1 = await ring({ '1': 1 }, 1);
    await insert('lost', v1, SECRET);
    const only2 = await ring({ '2': 2 }, 2);
    const before = await row('lost');
    expect(await reencryptServerCredentials(db, only2)).toEqual({
      reencrypted: 0,
      failed: 1,
      remaining: 1,
    });
    expect(await row('lost')).toEqual(before);
  });

  it('does not overwrite a row that changed key version meanwhile (compare-and-set)', async () => {
    const v1 = await ring({ '1': 1 }, 1);
    await insert('race', v1, SECRET);
    const both = await ring({ '1': 1, '2': 2 }, 2);
    const fresh = await encrypt(both, 'server_secret', 'race', 'newer-secret');
    // Another writer replaces the credentials (FR-SRV-005) between the select and the update.
    const realBatch = db.batch.bind(db);
    const spy = {
      prepare: db.prepare.bind(db),
      batch: async (stmts: D1PreparedStatement[]) => {
        await db
          .prepare(
            'UPDATE server_credentials SET key_version = 2, secret_envelope = ? WHERE server_id = ?',
          )
          .bind(fresh.envelope, 'race')
          .run();
        return realBatch(stmts);
      },
    } as unknown as D1Database;
    const result = await reencryptServerCredentials(spy, both);
    expect(result.reencrypted).toBe(0);
    expect((await row('race'))?.secret_envelope).toBe(fresh.envelope);
  });

  it('reencrypt() moves a single envelope to the current key', async () => {
    const v1 = await ring({ '1': 1 }, 1);
    const old = await encrypt(v1, 'session_cred', 'ps1', 'tok');
    const both = await ring({ '1': 1, '2': 2 }, 2);
    const moved = await reencrypt(both, 'session_cred', 'ps1', old.envelope);
    expect(moved.keyVersion).toBe(2);
    expect(await decrypt(both, 'session_cred', 'ps1', moved.envelope)).toBe('tok');
  });
});
