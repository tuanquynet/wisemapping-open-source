import { dbAdapter } from "../client.ts";
import type { RestTwoFactorStatus } from "../../http/dto/restTwoFactor.ts";
import type { AccountTotpRow, AccountRow } from "../rows.ts";

/**
 * Reads the current two-factor authentication status for an account.
 */
export async function getStatus(accountId: number): Promise<RestTwoFactorStatus> {
  const [totpRow, accountRow, recoveryRow] = await Promise.all([
    dbAdapter.get<AccountTotpRow>(
      "SELECT status, activated_at, pending_secret_cipher FROM account_totp WHERE account_id = ?",
      [accountId],
    ),
    dbAdapter.get<Pick<AccountRow, "two_factor_reenroll_required">>(
      "SELECT two_factor_reenroll_required FROM account WHERE id = ?",
      [accountId],
    ),
    dbAdapter.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM account_recovery_code WHERE account_id = ? AND used_at IS NULL",
      [accountId],
    ),
  ]);
  const isActive = totpRow?.status === "active";
  const isPending = totpRow?.status === "pending" || Boolean(totpRow?.pending_secret_cipher);

  return {
    enabled: isActive,
    pendingEnrollment: isPending,
    recoveryCodesRemaining: recoveryRow?.count ?? 0,
    reenrollRequired: Boolean(accountRow?.two_factor_reenroll_required),
    activatedAt: isActive ? (totpRow?.activated_at ?? null) : null,
  };
}

/**
 * Creates or replaces the account's enrollment row as `pending` (D2, FR2).
 * One row per account (PK = FK): re-enrollment overwrites any previous
 * pending secret, and an abandoned-then-restarted flow resets all counters.
 */
export function savePendingEnrollment(
  accountId: number,
  secretCipher: string,
): Promise<void> {
  return dbAdapter.run(
    `INSERT INTO account_totp (
       account_id, secret_cipher, status, last_accepted_step,
       failed_attempts, cooldown_until, created_at, activated_at
     ) VALUES (?1, ?2, 'pending', NULL, 0, NULL, ?3, NULL)
     ON CONFLICT (account_id) DO UPDATE SET
       secret_cipher = excluded.secret_cipher,
       status = 'pending',
       last_accepted_step = NULL,
       failed_attempts = 0,
       cooldown_until = NULL,
       created_at = excluded.created_at,
       activated_at = NULL`,
    [accountId, secretCipher, Date.now()],
  );
}

/**
 * Discards a pending enrollment (FR6). Never touches an `active` row:
 * abandoning setup must never silently disable live protection.
 */
export function deletePendingEnrollment(accountId: number): Promise<void> {
  return dbAdapter.run(
    "DELETE FROM account_totp WHERE account_id = ? AND status = 'pending'",
    [accountId],
  );
}

/**
 * Returns the full account_totp row if it exists, or null.
 */
export function getTotpRow(accountId: number): Promise<AccountTotpRow | null> {
  return dbAdapter.get<AccountTotpRow>(
    "SELECT account_id, secret_cipher, status, last_accepted_step, failed_attempts, cooldown_until, created_at, activated_at, pending_secret_cipher FROM account_totp WHERE account_id = ?",
    [accountId],
  );
}

/**
 * Activates a pending enrollment row (FR5, D2).
 * Transitions status to 'active', updates activated_at and last_accepted_step,
 * and clears failure and cooldown counters.
 */
export function activateTotp(
  accountId: number,
  step: number,
  activatedAt: number = Date.now(),
): Promise<void> {
  return dbAdapter.run(
    `UPDATE account_totp
     SET status = 'active',
         activated_at = ?1,
         last_accepted_step = ?2,
         failed_attempts = 0,
         cooldown_until = NULL
     WHERE account_id = ?3 AND status = 'pending'`,
    [activatedAt, step, accountId],
  );
}

/**
 * Stores a pending replacement secret on an active enrollment (FR23).
 * The existing secret_cipher remains active and functional.
 */
export function savePendingReplacement(
  accountId: number,
  cipher: string,
): Promise<void> {
  return dbAdapter.run(
    "UPDATE account_totp SET pending_secret_cipher = ?1 WHERE account_id = ?2 AND status = 'active'",
    [cipher, accountId],
  );
}

/**
 * Activates a replacement secret (FR23, FR24).
 * Replaces secret_cipher with pending_secret_cipher and clears pending state.
 * Preserves existing recovery codes and device trust.
 */
export function activateReplacement(
  accountId: number,
  step: number,
): Promise<void> {
  return dbAdapter.run(
    `UPDATE account_totp
     SET secret_cipher = pending_secret_cipher,
         pending_secret_cipher = NULL,
         last_accepted_step = ?1,
         failed_attempts = 0,
         cooldown_until = NULL
     WHERE account_id = ?2 AND status = 'active' AND pending_secret_cipher IS NOT NULL`,
    [step, accountId],
  );
}

/**
 * Clears a pending replacement secret without affecting the active enrollment (FR23).
 */
export function deletePendingReplacement(accountId: number): Promise<void> {
  return dbAdapter.run(
    "UPDATE account_totp SET pending_secret_cipher = NULL WHERE account_id = ? AND status = 'active'",
    [accountId],
  );
}

/**
 * Stores a newly generated set of recovery codes for an account (FR7, D3, D7).
 * Replaces any existing recovery codes for the account to ensure set consistency.
 */
export async function saveRecoveryCodes(
  accountId: number,
  codeHashes: string[],
  generation: number = 1,
): Promise<void> {
  const now = Date.now();
  // Remove any pre-existing codes (e.g. from an earlier enrollment or reset)
  await dbAdapter.run(
    "DELETE FROM account_recovery_code WHERE account_id = ?",
    [accountId],
  );
  for (const hash of codeHashes) {
    await dbAdapter.run(
      `INSERT INTO account_recovery_code (
         account_id, code_hash, generation, used_at, created_at
       ) VALUES (?1, ?2, ?3, NULL, ?4)`,
      [accountId, hash, generation, now],
    );
  }
}

/**
 * Regenerates recovery codes for an account (FR22, D3, D7).
 * Bumps the set generation (max(generation) + 1), deletes all existing codes,
 * and inserts the new code hashes.
 */
export async function regenerateRecoveryCodes(
  accountId: number,
  codeHashes: string[],
): Promise<number> {
  const row = await dbAdapter.get<{ max_gen: number | null }>(
    "SELECT MAX(generation) AS max_gen FROM account_recovery_code WHERE account_id = ?",
    [accountId],
  );
  const nextGeneration = (row?.max_gen ?? 0) + 1;
  await saveRecoveryCodes(accountId, codeHashes, nextGeneration);
  return nextGeneration;
}

/**
 * Atomically disables two-factor authentication for an account (FR25, FR27).
 * Removes account_totp, removes all recovery codes, and soft-revokes all trusted devices.
 */
export async function disableTwoFactor(
  accountId: number,
  now: number = Date.now(),
): Promise<void> {
  await dbAdapter.run("DELETE FROM account_totp WHERE account_id = ?", [accountId]);
  await dbAdapter.run("DELETE FROM account_recovery_code WHERE account_id = ?", [accountId]);
  await dbAdapter.run(
    "UPDATE trusted_device SET revoked_at = ?1 WHERE account_id = ?2 AND revoked_at IS NULL",
    [now, accountId],
  );
}

export interface ConsumeRecoveryCodeResult {
  success: boolean;
  alreadyUsed: boolean;
  remainingCount: number;
}

/**
 * Atomically consumes a single-use recovery code (D4, AR31, FR20).
 * Uses a single conditional UPDATE ... WHERE used_at IS NULL RETURNING id
 * to guarantee that concurrent submissions produce exactly one success.
 */
export async function consumeRecoveryCode(
  accountId: number,
  codeHash: string,
  now: number = Date.now(),
): Promise<ConsumeRecoveryCodeResult> {
  // D4: Single conditional UPDATE with RETURNING id for atomicity
  const updated = await dbAdapter.get<{ id: number }>(
    `UPDATE account_recovery_code
     SET used_at = ?1
     WHERE account_id = ?2 AND code_hash = ?3 AND used_at IS NULL
     RETURNING id`,
    [now, accountId, codeHash],
  );

  const remaining = await dbAdapter.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM account_recovery_code WHERE account_id = ? AND used_at IS NULL",
    [accountId],
  );
  const remainingCount = remaining?.count ?? 0;

  if (updated !== null) {
    return { success: true, alreadyUsed: false, remainingCount };
  }

  // Check if code was previously used or simply invalid
  const existing = await dbAdapter.get<{ used_at: number | null }>(
    "SELECT used_at FROM account_recovery_code WHERE account_id = ? AND code_hash = ?",
    [accountId, codeHash],
  );

  const alreadyUsed = existing !== null && existing.used_at !== null;
  return { success: false, alreadyUsed, remainingCount };
}

const MAX_ATTEMPTS = 5;
const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

export interface FailedAttemptResult {
  failedAttempts: number;
  cooldownUntil: number | null;
  isNewCooldown: boolean;
}

/**
 * Records a failed verification attempt and enforces the 5-failure cooldown (D8, FR13).
 */
export async function recordFailedAttempt(
  accountId: number,
  now: number = Date.now(),
): Promise<FailedAttemptResult> {
  const row = await dbAdapter.get<{
    failed_attempts: number;
    cooldown_until: number | null;
  }>(
    "SELECT failed_attempts, cooldown_until FROM account_totp WHERE account_id = ?",
    [accountId],
  );

  let attempts = (row?.failed_attempts ?? 0) + 1;
  let cooldownUntil = row?.cooldown_until ?? null;
  let isNewCooldown = false;

  // If previous cooldown has expired, reset counter to 1
  if (cooldownUntil !== null && cooldownUntil <= now) {
    attempts = 1;
    cooldownUntil = null;
  }

  if (attempts >= MAX_ATTEMPTS) {
    cooldownUntil = now + COOLDOWN_MS;
    isNewCooldown = true;
  }

  await dbAdapter.run(
    `UPDATE account_totp
     SET failed_attempts = ?1,
         cooldown_until = ?2
     WHERE account_id = ?3`,
    [attempts, cooldownUntil, accountId],
  );

  return { failedAttempts: attempts, cooldownUntil, isNewCooldown };
}

/**
 * Resets failed attempts and clears cooldown on successful verification (D8).
 */
export function clearCooldownAndFailures(accountId: number): Promise<void> {
  return dbAdapter.run(
    "UPDATE account_totp SET failed_attempts = 0, cooldown_until = NULL WHERE account_id = ?",
    [accountId],
  );
}
