/**
 * Base-URL policy for origin servers (FR-SRV-007, NFR-SEC-005, LLD-PROV "URL policy").
 * Pure: it returns a decision and the API layer turns it into the error envelope.
 *
 * The Worker cannot see the IP a hostname resolves to, so a hostname that resolves to a private
 * range is not blocked here. That residual risk is accepted because only operators can register
 * servers (BR-8; LLD-PROV).
 */
export type UrlPolicyFailure =
  | { code: 'VALIDATION_FAILED'; reason: 'not_a_url' | 'unsupported_scheme' }
  | { code: 'INSECURE_ORIGIN_URL'; reason: 'http_not_allowed' }
  | {
      code: 'BLOCKED_ORIGIN_URL';
      reason:
        | 'userinfo'
        | 'ip_literal'
        | 'internal_hostname'
        | 'single_label_hostname'
        | 'query_or_fragment';
    };

export type UrlPolicyResult = { ok: true; baseUrl: URL } | ({ ok: false } & UrlPolicyFailure);

export interface UrlPolicyOptions {
  /** `ENVIRONMENT === 'local'`. The blocked-host rules are lifted for local development. */
  local: boolean;
  /** `ALLOW_INSECURE_ORIGINS`, already gated on local mode by the config parser. */
  allowInsecure: boolean;
}

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function isIpLiteral(host: string): boolean {
  // `new URL` canonicalises 0x7f.1, 2130706433 and similar to dotted decimal.
  return host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isInternalHostname(host: string): boolean {
  return host === 'localhost' || INTERNAL_SUFFIXES.some((s) => host.endsWith(s));
}

/**
 * Normalises `raw` to `scheme://host[:port][/prefix]` without a trailing slash, or says why it
 * is refused. Order: scheme first (FR-SRV-007), then the blocked-host rules (outside local).
 */
export function checkBaseUrl(raw: string, opts: UrlPolicyOptions): UrlPolicyResult {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: 'VALIDATION_FAILED', reason: 'not_a_url' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, code: 'VALIDATION_FAILED', reason: 'unsupported_scheme' };
  }
  if (url.protocol === 'http:' && !opts.allowInsecure) {
    return { ok: false, code: 'INSECURE_ORIGIN_URL', reason: 'http_not_allowed' };
  }
  if (!opts.local) {
    if (url.username || url.password) {
      return { ok: false, code: 'BLOCKED_ORIGIN_URL', reason: 'userinfo' };
    }
    const host = url.hostname.replace(/\.$/, '').toLowerCase();
    if (isIpLiteral(host)) return { ok: false, code: 'BLOCKED_ORIGIN_URL', reason: 'ip_literal' };
    if (isInternalHostname(host)) {
      return { ok: false, code: 'BLOCKED_ORIGIN_URL', reason: 'internal_hostname' };
    }
    // Conservative extension of the LLD list: a one-label name (`nas`) cannot hold a public
    // certificate and only resolves on a private network.
    if (!host.includes('.')) {
      return { ok: false, code: 'BLOCKED_ORIGIN_URL', reason: 'single_label_hostname' };
    }
    if (url.search || url.hash) {
      return { ok: false, code: 'BLOCKED_ORIGIN_URL', reason: 'query_or_fragment' };
    }
  }
  // Stored form: no query, fragment or userinfo, no trailing slash.
  const prefix = url.pathname.replace(/\/+$/, '');
  return { ok: true, baseUrl: new URL(`${url.origin}${prefix}`) };
}
