import { dbAdapter } from "../client.ts";
import type { TrustedDeviceRow } from "../rows.ts";

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface InsertTrustedDeviceParams {
  accountId: number;
  tokenHash: string;
  label: string;
  now?: number;
}

/**
 * Inserts a trusted device with a fixed 30-day absolute expiration (D5, D12, FR15, FR17).
 */
export async function insertTrustedDevice(
  params: InsertTrustedDeviceParams,
): Promise<TrustedDeviceRow> {
  const now = params.now ?? Date.now();
  const expiresAt = now + THIRTY_DAYS_MS;
  return (await dbAdapter.get<TrustedDeviceRow>(
    `INSERT INTO trusted_device (
       account_id, token_hash, label, created_at, expires_at, last_used_at, revoked_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?4, NULL)
     RETURNING id, account_id, token_hash, label, created_at, expires_at, last_used_at, revoked_at`,
    [params.accountId, params.tokenHash, params.label, now, expiresAt],
  ))!;
}

/**
 * Finds an active (unrevoked and unexpired) trusted device by its SHA-256 token hash (FR16).
 */
export function findLiveDevice(
  accountId: number,
  tokenHash: string,
  now: number = Date.now(),
): Promise<TrustedDeviceRow | null> {
  return dbAdapter.get<TrustedDeviceRow>(
    `SELECT id, account_id, token_hash, label, created_at, expires_at, last_used_at, revoked_at
     FROM trusted_device
     WHERE account_id = ?1
       AND token_hash = ?2
       AND revoked_at IS NULL
       AND expires_at > ?3`,
    [accountId, tokenHash, now],
  );
}

/**
 * Lists all active (unrevoked and unexpired) trusted devices for an account (FR18).
 */
export function listActiveDevices(
  accountId: number,
  now: number = Date.now(),
): Promise<TrustedDeviceRow[]> {
  return dbAdapter.all<TrustedDeviceRow>(
    `SELECT id, account_id, token_hash, label, created_at, expires_at, last_used_at, revoked_at
     FROM trusted_device
     WHERE account_id = ?1
       AND revoked_at IS NULL
       AND expires_at > ?2
     ORDER BY created_at DESC`,
    [accountId, now],
  );
}

/**
 * Updates the last_used_at timestamp of an active trusted device (FR16).
 */
export function touchDevice(
  id: number,
  now: number = Date.now(),
): Promise<void> {
  return dbAdapter.run(
    "UPDATE trusted_device SET last_used_at = ?1 WHERE id = ?2",
    [now, id],
  );
}

/**
 * Soft-revokes an active trusted device belonging to the account (FR19).
 * Returns true if the device was found and revoked, false otherwise.
 */
export async function revokeDevice(
  accountId: number,
  deviceId: number,
  now: number = Date.now(),
): Promise<boolean> {
  const res = await dbAdapter.get<{ id: number }>(
    `UPDATE trusted_device
     SET revoked_at = ?1
     WHERE account_id = ?2 AND id = ?3 AND revoked_at IS NULL
     RETURNING id`,
    [now, accountId, deviceId],
  );
  return res !== null && res !== undefined;
}

/**
 * Soft-revokes all active trusted devices belonging to the account (FR19).
 * Returns the count of revoked devices.
 */
export async function revokeAllDevices(
  accountId: number,
  now: number = Date.now(),
): Promise<number> {
  const res = await dbAdapter.all<{ id: number }>(
    `UPDATE trusted_device
     SET revoked_at = ?1
     WHERE account_id = ?2 AND revoked_at IS NULL
     RETURNING id`,
    [now, accountId],
  );
  return res.length;
}

/**
 * Purges expired trusted device records whose expires_at is older than retentionMs (FR17).
 * Returns the count of deleted rows.
 */
export async function purgeExpiredDevices(
  retentionMs: number = 60 * 24 * 60 * 60 * 1000,
  now: number = Date.now(),
): Promise<number> {
  const cutoff = now - retentionMs;
  const res = await dbAdapter.all<{ id: number }>(
    "DELETE FROM trusted_device WHERE expires_at < ?1 RETURNING id",
    [cutoff],
  );
  return res.length;
}
