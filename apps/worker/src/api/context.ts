import type { Role } from '@cinewren/shared';
import type { Config } from '../platform/config';
import type { Env } from '../platform/env';
import type { Logger } from '../platform/logger';

/** The signed-in user, resolved once per request by the session middleware (SDD §4.4). */
export interface AuthContext {
  userId: string;
  displayName: string;
  role: Role;
  theme: 'system' | 'dark' | 'light';
  sessionIdHash: string;
  passkeyId: string | null;
}

/** Hono environment shared by every route and middleware. */
export interface AppEnv {
  Bindings: Env;
  Variables: { requestId: string; logger: Logger; config: Config; auth: AuthContext | undefined };
}
