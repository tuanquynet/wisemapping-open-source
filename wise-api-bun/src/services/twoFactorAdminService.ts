import { dbAdapter } from "../db/client.ts";
import type { Statement } from "../db/adapter.ts";
import * as accounts from "../db/repos/accounts.ts";
import * as twoFactorRepo from "../db/repos/twoFactorRepo.ts";
import { BadRequestError, NotFoundError } from "../domain/errors.ts";
import type { PasswordHasher } from "../util/passwordHash.ts";

export interface ApproveResetParams {
  adminUser: { id: number; email: string };
  targetUserId: number;
  passwordInput: string;
  reasonInput: string;
  hasher: PasswordHasher;
  now?: number;
}

/**
 * Approves and executes an administrator 2FA reset in a single atomic batch (D14, AR16, FR30–FR33).
 *
 * 1. Requires and validates mandatory reason (FR31).
 * 2. Requires and verifies administrator's own password (FR30).
 * 3. Verifies target user exists and has 2FA enabled or pending.
 * 4. Executes atomic batch:
 *    - Deletes account_totp row
 *    - Deletes all account_recovery_code rows
 *    - Soft-revokes all trusted_device rows (revoked_at = now)
 *    - Increments target user's session_epoch (instantly revoking all active sessions per D9/FR32)
 *    - Sets two_factor_reenroll_required = 1 (forces re-enrollment per D14/FR33)
 *    - Records immutable security_event with actor, target, reason, and timestamp (FR36, FR38)
 */
export async function approveReset(params: ApproveResetParams): Promise<void> {
  const { adminUser, targetUserId, passwordInput, reasonInput, hasher } = params;
  const now = params.now ?? Date.now();

  // 1. Mandatory reason check (FR31)
  const reason = reasonInput.trim();
  if (reason.length === 0) {
    throw new BadRequestError("A reason is required to reset two-step verification.");
  }

  // 2. Admin password check (FR30)
  const adminAccount = await accounts.findRowByEmail(adminUser.email);
  if (!adminAccount || !adminAccount.password_hash) {
    throw new BadRequestError("Administrator password is required.");
  }
  const isPasswordValid = await hasher.verify(passwordInput, adminAccount.password_hash);
  if (!isPasswordValid) {
    throw new BadRequestError("Invalid administrator password.");
  }

  // 3. Target user existence check
  const targetAccount = await accounts.findById(targetUserId);
  if (!targetAccount) {
    throw new NotFoundError("Target user not found.");
  }

  const targetTotp = await twoFactorRepo.getTotpRow(targetUserId);
  if (!targetTotp && !targetAccount.twoFactorReenrollRequired) {
    throw new BadRequestError("Target user does not have two-step verification enabled.");
  }

  // 4. Atomic batch (D14, AR16, FR32)
  const statements: Statement[] = [
    {
      sql: "DELETE FROM account_totp WHERE account_id = ?1",
      params: [targetUserId],
    },
    {
      sql: "DELETE FROM account_recovery_code WHERE account_id = ?1",
      params: [targetUserId],
    },
    {
      sql: "UPDATE trusted_device SET revoked_at = ?2 WHERE account_id = ?1 AND revoked_at IS NULL",
      params: [targetUserId, now],
    },
    {
      sql: "UPDATE account SET session_epoch = session_epoch + 1, two_factor_reenroll_required = 1 WHERE id = ?1",
      params: [targetUserId],
    },
    {
      sql: `INSERT INTO security_event (
              affected_account_id, actor_email, action, outcome, reason, detail, created_at
            ) VALUES (?1, ?2, 'admin_reset_approved', 'success', ?3, ?4, ?5)`,
      params: [
        targetUserId,
        adminUser.email,
        reason,
        JSON.stringify({ targetEmail: targetAccount.email }),
        now,
      ],
    },
  ];

  await dbAdapter.batch(statements);
}
