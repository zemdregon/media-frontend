/**
 * Structured JSON logger (NFR-OBS-001, TDD §6.2).
 * Redaction happens here, not at call sites: sensitive keys are replaced, and URL-like strings
 * lose their query string and fragment (they may carry stream tokens). Display names are never
 * logged; use `user_id`.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

export const REDACTED = '[redacted]';
const SENSITIVE_KEY =
  /token|password|secret|authorization|credential|api_?key|cookie|display_?name/i;
const MAX_DEPTH = 6;

function redactString(value: string): string {
  return /^https?:\/\//i.test(value) ? value.replace(/[?#].*$/, '') : value;
}

/** Returns a deep copy of `value` that is safe to log. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that adds `fields` (for example `request_id`) to every line. */
  child(fields: LogFields): Logger;
}

const defaultSink: LogSink = (line) => {
  console.log(line);
};

export function createLogger(base: LogFields = {}, sink: LogSink = defaultSink): Logger {
  const emit = (level: LogLevel, event: string, fields: LogFields = {}) => {
    const entry = redact({ ts: new Date().toISOString(), level, ...base, event, ...fields });
    sink(JSON.stringify(entry));
  };
  return {
    debug: (e, f) => {
      emit('debug', e, f);
    },
    info: (e, f) => {
      emit('info', e, f);
    },
    warn: (e, f) => {
      emit('warn', e, f);
    },
    error: (e, f) => {
      emit('error', e, f);
    },
    child: (fields) => createLogger({ ...base, ...fields }, sink),
  };
}
