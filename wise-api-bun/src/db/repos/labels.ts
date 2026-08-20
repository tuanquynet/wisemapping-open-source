import { dbAdapter } from "../client.ts";
import type { LabelRow } from "../rows.ts";
import type { Label } from "../../domain/types.ts";

/**
 * Labels are owned per-account: every read is scoped by creator, matching
 * `LabelManagerImpl`, where each query filters on `creator = :user`.
 *
 * Every function here is `async`, going through `dbAdapter` (Task 1.1,
 * tasks/plan.md) rather than the raw `bun:sqlite` `Database` (Task 4.1).
 */

function toLabel(row: LabelRow): Label {
  return {
    id: row.id,
    title: row.title,
    color: row.color,
    creatorId: row.creator_id,
  };
}

export async function listForAccount(creatorId: number): Promise<Label[]> {
  const rows = await dbAdapter.all<LabelRow>(
    `SELECT * FROM mindmap_label WHERE creator_id = ?1 ORDER BY id`,
    [creatorId],
  );
  return rows.map(toLabel);
}

export async function findByIdForAccount(
  id: number,
  creatorId: number,
): Promise<Label | null> {
  const row = await dbAdapter.get<LabelRow>(
    `SELECT * FROM mindmap_label WHERE id = ?1 AND creator_id = ?2`,
    [id, creatorId],
  );
  return row == null ? null : toLabel(row);
}

export async function findByTitleForAccount(
  title: string,
  creatorId: number,
): Promise<Label | null> {
  const row = await dbAdapter.get<LabelRow>(
    `SELECT * FROM mindmap_label WHERE title = ?1 AND creator_id = ?2`,
    [title, creatorId],
  );
  return row == null ? null : toLabel(row);
}

export async function insert(
  title: string,
  color: string,
  creatorId: number,
): Promise<Label> {
  const row = await dbAdapter.get<LabelRow>(
    `INSERT INTO mindmap_label (title, color, creator_id, created_at)
     VALUES (?1, ?2, ?3, ?4) RETURNING *`,
    [title, color, creatorId, Date.now()],
  );
  return toLabel(row!);
}

/** Removes the label; its links to maps go via ON DELETE CASCADE, leaving the maps. */
export async function deleteById(id: number): Promise<void> {
  await dbAdapter.run(`DELETE FROM mindmap_label WHERE id = ?1`, [id]);
}

export async function linkToMap(
  mindmapId: number,
  labelId: number,
): Promise<void> {
  await dbAdapter.run(
    `INSERT INTO mindmap_label_link (mindmap_id, label_id) VALUES (?1, ?2)
     ON CONFLICT(mindmap_id, label_id) DO NOTHING`,
    [mindmapId, labelId],
  );
}

export async function unlinkFromMap(
  mindmapId: number,
  labelId: number,
): Promise<void> {
  await dbAdapter.run(
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
export async function listForMaps(
  mindmapIds: readonly number[],
  creatorId: number,
): Promise<MapLabel[]> {
  if (mindmapIds.length === 0) return [];

  // Placeholder list is built from the array length, and every value is bound.
  const placeholders = mindmapIds.map((_, i) => `?${i + 2}`).join(", ");
  const rows = await dbAdapter.all<LabelRow & { mindmap_id: number }>(
    `SELECT l.*, k.mindmap_id
     FROM   mindmap_label_link k
     JOIN   mindmap_label l ON l.id = k.label_id
     WHERE  l.creator_id = ?1 AND k.mindmap_id IN (${placeholders})
     ORDER  BY l.id`,
    [creatorId, ...mindmapIds],
  );
  return rows.map((row) => ({ ...toLabel(row), mindmapId: row.mindmap_id }));
}

/** Titles of the caller's labels attached to a map, for the `?q=<label>` filter. */
export async function titlesForMap(
  mindmapId: number,
  creatorId: number,
): Promise<string[]> {
  const rows = await dbAdapter.all<{ title: string }>(
    `SELECT l.title
     FROM   mindmap_label_link k
     JOIN   mindmap_label l ON l.id = k.label_id
     WHERE  k.mindmap_id = ?1 AND l.creator_id = ?2`,
    [mindmapId, creatorId],
  );
  return rows.map((r) => r.title);
}
