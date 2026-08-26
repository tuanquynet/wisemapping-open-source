import { dbAdapter } from "../client.ts";
import type { CommentRow } from "../rows.ts";
import type { Comment, CommentWithAuthor } from "../../domain/comment.ts";

// ---------------------------------------------------------------------------
// Row → Domain mappers
// ---------------------------------------------------------------------------

function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    mindmapId: row.mindmap_id,
    topicId: row.topic_id,
    authorId: row.author_id,
    body: row.body,
    createdAt: new Date(row.created_at),
  };
}

interface CommentWithAuthorRow extends CommentRow {
  author_email: string;
  author_firstname: string | null;
  author_lastname: string | null;
}

function toCommentWithAuthor(row: CommentWithAuthorRow): CommentWithAuthor {
  return {
    id: row.id,
    mindmapId: row.mindmap_id,
    topicId: row.topic_id,
    authorId: row.author_id,
    body: row.body,
    createdAt: new Date(row.created_at),
    authorEmail: row.author_email,
    authorFirstname: row.author_firstname ?? "",
    authorLastname: row.author_lastname ?? "",
  };
}

// ---------------------------------------------------------------------------
// Queries — all positional `?1`, `?2`, etc.; zero SQL string interpolation.
// ---------------------------------------------------------------------------

/**
 * Inserts a new comment and returns the full record (with author join).
 * Uses RETURNING + a follow-up join rather than lastInsertRowid so the
 * same code path works identically on D1 (which supports RETURNING).
 */
export async function insert(
  mindmapId: number,
  topicId: string,
  authorId: number,
  body: string,
): Promise<CommentWithAuthor> {
  const rows = await dbAdapter.batch<CommentRow>([
    {
      sql: `
        INSERT INTO comment (mindmap_id, topic_id, author_id, body, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        RETURNING id, mindmap_id, topic_id, author_id, body, created_at
      `,
      params: [mindmapId, topicId, authorId, body, Date.now()],
    },
  ]);

  const inserted = rows[0]?.[0];
  if (!inserted) {
    throw new Error("INSERT INTO comment returned no row");
  }

  // Fetch with author join so the response includes display metadata.
  const full = await findById(inserted.id);
  if (!full) {
    throw new Error(`comment ${inserted.id} vanished immediately after insert`);
  }
  return full;
}

/**
 * Lists all comments for a map, optionally filtered to one topic.
 * Sorted by `created_at ASC, id ASC` for stable chronological order.
 */
export async function listForMap(
  mindmapId: number,
  topicId?: string,
): Promise<CommentWithAuthor[]> {
  if (topicId !== undefined) {
    const rows = await dbAdapter.all<CommentWithAuthorRow>(
      `
        SELECT c.id, c.mindmap_id, c.topic_id, c.author_id, c.body, c.created_at,
               a.email   AS author_email,
               a.firstname AS author_firstname,
               a.lastname  AS author_lastname
        FROM   comment c
        JOIN   account a ON a.id = c.author_id
        WHERE  c.mindmap_id = ?1
          AND  c.topic_id   = ?2
        ORDER BY c.created_at ASC, c.id ASC
      `,
      [mindmapId, topicId],
    );
    return rows.map(toCommentWithAuthor);
  }

  const rows = await dbAdapter.all<CommentWithAuthorRow>(
    `
      SELECT c.id, c.mindmap_id, c.topic_id, c.author_id, c.body, c.created_at,
             a.email   AS author_email,
             a.firstname AS author_firstname,
             a.lastname  AS author_lastname
      FROM   comment c
      JOIN   account a ON a.id = c.author_id
      WHERE  c.mindmap_id = ?1
      ORDER BY c.created_at ASC, c.id ASC
    `,
    [mindmapId],
  );
  return rows.map(toCommentWithAuthor);
}

/** Returns a single comment with its author metadata, or null. */
export async function findById(id: number): Promise<CommentWithAuthor | null> {
  const row = await dbAdapter.get<CommentWithAuthorRow>(
    `
      SELECT c.id, c.mindmap_id, c.topic_id, c.author_id, c.body, c.created_at,
             a.email   AS author_email,
             a.firstname AS author_firstname,
             a.lastname  AS author_lastname
      FROM   comment c
      JOIN   account a ON a.id = c.author_id
      WHERE  c.id = ?1
    `,
    [id],
  );
  return row ? toCommentWithAuthor(row) : null;
}

/** Deletes a comment by id. No-op if not found. */
export async function deleteById(id: number): Promise<void> {
  await dbAdapter.run(`DELETE FROM comment WHERE id = ?1`, [id]);
}
