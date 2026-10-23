// Starts the dev server for end-to-end tests on a fresh local database. (Playwright starts web
// servers before globalSetup, so the reset happens here, before workerd opens the files.)
import { execSync, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

rmSync('.wrangler/e2e-state', { recursive: true, force: true });
execSync('npx wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e-state --config wrangler.jsonc', { stdio: 'ignore' });
const child = spawn('npx vite --port 5174 --strictPort', { stdio: 'inherit', shell: true, env: { ...process.env, OI_E2E: '1' } });
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
