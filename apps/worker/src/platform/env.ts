/** Worker bindings and vars (TDD §4). Secrets are added by the tasks that use them. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  JOBS_QUEUE: Queue;
  ENVIRONMENT: 'local' | 'staging' | 'production';
  APP_ORIGIN: string;
}
