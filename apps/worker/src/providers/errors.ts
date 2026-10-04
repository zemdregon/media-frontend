/**
 * Provider errors (LLD-PROV). Adapters and the origin fetch wrapper throw only these, so the
 * request path can map them to the LLD-ERR codes without knowing which provider failed.
 * Messages never carry origin response bodies, URLs with query strings or credentials
 * (NFR-SEC-001).
 */
export type ProviderErrorCode =
  | 'AUTH'
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'PROTOCOL'
  | 'UNSUPPORTED'
  /** A redirect to another host (or origin) was refused (NFR-SEC-005). */
  | 'REDIRECT_REFUSED';

export class ProviderError extends Error {
  override name = 'ProviderError';
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryable: boolean = code === 'UNAVAILABLE' || code === 'TIMEOUT',
  ) {
    super(message);
  }
}
