/** Worker bindings, vars and secrets (TDD §4). */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  JOBS_QUEUE: Queue;
  /** Per-IP limiter for setup, invite redemption and login (NFR-SEC-004, TDD §6.3). */
  RL_AUTH: RateLimit;
  ENVIRONMENT: 'local' | 'staging' | 'production';
  APP_ORIGIN: string;
  /** WebAuthn RP ID; defaults to the hostname of APP_ORIGIN (IR-006). */
  RP_ID?: string;
  RP_NAME?: string;
  SESSION_IDLE_DAYS?: string;
  SESSION_ABSOLUTE_DAYS?: string;
  INVITE_TTL_DAYS?: string;
  /**
   * Secret. JSON object mapping key version to a base64 32-byte AES key (DR-002, LLD-TOKEN).
   * Declared optional so the Worker can still answer health when it is missing; the vault fails
   * closed on first use.
   */
  CREDENTIAL_KEYS?: string | undefined;
  /** Key version used for new encryptions; must exist in `CREDENTIAL_KEYS`. */
  CREDENTIAL_KEY_CURRENT?: string | undefined;
  /** `true` allows `http://` origin base URLs. Honoured only when `ENVIRONMENT=local` (FR-SRV-007). */
  ALLOW_INSECURE_ORIGINS?: string | undefined;
  /** Secret. One-time bootstrap token; deliberately not in `secrets.required` (ADR-0014). */
  SETUP_TOKEN?: string | undefined;
}
