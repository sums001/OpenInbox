import type { Env } from '../src/worker/env';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    }
  }
}

type AppEnv = Env;
