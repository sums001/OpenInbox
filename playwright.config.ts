import { defineConfig, devices } from '@playwright/test';

// End-to-end tests: the real Worker and web app (Vite dev server, isolated local D1), with
// Cloudflare and the sending providers replaced by the mock server. Nothing leaves the machine.
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5174',
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } } }],
  webServer: [
    {
      command: 'node test/mock/server.ts',
      url: 'http://127.0.0.1:8790/github/repos/x/y/releases/latest',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'node test/e2e/serve.ts',
      url: 'http://localhost:5174/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
