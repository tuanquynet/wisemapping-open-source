import { db } from "../client.ts";
import type { MindmapRow } from "../rows.ts";
import type { Mindmap, MindmapWithPeople } from "../../domain/types.ts";
import type { Role } from "../../domain/roles.ts";

/** Columns of the people-joined projection, shared by the single and list reads. */
interface MindmapPeopleRow extends MindmapRow {
  creator_email: string;
  creator_firstname: string | null;
  creator_lastname: string | null;
  editor_email: string;
  editor_firstname: string | null;
  editor_lastname: string | null;
}

interface ListRow extends MindmapPeopleRow {
  my_role: Role;
  my_starred: 0 | 1;
}

function toMindmap(row: MindmapRow): Mindmap {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    isPublic: row.is_public === 1,
    creatorId: row.creator_id,
    lastEditorId: row.last_editor_id,
    createdAt: new Date(row.created_at),
    editedAt: new Date(row.edited_at),
  };
}

function toWithPeople(row: MindmapPeopleRow): MindmapWithPeople {
  return {
    ...toMindmap(row),
    creatorEmail: row.creator_email,
    creatorFirstname: row.creator_firstname ?? "",
    creatorLastname: row.creator_lastname ?? "",
    lastEditorEmail: row.editor_email,
    lastEditorFirstname: row.editor_firstname ?? "",
    lastEditorLastname: row.editor_lastname ?? "",
  };
}

const PEOPLE_JOIN = `
  FROM   mindmap m
  JOIN   account creator ON creator.id = m.creator_id
  JOIN   account editor  ON editor.id  = m.last_editor_id`;

const PEOPLE_COLUMNS = `
  m.*,
  creator.email     AS creator_email,
  creator.firstname AS creator_firstname,
  creator.lastname  AS creator_lastname,
  editor.email      AS editor_email,
  editor.firstname  AS editor_firstname,
  editor.lastname   AS editor_lastname`;

export function findById(id: number): MindmapWithPeople | null {
  const row = db
    .query<MindmapPeopleRow, [number]>(
      `SELECT ${PEOPLE_COLUMNS} ${PEOPLE_JOIN} WHERE m.id = ?1`,
    )
    .get(id);
  return row == null ? null : toWithPeople(row);
}

/** Backs the duplicate-title rule that `MapInfoValidator` enforces. */
export function findByCreatorAndTitle(
  creatorId: number,
  title: string,
): Mindmap | null {
  const row = db
    .query<MindmapRow, [number, string]>(
      `SELECT * FROM mindmap WHERE creator_id = ?1 AND title = ?2`,
    )
    .get(creatorId, title);
  return row == null ? null : toMindmap(row);
}

export interface ListedMindmap extends MindmapWithPeople {
  myRole: Role;
  myStarred: boolean;
}

/**
 * Every map the account can see, newest-edited first.
 *
 * Driven from `collaboration` rather than from `mindmap` with an `IN (subquery)`
 * as `findMindmapByUser` does, so `ix_collab_account` does the work and the
 * caller's own role and starred flag come back for free -- the Java controller
 * needs a separate `buildCollaborationsByMindmap` pass to get them.
 *
 * The LIMIT reproduces `app.mindmap.list.max-size`. It is applied BEFORE `?q=`
 * filtering, matching the Java order, so a filter can legitimately return fewer
 * results than exist.
 */
export function listForAccount(
  accountId: number,
  limit: number,
): ListedMindmap[] {
  return db
    .query<ListRow, [number, number]>(
      `SELECT ${PEOPLE_COLUMNS},
              c.role    AS my_role,
              c.starred AS my_starred
       FROM   collaboration c
       JOIN   mindmap m       ON m.id       = c.mindmap_id
       JOIN   account creator ON creator.id = m.creator_id
       JOIN   account editor  ON editor.id  = m.last_editor_id
       WHERE  c.account_id = ?1
       ORDER  BY m.edited_at DESC, m.id DESC
       LIMIT  ?2`,
    )
    .all(accountId, limit)
    .map((row) => ({
      ...toWithPeople(row),
      myRole: row.my_role,
      myStarred: row.my_starred === 1,
    }));
}

export interface NewMindmap {
  title: string;
  description: string | null;
  creatorId: number;
  isPublic: boolean;
}

/**
 * Creates a map with its XML and the creator's OWNER collaboration in one
 * transaction, mirroring `MindmapServiceImpl.addMindmap` (which adds the owner
 * collaboration as part of the same unit of work).
 */
export function insert(input: NewMindmap, xml: string): Mindmap {
  return db.transaction(() => {
    const now = Date.now();
    const row = db
      .query<MindmapRow, [string, string | null, number, number, number]>(
        `INSERT INTO mindmap (title, description, is_public, creator_id, last_editor_id, created_at, edited_at)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?5)
         RETURNING *`,
      )
      .get(
        input.title,
        input.description,
        input.isPublic ? 1 : 0,
        input.creatorId,
        now,
      )!;

    db.run(`INSERT INTO mindmap_xml (mindmap_id, xml) VALUES (?1, ?2)`, [
      row.id,
      xml,
    ]);
    db.run(
      `INSERT INTO collaboration (mindmap_id, account_id, role, starred, created_at)
       VALUES (?1, ?2, 'owner', 0, ?3)`,
      [row.id, input.creatorId, now],
    );

    return toMindmap(row);
  })();
}

export function updateTitle(id: number, title: string): void {
  db.run(`UPDATE mindmap SET title = ?1 WHERE id = ?2`, [title, id]);
}

export function updateDescription(id: number, description: string): void {
  db.run(`UPDATE mindmap SET description = ?1 WHERE id = ?2`, [
    description,
    id,
  ]);
}

export function updatePublic(id: number, isPublic: boolean): void {
  db.run(`UPDATE mindmap SET is_public = ?1 WHERE id = ?2`, [
    isPublic ? 1 : 0,
    id,
  ]);
}

/** Stamps the editor and modification time, as `saveMindmapDocument` does. */
export function touch(id: number, editorId: number): void {
  db.run(
    `UPDATE mindmap SET last_editor_id = ?1, edited_at = ?2 WHERE id = ?3`,
    [editorId, Date.now(), id],
  );
}

export function deleteById(id: number): void {
  // XML, history, collaborations and label links all go via ON DELETE CASCADE.
  db.run(`DELETE FROM mindmap WHERE id = ?1`, [id]);
}
