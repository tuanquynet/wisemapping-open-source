import { dbAdapter } from "../client.ts";
import type { MindmapHistoryRow } from "../rows.ts";
import { decodeXml, encodeXml } from "../../domain/mindmapXml.ts";

/**
 * Map history.
 *
 * `MindmapManagerImpl.getHistoryFrom` hardcodes `setMaxResults(30)`, so only the
 * 30 newest entries are ever visible -- and `findMindmapHistory(mapId, hid)`
 * linear-scans that same capped list, which means an older entry is unreachable
 * by id even though it still exists in the table. Both behaviours are reproduced;
 * see `findByIdWithinCap`.
 *
 * Every function here is `async`, going through `dbAdapter` (Task 1.1,
 * tasks/plan.md) rather than the raw `bun:sqlite` `Database` (Task 4.1).
 */
export const HISTORY_LIMIT = 30;

export interface HistoryEntry {
  id: number;
  mindmapId: number;
  editorId: number;
  createdAt: Date;
  editorEmail: string;
}

interface HistoryListRow extends MindmapHistoryRow {
  editor_email: string;
}

function toEntry(row: HistoryListRow): HistoryEntry {
  return {
    id: row.id,
    mindmapId: row.mindmap_id,
    editorId: row.editor_id,
    createdAt: new Date(row.created_at),
    editorEmail: row.editor_email,
  };
}

/** Newest first, capped -- covered exactly by `ix_history_map_created`. */
export async function listForMap(mindmapId: number): Promise<HistoryEntry[]> {
  const rows = await dbAdapter.all<HistoryListRow>(
    `SELECT h.*, editor.email AS editor_email
     FROM   mindmap_history h
     JOIN   account editor ON editor.id = h.editor_id
     WHERE  h.mindmap_id = ?1
     ORDER  BY h.created_at DESC, h.id DESC
     LIMIT  ?2`,
    [mindmapId, HISTORY_LIMIT],
  );
  return rows.map(toEntry);
}

/**
 * Finds a history entry by id, but only within the newest `HISTORY_LIMIT`.
 *
 * The cap is deliberate: it is what the Java linear scan over the capped list
 * produces. Querying the row directly would make older revisions reachable that
 * the current API cannot return.
 */
export async function findByIdWithinCap(
  mindmapId: number,
  historyId: number,
): Promise<string | null> {
  const rows = await dbAdapter.all<{ id: number; xml: string }>(
    `SELECT id, xml FROM mindmap_history
     WHERE  mindmap_id = ?1
     ORDER  BY created_at DESC, id DESC
     LIMIT  ?2`,
    [mindmapId, HISTORY_LIMIT],
  );
  const row = rows.find((r) => r.id === historyId);
  return row === undefined ? null : decodeXml(row.xml);
}

/** The newest entry's XML, for reverting to `"latest"`. */
export async function latestXml(mindmapId: number): Promise<string | null> {
  const row = await dbAdapter.get<{ xml: string }>(
    `SELECT xml FROM mindmap_history
     WHERE  mindmap_id = ?1
     ORDER  BY created_at DESC, id DESC
     LIMIT  1`,
    [mindmapId],
  );
  return row == null ? null : decodeXml(row.xml);
}

export async function insert(
  mindmapId: number,
  editorId: number,
  xml: string,
): Promise<void> {
  await dbAdapter.run(
    `INSERT INTO mindmap_history (mindmap_id, editor_id, xml, created_at) VALUES (?1, ?2, ?3, ?4)`,
    [mindmapId, editorId, encodeXml(xml), Date.now()],
  );
}

export async function countForMap(mindmapId: number): Promise<number> {
  const row = await dbAdapter.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mindmap_history WHERE mindmap_id = ?1`,
    [mindmapId],
  );
  return row!.n;
}
