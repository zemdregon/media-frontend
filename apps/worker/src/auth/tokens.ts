/** Random secrets and their hashes (LLD-TOKEN "Auth sessions, invites and challenges"). */

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes, base64url: session IDs, invite tokens, challenges (NFR-SEC-007). */
export function randomToken(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

/** SHA-256 hex. Only this is stored for sessions and invite tokens. */
export async function sha256Hex(value: string): Promise<string> {
  return [...new Uint8Array(await digest(value))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Constant-time string comparison. Both sides are hashed first so neither length nor content
 * leaks through timing (SETUP_TOKEN, TDD §4).
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(da, db);
}
