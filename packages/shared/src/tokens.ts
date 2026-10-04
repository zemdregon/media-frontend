/**
 * Random secrets, their hashes and IDs (LLD-TOKEN "Auth sessions, invites and challenges").
 * Shared by the Worker and by the operator recovery CLI so the two cannot diverge (FR-USR-007).
 * Pure WebCrypto with no imports, so Node can load this file directly.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes, base64url: session IDs, invite tokens, challenges (NFR-SEC-007). */
export function randomToken(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** SHA-256 hex. Only this is stored for sessions and invite tokens. */
export async function sha256Hex(value: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A 26-character ULID: 48-bit millisecond time plus 80 random bits. */
export function ulid(now: number = Date.now()): string {
  let time = '';
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) {
    time = CROCKFORD.charAt(t % 32) + time;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = '';
  for (const b of bytes) random += CROCKFORD.charAt(b % 32);
  return time + random;
}
