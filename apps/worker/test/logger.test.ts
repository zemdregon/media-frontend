import { describe, expect, it } from 'vitest';
import { createLogger, redact, REDACTED } from '../src/platform/logger';

function capture() {
  const lines: string[] = [];
  return { lines, logger: createLogger({ request_id: 'r1' }, (l) => lines.push(l)) };
}

describe('logger', () => {
  it('writes single-line JSON with ts, level, event and base fields', () => {
    const { lines, logger } = capture();
    logger.info('test.event', { user_id: 'u1', duration_ms: 3 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      level: 'info',
      event: 'test.event',
      request_id: 'r1',
      user_id: 'u1',
      duration_ms: 3,
    });
  });

  it('never emits display names, tokens, cookies or credentials', () => {
    const { lines, logger } = capture();
    logger.info('auth.login', {
      displayName: 'Alice Wonderland',
      display_name: 'Alice Wonderland',
      token: 'tok-SECRET-1',
      sessionCookie: 'sid=COOKIE-SECRET',
      headers: { Cookie: 'sid=COOKIE-SECRET', Authorization: 'Bearer BEARER-SECRET' },
      nested: { deep: { api_key: 'KEY-SECRET', password: 'PW-SECRET' } },
      list: [{ credentials: { token: 'LIST-SECRET' } }],
      url: 'https://origin.example/stream.m3u8?api_key=URL-SECRET#frag',
    });
    logger.error('boom', { error: new Error('failed') });
    const out = lines.join('\n');
    for (const secret of [
      'Alice',
      'Wonderland',
      'tok-SECRET-1',
      'COOKIE-SECRET',
      'BEARER-SECRET',
      'KEY-SECRET',
      'PW-SECRET',
      'LIST-SECRET',
      'URL-SECRET',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('https://origin.example/stream.m3u8');
    expect(out).toContain(REDACTED);
  });

  it('child loggers keep redaction and add fields', () => {
    const { lines, logger } = capture();
    logger.child({ route: '/x' }).info('e', { token: 'T' });
    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry.route).toBe('/x');
    expect(entry.token).toBe(REDACTED);
  });

  it('redact does not mutate its input', () => {
    const input = { token: 'abc', ok: 1 };
    redact(input);
    expect(input.token).toBe('abc');
  });
});
