import { dbAdapter } from "../client.ts";
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
    sourceType: row.source_type ?? "local",
    sourceId: row.source_id ?? null,
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

export async function findById(id: number): Promise<MindmapWithPeople | null> {
  const row = await dbAdapter.get<MindmapPeopleRow>(
    `SELECT ${PEOPLE_COLUMNS} ${PEOPLE_JOIN} WHERE m.id = ?1`,
    [id],
  );
  return row === null ? null : toWithPeople(row);
}

/** Backs the duplicate-title rule that `MapInfoValidator` enforces. */
export async function findByCreatorAndTitle(
  creatorId: number,
  title: string,
): Promise<Mindmap | null> {
  const row = await dbAdapter.get<MindmapRow>(
    `SELECT * FROM mindmap WHERE creator_id = ?1 AND title = ?2`,
    [creatorId, title],
  );
  return row === null ? null : toMindmap(row);
}

export async function findByCreatorAndSource(
  creatorId: number,
  sourceType: string,
  sourceId: string,
): Promise<Mindmap | null> {
  const row = await dbAdapter.get<MindmapRow>(
    `SELECT * FROM mindmap WHERE creator_id = ?1 AND source_type = ?2 AND source_id = ?3`,
    [creatorId, sourceType, sourceId],
  );
  return row === null ? null : toMindmap(row);
}

export async function findByCreator(creatorId: number): Promise<Mindmap[]> {
  const rows = await dbAdapter.all<MindmapRow>(
    `SELECT * FROM mindmap WHERE creator_id = ?1`,
    [creatorId],
  );
  return rows.map(toMindmap);
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
export async function listForAccount(
  accountId: number,
  limit: number,
): Promise<ListedMindmap[]> {
  const rows = await dbAdapter.all<ListRow>(
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
    [accountId, limit],
  );
  return rows.map((row) => ({
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
  sourceType?: "local" | "gdrive";
  sourceId?: string | null;
}

/**
 * Creates a map with its XML and the creator's OWNER collaboration
 * atomically, mirroring `MindmapServiceImpl.addMindmap` (which adds the
 * owner collaboration as part of the same unit of work).
 *
 * Three statements in one `adapter.batch()` call (Architecture Decision 2,
 * tasks/plan.md) -- no branching needed, since none of the three reads the
 * others' result to decide what to write; the second and third only need
 * the first statement's generated id, which `batch()` cannot pass between
 * statements. Worked around by inlining `last_insert_rowid()` in SQL rather
 * than passing a value between statements -- verified this carries correctly
 * across statements within one `db.transaction()` on Bun; **must be
 * reconfirmed against D1's real `batch()` before Task 6.2 wires a
 * `D1Adapter`, since D1 has not been shown to preserve connection-scoped
 * `last_insert_rowid()` state across statements in the same batch the way a
 * single embedded SQLite connection does.**
 */
export async function insert(input: NewMindmap, xml: string): Promise<Mindmap> {
  const now = Date.now();
  const sourceType = input.sourceType ?? "local";
  const sourceId = input.sourceId ?? null;

  const [mindmapRows] = await dbAdapter.batch<MindmapRow>([
    {
      sql: `INSERT INTO mindmap (title, description, is_public, creator_id, last_editor_id, created_at, edited_at, source_type, source_id)
            VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?5, ?6, ?7)
            RETURNING *`,
      params: [
        input.title,
        input.description,
        input.isPublic ? 1 : 0,
        input.creatorId,
        now,
        sourceType,
        sourceId,
      ],
    },
    {
      sql: `INSERT INTO mindmap_xml (mindmap_id, xml) VALUES (last_insert_rowid(), ?1)`,
      params: [xml],
    },
    {
      sql: `INSERT INTO collaboration (mindmap_id, account_id, role, starred, created_at)
            VALUES (last_insert_rowid(), ?1, 'owner', 0, ?2)`,
      params: [input.creatorId, now],
    },
  ]);

  return toMindmap(mindmapRows![0]!);
}

export async function updateTitle(id: number, title: string): Promise<void> {
  await dbAdapter.run(`UPDATE mindmap SET title = ?1 WHERE id = ?2`, [
    title,
    id,
  ]);
}

export async function updateDescription(
  id: number,
  description: string,
): Promise<void> {
  await dbAdapter.run(`UPDATE mindmap SET description = ?1 WHERE id = ?2`, [
    description,
    id,
  ]);
}

export async function updatePublic(id: number, isPublic: boolean): Promise<void> {
  await dbAdapter.run(`UPDATE mindmap SET is_public = ?1 WHERE id = ?2`, [
    isPublic ? 1 : 0,
    id,
  ]);
}

/** Stamps the editor and modification time, as `saveMindmapDocument` does. */
export async function touch(id: number, editorId: number): Promise<void> {
  await dbAdapter.run(
    `UPDATE mindmap SET last_editor_id = ?1, edited_at = ?2 WHERE id = ?3`,
    [editorId, Date.now(), id],
  );
}

export async function deleteById(id: number): Promise<void> {
  // XML, history, collaborations and label links all go via ON DELETE CASCADE.
  await dbAdapter.run(`DELETE FROM mindmap WHERE id = ?1`, [id]);
}

export interface MindmapFilterOptions {
  search?: string | undefined;
  filterPublic?: boolean | undefined;
  sortBy?: string | undefined;
  sortOrder?: "asc" | "desc" | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

const ALLOWED_MAP_SORT_COLUMNS: Record<string, string> = {
  id: "m.id",
  title: "LOWER(m.title)",
  creationdate: "m.created_at",
  createdat: "m.created_at",
  creationtime: "m.created_at",
  editedat: "m.edited_at",
  lastmodificationtime: "m.edited_at",
};

function buildMapFilterClauses(opts: MindmapFilterOptions): {
  where: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.search && opts.search.trim() !== "") {
    const pattern = `%${opts.search.trim().toLowerCase()}%`;
    params.push(pattern, pattern);
    const p1 = params.length - 1;
    const p2 = params.length;
    conditions.push(
      `(LOWER(m.title) LIKE ?${p1} OR LOWER(COALESCE(m.description, '')) LIKE ?${p2})`,
    );
  }

  if (opts.filterPublic !== undefined) {
    params.push(opts.filterPublic ? 1 : 0);
    conditions.push(`m.is_public = ?${params.length}`);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

export async function findWithFilters(
  opts: MindmapFilterOptions,
): Promise<MindmapWithPeople[]> {
  const { where, params } = buildMapFilterClauses(opts);
  const sortCol =
    ALLOWED_MAP_SORT_COLUMNS[opts.sortBy?.toLowerCase() ?? ""] ?? "m.created_at";
  const sortDir = opts.sortOrder?.toLowerCase() === "desc" ? "DESC" : "ASC";

  const page = Math.max(0, opts.page ?? 0);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 10));
  const offset = page * pageSize;

  const limitParamIdx = params.length + 1;
  const offsetParamIdx = params.length + 2;
  const queryParams = [...params, pageSize, offset];
  const sql = `SELECT ${PEOPLE_COLUMNS} ${PEOPLE_JOIN} ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ?${limitParamIdx} OFFSET ?${offsetParamIdx}`;
  const rows = await dbAdapter.all<MindmapPeopleRow>(sql, queryParams);
  return rows.map(toWithPeople);
}

export async function countWithFilters(
  opts: MindmapFilterOptions,
): Promise<number> {
  const { where, params } = buildMapFilterClauses(opts);
  const sql = `SELECT COUNT(*) as count FROM mindmap m ${where}`;
  const row = await dbAdapter.get<{ count: number }>(sql, params);
  return row?.count ?? 0;
}
