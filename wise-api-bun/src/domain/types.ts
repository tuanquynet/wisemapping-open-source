/**
 * Domain types -- camelCase, real `Date`s and booleans.
 *
 * Distinct from the snake_case row shapes in `db/rows.ts`: repositories convert
 * at the boundary so no `0 | 1` or millisecond integer escapes into a service.
 */

export interface Account {
  id: number;
  email: string;
  firstname: string;
  lastname: string;
  locale: string | null;
  /** False for invitee placeholders created by sharing to an unknown email. */
  isRegistered: boolean;
  activatedAt: Date | null;
  createdAt: Date;
}

export function fullName(account: Account): string {
  return `${account.firstname} ${account.lastname}`.trim();
}

export interface Mindmap {
  id: number;
  title: string;
  description: string | null;
  isPublic: boolean;
  creatorId: number;
  lastEditorId: number;
  createdAt: Date;
  editedAt: Date;
  sourceType: "local" | "gdrive";
  sourceId: string | null;
}

/**
 * A mindmap plus the joined display fields every DTO needs, so rendering a
 * response never triggers a follow-up query per row.
 */
export interface MindmapWithPeople extends Mindmap {
  creatorEmail: string;
  creatorFirstname: string;
  creatorLastname: string;
  lastEditorEmail: string;
  lastEditorFirstname: string;
  lastEditorLastname: string;
}

export interface Label {
  id: number;
  title: string;
  color: string;
  creatorId: number;
}

export interface Collaboration {
  id: number;
  mindmapId: number;
  accountId: number;
  role: import("./roles.ts").Role;
  starred: boolean;
  /** Never null: the `{"zoom":0.8}` default is applied when reading. */
  mindmapProperties: string;
}

/**
 * `CollaborationProperties.getMindmapProperties()` returns this when the column
 * is null. The default lives in Java code, not in the database, so it is applied
 * at read time here too rather than as a column DEFAULT.
 */
export const DEFAULT_MINDMAP_PROPERTIES = '{"zoom":0.8}';
