import { db } from "../client.ts";
import type { CollaborationRow } from "../rows.ts";
import {
  DEFAULT_MINDMAP_PROPERTIES,
  type Collaboration,
} from "../../domain/types.ts";
import type { Role } from "../../domain/roles.ts";

interface CollaborationWithEmailRow extends CollaborationRow {
  email: string;
}

function toCollaboration(row: CollaborationRow): Collaboration {
  return {
    id: row.id,
    mindmapId: row.mindmap_id,
    accountId: row.account_id,
    role: row.role,
    starred: row.starred === 1,
    // The `{"zoom":0.8}` default lives in Java code, not the schema.
    mindmapProperties: row.mindmap_properties ?? DEFAULT_MINDMAP_PROPERTIES,
  };
}

export interface CollaborationWithEmail extends Collaboration {
  email: string;
}

/** The authorization primitive -- the single hottest query in the app. */
export function findForMapAndAccount(
  mindmapId: number,
  accountId: number,
): Collaboration | null {
  const row = db
    .query<CollaborationRow, [number, number]>(
      `SELECT * FROM collaboration WHERE mindmap_id = ?1 AND account_id = ?2`,
    )
    .get(mindmapId, accountId);
  return row == null ? null : toCollaboration(row);
}

export function listForMap(mindmapId: number): CollaborationWithEmail[] {
  return db
    .query<CollaborationWithEmailRow, [number]>(
      `SELECT c.*, a.email
       FROM   collaboration c
       JOIN   account a ON a.id = c.account_id
       WHERE  c.mindmap_id = ?1
       ORDER  BY c.id`,
    )
    .all(mindmapId)
    .map((row) => ({ ...toCollaboration(row), email: row.email }));
}

export function findByEmail(
  mindmapId: number,
  email: string,
): CollaborationWithEmail | null {
  const row = db
    .query<CollaborationWithEmailRow, [number, string]>(
      `SELECT c.*, a.email
       FROM   collaboration c
       JOIN   account a ON a.id = c.account_id
       WHERE  c.mindmap_id = ?1 AND a.email_lower = ?2`,
    )
    .get(mindmapId, email.trim().toLowerCase());
  return row == null ? null : { ...toCollaboration(row), email: row.email };
}

/**
 * Find-or-create, replacing `MindmapManagerImpl.findOrCreateCollaboration`.
 *
 * That method is a select-then-insert that races because the Java schema has no
 * unique constraint on (mindmap, collaborator). Here `ux_collab_map_account`
 * exists, so this is a single atomic upsert and the race is gone.
 */
export function upsert(
  mindmapId: number,
  accountId: number,
  role: Role,
): Collaboration {
  const row = db
    .query<CollaborationRow, [number, number, Role, number]>(
      `INSERT INTO collaboration (mindmap_id, account_id, role, starred, created_at)
       VALUES (?1, ?2, ?3, 0, ?4)
       ON CONFLICT(mindmap_id, account_id) DO UPDATE SET role = excluded.role
       RETURNING *`,
    )
    .get(mindmapId, accountId, role, Date.now())!;
  return toCollaboration(row);
}

export function updateStarred(
  mindmapId: number,
  accountId: number,
  starred: boolean,
): void {
  db.run(
    `UPDATE collaboration SET starred = ?1 WHERE mindmap_id = ?2 AND account_id = ?3`,
    [starred ? 1 : 0, mindmapId, accountId],
  );
}

export function updateProperties(
  mindmapId: number,
  accountId: number,
  properties: string,
): void {
  db.run(
    `UPDATE collaboration SET mindmap_properties = ?1 WHERE mindmap_id = ?2 AND account_id = ?3`,
    [properties, mindmapId, accountId],
  );
}

export function deleteById(id: number): void {
  db.run(`DELETE FROM collaboration WHERE id = ?1`, [id]);
}
