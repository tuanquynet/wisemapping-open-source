import { db } from "../client.ts";
import { decodeXml, encodeXml } from "../../domain/mindmapXml.ts";

/**
 * Map documents, in their own table so that listing queries never page in
 * document overflow pages. All access goes through the codec in
 * `domain/mindmapXml.ts`.
 */

export function get(mindmapId: number): string | null {
  const row = db
    .query<{ xml: string }, [number]>(
      `SELECT xml FROM mindmap_xml WHERE mindmap_id = ?1`,
    )
    .get(mindmapId);
  return row == null ? null : decodeXml(row.xml);
}

export function upsert(mindmapId: number, xml: string): void {
  db.run(
    `INSERT INTO mindmap_xml (mindmap_id, xml) VALUES (?1, ?2)
     ON CONFLICT(mindmap_id) DO UPDATE SET xml = excluded.xml`,
    [mindmapId, encodeXml(xml)],
  );
}
