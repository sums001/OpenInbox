import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Unit and integration tests run inside workerd with a fresh local D1 per test file.
export default defineConfig(async () => {
  const migrations = await readD1Migrations('src/worker/db/migrations');
  return {
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './test/wrangler.test.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENCRYPTION_KEY: 'test-encryption-key-0123456789abcdef0123456789abcdef',
            CF_API_TOKEN: 'test-cf-token',
            CF_API_BASE: 'https://cf.test/client/v4',
            RESEND_API_BASE: 'https://resend.test',
            BREVO_API_BASE: 'https://brevo.test/v3',
            MAILJET_API_BASE: 'https://mailjet.test',
            GITHUB_API_BASE: 'https://github.test',
            WORKER_NAME: 'openinbox',
          },
        },
      }),
    ],
    test: {
      include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
      setupFiles: ['./test/helpers/setup.ts'],
      testTimeout: 30_000,
    },
  };
});
