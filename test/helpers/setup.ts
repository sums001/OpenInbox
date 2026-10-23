import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';
import { clearSettingsCache } from '../../src/worker/db/settings';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const { results } = await env.DB.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' AND name NOT LIKE 'messages_fts%'",
).all<{ name: string }>();
const tables = results.map((r) => r.name);

// D1 storage persists across tests in a file: start every test from an empty database.
// (message_bodies triggers keep the FTS index in sync while rows are deleted.)
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('PRAGMA defer_foreign_keys = true'), ...tables.map((t) => env.DB.prepare(`DELETE FROM "${t}"`))]);
  clearSettingsCache();
});
