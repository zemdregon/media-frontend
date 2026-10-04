// Types `env` from "cloudflare:workers" in tests with the Worker's own bindings.
import type { Env as WorkerEnv } from '../src/platform/env';

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends WorkerEnv {}
  }
}
