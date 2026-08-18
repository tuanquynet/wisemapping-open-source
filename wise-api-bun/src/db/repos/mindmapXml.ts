import { dbAdapter } from "../client.ts";
import { decodeXml, encodeXml } from "../../domain/mindmapXml.ts";

/**
 * Map documents, in their own table so that listing queries never page in
 * document overflow pages. All access goes through the codec in
 * `domain/mindmapXml.ts`.
 *
 * Every function here is `async`, going through `dbAdapter` (Task 1.1,
 * tasks/plan.md) rather than the raw `bun:sqlite` `Database` (Task 3.1).
 */

export async function get(mindmapId: number): Promise<string | null> {
  const row = await dbAdapter.get<{ xml: string }>(
    `SELECT xml FROM mindmap_xml WHERE mindmap_id = ?1`,
    [mindmapId],
  );
  return row == null ? null : decodeXml(row.xml);
}

export async function upsert(mindmapId: number, xml: string): Promise<void> {
  await dbAdapter.run(
    `INSERT INTO mindmap_xml (mindmap_id, xml) VALUES (?1, ?2)
     ON CONFLICT(mindmap_id) DO UPDATE SET xml = excluded.xml`,
    [mindmapId, encodeXml(xml)],
  );
}
