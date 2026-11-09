-- Sender logos (BIMI): a domain's square SVG logo and, optionally, its mark certificate (VMC or
-- CMC). Both are served publicly so the default._bimi record can point at them.
CREATE TABLE sender_logos (
  domain_id INTEGER PRIMARY KEY REFERENCES domains (id) ON DELETE CASCADE,
  svg TEXT NOT NULL,
  certificate TEXT,
  updated_at INTEGER NOT NULL
);
