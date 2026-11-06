// The message sequence for polling (see migration 0005): statements that give a message the next
// number. Run them in the batch that makes the message visible, so numbers follow commit order.
export function nextSeqStmts(db: D1Database, messageId: number): D1PreparedStatement[] {
  return [
    db.prepare("INSERT INTO sequences (name, value) VALUES ('messages', 1) ON CONFLICT (name) DO UPDATE SET value = value + 1"),
    db.prepare("UPDATE messages SET seq = (SELECT value FROM sequences WHERE name = 'messages') WHERE id = ?").bind(messageId),
  ];
}
