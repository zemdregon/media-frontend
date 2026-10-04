// Types `env` from "cloudflare:workers" in tests with the Worker's own bindings.
import type { D1Migration } from 'cloudflare:test';
import type { Env as WorkerEnv } from '../src/platform/env';

declare global {
  /** Node's `import.meta.dirname`, used by vitest.config.ts (no Node types in this package). */
  interface ImportMeta {
    readonly dirname: string;
  }

  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** Injected by vitest.config.ts from `migrations/` (T0.4). */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
