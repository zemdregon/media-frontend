const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

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
