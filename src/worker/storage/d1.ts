// Raw .eml in D1 as latin1 TEXT. Binding BLOBs is very CPU-heavy on D1 (Phase 0 measured), while
// latin1 TEXT round-trips every byte and costs about 6 ms per MB. One row holds at most 950 KB
// (1.9 MB as UTF-8, under D1's 2 MB value limit), so larger messages aren't kept in this mode.
import { Buffer } from 'node:buffer';
import { RAW_D1_MAX_BYTES } from '../../shared/constants';
import type { BlobStore } from './index';

export class D1BlobStore implements BlobStore {
  readonly kind = 'd1' as const;
  readonly maxBytes = RAW_D1_MAX_BYTES;

  constructor(private db: D1Database) {}

  async put(key: string, data: Uint8Array): Promise<void> {
    if (data.byteLength > this.maxBytes) throw new Error(`Too large for D1 storage (${data.byteLength} bytes)`);
    const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1');
    await this.db.prepare('INSERT OR REPLACE INTO raw_messages (key, data) VALUES (?, ?)').bind(key, text).run();
  }

  // For use inside a D1 batch with the message insert.
  putStatement(key: string, data: Uint8Array): D1PreparedStatement {
    const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1');
    return this.db.prepare('INSERT OR REPLACE INTO raw_messages (key, data) VALUES (?, ?)').bind(key, text);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const row = await this.db.prepare('SELECT data FROM raw_messages WHERE key = ?').bind(key).first<{ data: string }>();
    return row ? new Uint8Array(Buffer.from(row.data, 'latin1')) : null;
  }

  async getRange(key: string, offset: number, length: number): Promise<Uint8Array | null> {
    // One latin1 character per byte, so substr's character offsets are byte offsets.
    const row = await this.db
      .prepare('SELECT substr(data, ?, ?) AS data FROM raw_messages WHERE key = ?')
      .bind(offset + 1, length, key)
      .first<{ data: string }>();
    return row ? new Uint8Array(Buffer.from(row.data, 'latin1')) : null;
  }

  async delete(keys: string[]): Promise<void> {
    if (!keys.length) return;
    await this.db.batch(keys.map((k) => this.db.prepare('DELETE FROM raw_messages WHERE key = ?').bind(k)));
  }
}
