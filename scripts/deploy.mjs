// `npm run deploy`: build, then deploy. This is the command the Deploy to Cloudflare button runs
// (Workers Builds pre-fills it from package.json); the dashboard's "Import a repository" runs plain
// `npx wrangler deploy` instead, which ends up the same. Wrangler creates the D1 database if the
// account doesn't have it yet, and the Worker applies its own migrations (src/worker/db/migrate.ts).
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const run = (cmd) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
};

// Workers Builds runs `npm run build` first; don't build twice there.
if (!(process.env.WORKERS_CI && existsSync('dist/openinbox/wrangler.json'))) run('npx vite build');

run('npx wrangler deploy');
