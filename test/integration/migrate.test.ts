import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS, splitSql } from '../../src/worker/db/migrate';

const tables = async (db: D1Database) =>
  (await db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name").all<{ type: string; name: string }>()).results;

describe('migrations applied by the Worker', () => {
  it('builds the same schema as wrangler, once, in its bookkeeping table', async () => {
    const db = env.MIGRATE_DB;
    expect(await migrate(db)).toEqual(MIGRATIONS.map((m) => m.name));
    expect(await tables(db)).toEqual(await tables(env.DB));
    // Nothing left to do, for the Worker or for wrangler.
    expect(await migrate(db)).toEqual([]);
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    const rows = (await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>()).results;
    expect(rows.map((r) => r.name)).toEqual(MIGRATIONS.map((m) => m.name));
  });

  it('splits statements outside quotes and comments, keeping triggers whole', () => {
    const sql = `-- a comment; not a statement
CREATE TABLE a (x TEXT DEFAULT 'one;two');
/* block; comment */
CREATE TRIGGER t AFTER INSERT ON a BEGIN
  INSERT INTO b VALUES (new.x);
  DELETE FROM c;
END;
INSERT INTO a VALUES ("semi;colon")`;
    const out = splitSql(sql);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("'one;two'");
    expect(out[1]).toMatch(/^\/\* block; comment \*\/\s+CREATE TRIGGER[\s\S]+END$/);
    expect(out[2]).toBe('INSERT INTO a VALUES ("semi;colon")');
  });
});
