// Applies the bundled D1 migrations from inside the Worker, so a deploy works whichever command
// built it (the Deploy button's `npm run deploy`, the dashboard's plain `npx wrangler deploy`, or
// Sync upstream). It keeps wrangler's own bookkeeping table, so `wrangler d1 migrations apply`
// and the Worker never apply a migration twice.
const files = import.meta.glob<string>('./migrations/*.sql', { query: '?raw', import: 'default', eager: true });

export const MIGRATIONS = Object.entries(files)
  .map(([path, sql]) => ({ name: path.slice(path.lastIndexOf('/') + 1), sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

// The same definition wrangler uses.
const TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

let done: Promise<void> | null = null;

// Once per isolate: one D1 round trip when nothing is pending.
export function ensureMigrated(db: D1Database): Promise<void> {
  return (done ??= migrate(db).then(
    () => undefined,
    (e) => {
      done = null;
      throw e;
    },
  ));
}

async function appliedNames(db: D1Database): Promise<Set<string>> {
  const [, rows] = await db.batch<{ name: string }>([db.prepare(TABLE), db.prepare('SELECT name FROM d1_migrations')]);
  return new Set(rows.results.map((r) => r.name));
}

export async function migrate(db: D1Database): Promise<string[]> {
  const applied = await appliedNames(db);
  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    try {
      // One batch is one transaction: the schema change and its bookkeeping row land together.
      await db.batch([...splitSql(m.sql).map((s) => db.prepare(s)), db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(m.name)]);
      ran.push(m.name);
    } catch (e) {
      // Another isolate may have applied it at the same moment.
      if (!(await appliedNames(db)).has(m.name)) {
        throw new Error(`Database migration ${m.name} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    }
  }
  return ran;
}

// Splits a migration file into statements: on top-level semicolons, outside quotes and comments,
// keeping CREATE TRIGGER ... BEGIN ... END; together.
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = sql.indexOf(ch, i + 1);
      i = end === -1 ? sql.length : end;
    } else if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
    } else if (ch === ';') {
      const stmt = sql.slice(start, i).trim();
      const code = stripComments(stmt);
      if (/^CREATE\s+(TEMP\w*\s+)?TRIGGER\b/i.test(code) && !/\bEND$/i.test(code)) continue;
      if (code) out.push(stmt);
      start = i + 1;
    }
  }
  const rest = stripComments(sql.slice(start).trim());
  if (rest) out.push(sql.slice(start).trim());
  return out;
}

function stripComments(s: string): string {
  return s
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
}
