import { dbAdapter } from "../client.ts";
import type { SecurityEventRow } from "../rows.ts";

export interface RecordSecurityEventParams {
  affectedAccountId: number;
  actorEmail: string;
  action: string;
  outcome: "success" | "failure";
  reason?: string | null;
  detail?: string | null;
  createdAt?: number;
}

/**
 * Appends an immutable security audit event (FR36, FR38, D15).
 * Secrets, TOTP codes, and recovery codes are NEVER recorded.
 */
export function recordSecurityEvent(
  params: RecordSecurityEventParams,
): Promise<void> {
  return dbAdapter.run(
    `INSERT INTO security_event (
       affected_account_id, actor_email, action, outcome, reason, detail, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    [
      params.affectedAccountId,
      params.actorEmail,
      params.action,
      params.outcome,
      params.reason ?? null,
      params.detail ?? null,
      params.createdAt ?? Date.now(),
    ],
  );
}

/**
 * Lists the security events for a specific account, ordered newest first (FR34, FR37).
 */
export function listSecurityEventsForAccount(
  accountId: number,
  limit: number = 50,
): Promise<SecurityEventRow[]> {
  return dbAdapter.all<SecurityEventRow>(
    "SELECT id, affected_account_id, actor_email, action, outcome, reason, detail, created_at FROM security_event WHERE affected_account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    [accountId, limit],
  );
}

export interface SecurityEventsFilterOptions {
  page?: number | undefined;
  pageSize?: number | undefined;
  account?: string | undefined;
  action?: string | undefined;
  fromDate?: number | undefined;
  toDate?: number | undefined;
}

export interface SecurityEventAdminRow extends SecurityEventRow {
  affected_account_email: string | null;
}

function buildSecurityEventFilters(opts: SecurityEventsFilterOptions): {
  where: string;
  params: unknown[];
} {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.account && opts.account.trim() !== "") {
    const term = opts.account.trim();
    const pattern = `%${term.toLowerCase()}%`;
    const isNum = /^\d+$/.test(term);
    if (isNum) {
      const num = parseInt(term, 10);
      params.push(num, pattern, pattern);
      const p1 = params.length - 2;
      const p2 = params.length - 1;
      const p3 = params.length;
      conditions.push(
        `(se.affected_account_id = ?${p1} OR LOWER(se.actor_email) LIKE ?${p2} OR LOWER(COALESCE(a.email, '')) LIKE ?${p3})`,
      );
    } else {
      params.push(pattern, pattern);
      const p1 = params.length - 1;
      const p2 = params.length;
      conditions.push(
        `(LOWER(se.actor_email) LIKE ?${p1} OR LOWER(COALESCE(a.email, '')) LIKE ?${p2})`,
      );
    }
  }

  if (opts.action && opts.action.trim() !== "") {
    params.push(opts.action.trim());
    conditions.push(`se.action = ?${params.length}`);
  }

  if (typeof opts.fromDate === "number" && !Number.isNaN(opts.fromDate)) {
    params.push(opts.fromDate);
    conditions.push(`se.created_at >= ?${params.length}`);
  }

  if (typeof opts.toDate === "number" && !Number.isNaN(opts.toDate)) {
    params.push(opts.toDate);
    conditions.push(`se.created_at <= ?${params.length}`);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

/**
 * Query security events with filtering and pagination (FR37, UX-DR21).
 */
export async function findSecurityEventsWithFilters(
  opts: SecurityEventsFilterOptions,
): Promise<SecurityEventAdminRow[]> {
  const { where, params } = buildSecurityEventFilters(opts);
  const page = Math.max(0, opts.page ?? 0);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 20));
  const offset = page * pageSize;

  const limitParamIdx = params.length + 1;
  const offsetParamIdx = params.length + 2;
  const queryParams = [...params, pageSize, offset];

  const sql = `
    SELECT
      se.id,
      se.affected_account_id,
      se.actor_email,
      se.action,
      se.outcome,
      se.reason,
      se.detail,
      se.created_at,
      a.email AS affected_account_email
    FROM security_event se
    LEFT JOIN account a ON a.id = se.affected_account_id
    ${where}
    ORDER BY se.created_at DESC, se.id DESC
    LIMIT ?${limitParamIdx} OFFSET ?${offsetParamIdx}
  `;
  return dbAdapter.all<SecurityEventAdminRow>(sql, queryParams);
}

/**
 * Count total security events matching filters (FR37, UX-DR21).
 */
export async function countSecurityEventsWithFilters(
  opts: SecurityEventsFilterOptions,
): Promise<number> {
  const { where, params } = buildSecurityEventFilters(opts);
  const sql = `
    SELECT COUNT(*) AS count
    FROM security_event se
    LEFT JOIN account a ON a.id = se.affected_account_id
    ${where}
  `;
  const row = await dbAdapter.get<{ count: number }>(sql, params);
  return row?.count ?? 0;
}
