/** Random secrets and their hashes (LLD-TOKEN "Auth sessions, invites and challenges"). */

export { base64url, randomToken, sha256Hex } from '@cinewren/shared';

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
}

/**
 * Constant-time string comparison. Both sides are hashed first so neither length nor content
 * leaks through timing (SETUP_TOKEN, TDD §4).
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(da, db);
}
