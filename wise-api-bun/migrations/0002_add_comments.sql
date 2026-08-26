-- ===========================================================================
-- comment -- topic-scoped comments on mindmaps.
--   mindmap_id FK → mindmap (id) ON DELETE CASCADE
--   author_id  FK → account (id) ON DELETE CASCADE
-- ===========================================================================
CREATE TABLE IF NOT EXISTS comment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mindmap_id INTEGER NOT NULL REFERENCES mindmap (id) ON DELETE CASCADE,
  topic_id   TEXT    NOT NULL,
  author_id  INTEGER NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  body       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS ix_comment_map_topic_created
  ON comment (mindmap_id, topic_id, created_at);
