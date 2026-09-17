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
  session_epoch: number;
  two_factor_reenroll_required: 0 | 1;
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
  source_type: "local" | "gdrive";
  source_id: string | null;
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

export interface CommentRow {
  id: number;
  mindmap_id: number;
  topic_id: string;
  author_id: number;
  body: string;
  created_at: number;
}

export interface AccountTotpRow {
  account_id: number;
  secret_cipher: string;
  status: "pending" | "active";
  last_accepted_step: number | null;
  failed_attempts: number;
  cooldown_until: number | null;
  created_at: number;
  activated_at: number | null;
  pending_secret_cipher: string | null;
}

export interface AccountRecoveryCodeRow {
  id: number;
  account_id: number;
  code_hash: string;
  generation: number;
  used_at: number | null;
  created_at: number;
}

export interface TrustedDeviceRow {
  id: number;
  account_id: number;
  token_hash: string;
  label: string;
  created_at: number;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface SecurityEventRow {
  id: number;
  affected_account_id: number;
  actor_email: string;
  action: string;
  outcome: "success" | "failure";
  reason: string | null;
  detail: string | null;
  created_at: number;
}
