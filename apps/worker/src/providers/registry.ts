/**
 * The only place that maps a provider type to its adapter, and builds the context an adapter
 * runs in. Code outside `providers/` imports from here, never from an adapter (IR-002, lint).
 */
import { jellyfinProvider } from './jellyfin';
import { createOriginFetch } from './origin-fetch';
import type { MediaProvider, ProviderContext, ProviderType, ServerSecret } from './types';

/** Adapters that exist today. Emby (T4.1) and Plex (T4.2) register here when they land. */
const PROVIDERS: Partial<Record<ProviderType, MediaProvider>> = {
  jellyfin: jellyfinProvider,
};

export function getProvider(type: ProviderType): MediaProvider | null {
  return PROVIDERS[type] ?? null;
}

export function isSupportedProvider(type: ProviderType): boolean {
  return type in PROVIDERS;
}

export interface BuildContextInput {
  server: ProviderContext['server'];
  secret: ServerSecret;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
}

/**
 * A context with a host-pinned fetch. Access tokens are derived per context and are not
 * persisted (ADR-0008 note: only the encrypted username and password are stored).
 */
export function buildProviderContext(input: BuildContextInput): ProviderContext {
  return {
    server: input.server,
    secret: input.secret,
    fetch: createOriginFetch({
      baseUrl: input.server.baseUrl,
      fetchImpl: input.fetchImpl,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    }),
    serviceToken: undefined,
    onTokenRefresh: () => Promise.resolve(),
  };
}
