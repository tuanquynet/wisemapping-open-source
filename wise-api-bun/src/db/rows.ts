/**
 * Row shapes, mirroring schema.sql literally: snake_case names, integer
 * booleans, millisecond timestamps.
 *
 * Repositories are the only place these appear. Converting here rather than in
 * services is what stops a `0 | 1` or a raw millisecond integer reaching a DTO.
 */

export interface AccountRow {
  id: number;
  email: string;
  email_lower: string;
  firstname: string | null;
  lastname: string | null;
  password_hash: string | null;
  locale: string | null;
  activation_code: string | null;
  activated_at: number | null;
  reset_token: string | null;
  reset_token_expires: number | null;
  created_at: number;
}

export interface MindmapRow {
  id: number;
  title: string;
  description: string | null;
  is_public: 0 | 1;
  creator_id: number;
  last_editor_id: number;
  created_at: number;
  edited_at: number;
}

export interface MindmapHistoryRow {
  id: number;
  mindmap_id: number;
  editor_id: number;
  xml: string;
  created_at: number;
}

export interface LabelRow {
  id: number;
  title: string;
  color: string;
  creator_id: number;
  created_at: number;
}

export interface CollaborationRow {
  id: number;
  mindmap_id: number;
  account_id: number;
  role: "owner" | "editor" | "viewer";
  starred: 0 | 1;
  mindmap_properties: string | null;
  created_at: number;
}
