// `npm run deploy`: build, apply D1 migrations, deploy. This is the command the Deploy to
// Cloudflare button runs (Workers Builds pre-fills it from package.json).
//
// Migrations are retried on D1 error 7404: right after the button creates the database it can
// take a few seconds before the API sees it (Phase 0 measured about 15 s).
import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const run = (cmd) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
};

// Workers Builds runs `npm run build` first; don't build twice there.
if (!(process.env.WORKERS_CI && existsSync('dist/openinbox/wrangler.json'))) run('npx vite build');

const migrate = 'npx wrangler d1 migrations apply DB --remote --config wrangler.jsonc';
for (let attempt = 1; ; attempt++) {
  console.log(`\n$ ${migrate}${attempt > 1 ? `   (attempt ${attempt})` : ''}`);
  const r = spawnSync(migrate, { shell: true, encoding: 'utf8', env: { ...process.env, CI: process.env.CI ?? '1' } });
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  if (r.status === 0) break;
  const output = `${r.stdout}\n${r.stderr}`;
  const notVisibleYet = /7404|database.*not found|Couldn't find a D1 DB/i.test(output);
  if (!notVisibleYet || attempt >= 10) {
    console.error('\nApplying D1 migrations failed.');
    process.exit(r.status ?? 1);
  }
  const wait = Math.min(5 * attempt, 20);
  console.log(`The new database is not visible yet; retrying in ${wait} s...`);
  await new Promise((resolve) => setTimeout(resolve, wait * 1000));
}

run('npx wrangler deploy');
