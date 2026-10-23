// Thin helpers over D1 prepared statements. Queries stay as plain SQL so the FTS5 and partial
// index setup is visible, and nothing hides how many rows a query reads.

export type Param = string | number | null | ArrayBuffer;

export function stmt(db: D1Database, sql: string, ...params: Param[]): D1PreparedStatement {
  return params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
}

export async function first<T>(db: D1Database, sql: string, ...params: Param[]): Promise<T | null> {
  return (await stmt(db, sql, ...params).first<T>()) ?? null;
}

export async function all<T>(db: D1Database, sql: string, ...params: Param[]): Promise<T[]> {
  const { results } = await stmt(db, sql, ...params).all<T>();
  return results ?? [];
}

export async function run(db: D1Database, sql: string, ...params: Param[]): Promise<D1Result> {
  return stmt(db, sql, ...params).run();
}

// "?, ?, ?" for an IN list.
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

// The database size in bytes, from the meta D1 returns with every query (no API call needed).
export async function databaseSize(db: D1Database): Promise<number | null> {
  const r = await db.prepare('SELECT 1').run();
  const meta = r.meta as D1Meta & { size_after?: number };
  return typeof meta.size_after === 'number' ? meta.size_after : null;
}
