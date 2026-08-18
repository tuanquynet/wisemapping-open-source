import { db } from "../client.ts";
import type { LabelRow } from "../rows.ts";
import type { Label } from "../../domain/types.ts";

/**
 * Labels are owned per-account: every read is scoped by creator, matching
 * `LabelManagerImpl`, where each query filters on `creator = :user`.
 */

function toLabel(row: LabelRow): Label {
  return {
    id: row.id,
    title: row.title,
    color: row.color,
    creatorId: row.creator_id,
  };
}

export function listForAccount(creatorId: number): Label[] {
  return db
    .query<LabelRow, [number]>(
      `SELECT * FROM mindmap_label WHERE creator_id = ?1 ORDER BY id`,
    )
    .all(creatorId)
    .map(toLabel);
}

export function findByIdForAccount(
  id: number,
  creatorId: number,
): Label | null {
  const row = db
    .query<LabelRow, [number, number]>(
      `SELECT * FROM mindmap_label WHERE id = ?1 AND creator_id = ?2`,
    )
    .get(id, creatorId);
  return row == null ? null : toLabel(row);
}

export function findByTitleForAccount(
  title: string,
  creatorId: number,
): Label | null {
  const row = db
    .query<LabelRow, [string, number]>(
      `SELECT * FROM mindmap_label WHERE title = ?1 AND creator_id = ?2`,
    )
    .get(title, creatorId);
  return row == null ? null : toLabel(row);
}

export function insert(title: string, color: string, creatorId: number): Label {
  const row = db
    .query<LabelRow, [string, string, number, number]>(
      `INSERT INTO mindmap_label (title, color, creator_id, created_at)
       VALUES (?1, ?2, ?3, ?4) RETURNING *`,
    )
    .get(title, color, creatorId, Date.now())!;
  return toLabel(row);
}

/** Removes the label; its links to maps go via ON DELETE CASCADE, leaving the maps. */
export function deleteById(id: number): void {
  db.run(`DELETE FROM mindmap_label WHERE id = ?1`, [id]);
}

export function linkToMap(mindmapId: number, labelId: number): void {
  db.run(
    `INSERT INTO mindmap_label_link (mindmap_id, label_id) VALUES (?1, ?2)
     ON CONFLICT(mindmap_id, label_id) DO NOTHING`,
    [mindmapId, labelId],
  );
}

export function unlinkFromMap(mindmapId: number, labelId: number): void {
  db.run(
    `DELETE FROM mindmap_label_link WHERE mindmap_id = ?1 AND label_id = ?2`,
    [mindmapId, labelId],
  );
}

export interface MapLabel extends Label {
  mindmapId: number;
}

/**
 * Labels for a set of maps, restricted to the caller's own labels.
 *
 * One query for the whole page rather than one per map -- this is the second and
 * final query behind `GET /maps/`, versus the Java version's six-way JOIN FETCH.
 */
export function listForMaps(
  mindmapIds: readonly number[],
  creatorId: number,
): MapLabel[] {
  if (mindmapIds.length === 0) return [];

  // Placeholder list is built from the array length, and every value is bound.
  const placeholders = mindmapIds.map((_, i) => `?${i + 2}`).join(", ");
  return db
    .query<LabelRow & { mindmap_id: number }, [number, ...number[]]>(
      `SELECT l.*, k.mindmap_id
       FROM   mindmap_label_link k
       JOIN   mindmap_label l ON l.id = k.label_id
       WHERE  l.creator_id = ?1 AND k.mindmap_id IN (${placeholders})
       ORDER  BY l.id`,
    )
    .all(creatorId, ...mindmapIds)
    .map((row) => ({ ...toLabel(row), mindmapId: row.mindmap_id }));
}

/** Titles of the caller's labels attached to a map, for the `?q=<label>` filter. */
export function titlesForMap(mindmapId: number, creatorId: number): string[] {
  return db
    .query<{ title: string }, [number, number]>(
      `SELECT l.title
       FROM   mindmap_label_link k
       JOIN   mindmap_label l ON l.id = k.label_id
       WHERE  k.mindmap_id = ?1 AND l.creator_id = ?2`,
    )
    .all(mindmapId, creatorId)
    .map((r) => r.title);
}
