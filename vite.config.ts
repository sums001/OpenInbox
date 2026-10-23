import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// End-to-end tests run the dev server on their own local database, with every external API
// pointed at the mock server (test/mock/server.ts). .dev.vars, when present, takes precedence.
const e2e = process.env.OI_E2E === '1';
const e2eVars = {
  ENCRYPTION_KEY: 'e2e-encryption-key-0123456789abcdef0123456789',
  CF_API_TOKEN: 'dev-token',
  CF_API_BASE: 'http://127.0.0.1:8790/cf',
  RESEND_API_BASE: 'http://127.0.0.1:8790/resend',
  BREVO_API_BASE: 'http://127.0.0.1:8790/brevo',
  MAILJET_API_BASE: 'http://127.0.0.1:8790/mailjet',
  GITHUB_API_BASE: 'http://127.0.0.1:8790/github',
  WORKER_NAME: 'openinbox',
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare(e2e ? { persistState: { path: '.wrangler/e2e-state' }, config: { vars: e2eVars } } : {}),
  ],
  publicDir: 'src/web/public',
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    chunkSizeWarningLimit: 900,
  },
});
