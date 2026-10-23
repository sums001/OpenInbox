import type { Env } from '../src/worker/env';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
      // An empty database for the Worker's own migration runner.
      MIGRATE_DB: D1Database;
    }
  }
}

type AppEnv = Env;
