// Copies the upstream OpenInbox files over this repository (used by .github/workflows/
// sync-upstream.yml). Repositories created by the Deploy button are copies, not forks, so a git
// merge would conflict everywhere; copying files is simpler and keeps local settings:
//   - wrangler.jsonc keeps this deployment's Worker name, database name and database_id
//   - .github/workflows is left alone (the workflow token may not modify workflows)
//   - local-only files (.dev.vars, .live.env) are never touched
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const upstream = process.env.UPSTREAM || 'sums001/OpenInbox';
const requested = process.argv[2]?.trim();
const sh = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim();

async function latestRelease() {
  try {
    const res = await fetch(`https://api.github.com/repos/${upstream}/releases/latest`, { headers: { 'User-Agent': 'openinbox-sync' } });
    if (!res.ok) return null;
    return (await res.json()).tag_name ?? null;
  } catch {
    return null;
  }
}

const ref = requested || (await latestRelease()) || 'main';
const dir = mkdtempSync(join(tmpdir(), 'openinbox-upstream-'));
console.log(`Fetching ${upstream}@${ref}`);
sh(`git clone --depth 1 --branch ${ref} https://github.com/${upstream}.git "${dir}"`);

const PROTECTED = [/^\.git\//, /^\.github\/workflows\//, /^\.dev\.vars/, /^\.live\.env$/, /^wrangler\.jsonc$/];
const isProtected = (f) => PROTECTED.some((re) => re.test(f));

const upstreamFiles = new Set(sh('git ls-files', { cwd: dir }).split('\n').filter(Boolean));
const localFiles = sh('git ls-files').split('\n').filter(Boolean);

// Files removed upstream are removed here too.
for (const f of localFiles) if (!upstreamFiles.has(f) && !isProtected(f)) rmSync(f, { force: true });
for (const f of upstreamFiles) if (!isProtected(f)) cpSync(join(dir, f), f);

// wrangler.jsonc: upstream structure, this deployment's identity.
const local = existsSync('wrangler.jsonc') ? readFileSync('wrangler.jsonc', 'utf8') : '';
let next = readFileSync(join(dir, 'wrangler.jsonc'), 'utf8');
const pick = (text, key) => new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(text)?.[1];
const name = pick(local, 'name');
const dbName = pick(local, 'database_name');
const dbId = pick(local, 'database_id');
if (name) next = next.replace(/"name"\s*:\s*"[^"]*"/, `"name": "${name}"`);
if (dbName) next = next.replace(/"database_name"\s*:\s*"[^"]*"/, `"database_name": "${dbName}"`);
if (dbId) {
  next = /"database_id"\s*:/.test(next)
    ? next.replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${dbId}"`)
    : next.replace(/("database_name"\s*:\s*"[^"]*")/, `$1, "database_id": "${dbId}"`);
}
writeFileSync('wrangler.jsonc', next);

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
writeFileSync('.upstream-version', `v${version}`);
rmSync(dir, { recursive: true, force: true });
console.log(`Copied OpenInbox v${version}. Review "git status", then commit.`);
