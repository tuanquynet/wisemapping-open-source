import { db } from "../client.ts";
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
export function listForMap(mindmapId: number): HistoryEntry[] {
  return db
    .query<HistoryListRow, [number, number]>(
      `SELECT h.*, editor.email AS editor_email
       FROM   mindmap_history h
       JOIN   account editor ON editor.id = h.editor_id
       WHERE  h.mindmap_id = ?1
       ORDER  BY h.created_at DESC, h.id DESC
       LIMIT  ?2`,
    )
    .all(mindmapId, HISTORY_LIMIT)
    .map(toEntry);
}

/**
 * Finds a history entry by id, but only within the newest `HISTORY_LIMIT`.
 *
 * The cap is deliberate: it is what the Java linear scan over the capped list
 * produces. Querying the row directly would make older revisions reachable that
 * the current API cannot return.
 */
export function findByIdWithinCap(
  mindmapId: number,
  historyId: number,
): string | null {
  const row = db
    .query<{ id: number; xml: string }, [number, number]>(
      `SELECT id, xml FROM mindmap_history
       WHERE  mindmap_id = ?1
       ORDER  BY created_at DESC, id DESC
       LIMIT  ?2`,
    )
    .all(mindmapId, HISTORY_LIMIT)
    .find((r) => r.id === historyId);
  return row === undefined ? null : decodeXml(row.xml);
}

/** The newest entry's XML, for reverting to `"latest"`. */
export function latestXml(mindmapId: number): string | null {
  const row = db
    .query<{ xml: string }, [number]>(
      `SELECT xml FROM mindmap_history
       WHERE  mindmap_id = ?1
       ORDER  BY created_at DESC, id DESC
       LIMIT  1`,
    )
    .get(mindmapId);
  return row == null ? null : decodeXml(row.xml);
}

export function insert(mindmapId: number, editorId: number, xml: string): void {
  db.run(
    `INSERT INTO mindmap_history (mindmap_id, editor_id, xml, created_at) VALUES (?1, ?2, ?3, ?4)`,
    [mindmapId, editorId, encodeXml(xml), Date.now()],
  );
}

export function countForMap(mindmapId: number): number {
  return db
    .query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n FROM mindmap_history WHERE mindmap_id = ?1`,
    )
    .get(mindmapId)!.n;
}
