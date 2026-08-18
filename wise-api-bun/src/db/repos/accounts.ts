import { dbAdapter } from "../client.ts";
import type { AccountRow } from "../rows.ts";
import type { Account } from "../../domain/types.ts";

/**
 * Account repository.
 *
 * One table covers both registered users and invitee placeholders (rows created
 * when a map is shared with an email nobody has registered yet). A placeholder
 * has `password_hash IS NULL` and cannot authenticate.
 *
 * Every function here is `async`, going through `dbAdapter` (Task 1.1,
 * tasks/plan.md) rather than the raw `bun:sqlite` `Database` -- the first
 * repository ported to the runtime-agnostic interface (Task 2.2).
 */

export function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    email: row.email,
    // Placeholders have no name until the person registers.
    firstname: row.firstname ?? "",
    lastname: row.lastname ?? "",
    locale: row.locale,
    isRegistered: row.password_hash !== null,
    activatedAt: row.activated_at === null ? null : new Date(row.activated_at),
    createdAt: new Date(row.created_at),
  };
}

const SELECT = `SELECT * FROM account`;

export function findRowByEmail(email: string): Promise<AccountRow | null> {
  return dbAdapter.get<AccountRow>(`${SELECT} WHERE email_lower = ?1`, [
    email.trim().toLowerCase(),
  ]);
}

export async function findByEmail(email: string): Promise<Account | null> {
  const row = await findRowByEmail(email);
  return row === null ? null : toAccount(row);
}

export async function findById(id: number): Promise<Account | null> {
  const row = await dbAdapter.get<AccountRow>(`${SELECT} WHERE id = ?1`, [id]);
  return row === null ? null : toAccount(row);
}

/**
 * Activation codes are compared as text, never parsed. The Java code generates
 * a signed 64-bit long; `Number()` on its 19 digits loses precision, which
 * would make activation fail for a subset of accounts in a way that looks
 * random.
 */
export async function findByActivationCode(code: string): Promise<Account | null> {
  const row = await dbAdapter.get<AccountRow>(
    `${SELECT} WHERE activation_code = ?1`,
    [code],
  );
  return row === null ? null : toAccount(row);
}

export function findRowByResetToken(token: string): Promise<AccountRow | null> {
  return dbAdapter.get<AccountRow>(`${SELECT} WHERE reset_token = ?1`, [
    token,
  ]);
}

export interface NewAccount {
  email: string;
  firstname: string;
  lastname: string;
  passwordHash: string;
  locale: string | null;
  activationCode: string | null;
  activatedAt: number | null;
}

/**
 * Register an account, upgrading an invitee placeholder in place if one
 * exists -- in one atomic statement (Architecture Decision 2, tasks/plan.md).
 *
 * Someone may already have a row because a map was shared with their address
 * before they signed up. Inserting a second row would orphan those
 * collaborations. `ON CONFLICT(email_lower) DO UPDATE ... WHERE password_hash
 * IS NULL` is the single-statement equivalent of the old two-step
 * SELECT-then-branch transaction: SQLite skips the UPDATE entirely (no error,
 * row left untouched) when the WHERE guard is false, so a genuine conflict
 * with an already-registered account cannot be triggered by this statement
 * -- confirmed against a real constraint violation before this rewrite
 * landed. `email_lower` and `created_at` are deliberately absent from the
 * UPDATE SET list, matching the previous implementation: an upgrade never
 * rewrites the placeholder's original creation timestamp.
 */
export async function createOrUpgrade(input: NewAccount): Promise<Account> {
  const row = await dbAdapter.get<AccountRow>(
    `INSERT INTO account (email, email_lower, firstname, lastname, password_hash,
                          locale, activation_code, activated_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(email_lower) DO UPDATE SET
       email = excluded.email,
       firstname = excluded.firstname,
       lastname = excluded.lastname,
       password_hash = excluded.password_hash,
       locale = excluded.locale,
       activation_code = excluded.activation_code,
       activated_at = excluded.activated_at
     WHERE password_hash IS NULL
     RETURNING *`,
    [
      input.email,
      input.email.trim().toLowerCase(),
      input.firstname,
      input.lastname,
      input.passwordHash,
      input.locale,
      input.activationCode,
      input.activatedAt,
      Date.now(),
    ],
  );
  if (row === null) {
    // The only way to reach here: email_lower already belongs to an account
    // with a password_hash set. Callers are expected to have rejected this
    // already; belt and braces.
    throw new Error(`Account already registered: ${input.email}`);
  }
  return toAccount(row);
}

/** Create a placeholder for an email that has no account, used when sharing. */
export async function createPlaceholder(email: string): Promise<Account> {
  const row = await dbAdapter.get<AccountRow>(
    `INSERT INTO account (email, email_lower, created_at) VALUES (?1, ?2, ?3) RETURNING *`,
    [email.trim(), email.trim().toLowerCase(), Date.now()],
  );
  return toAccount(row!);
}

/** Columns the account self-service routes may write, as an allowlist. */
const PROFILE_COLUMNS = {
  firstname: true,
  lastname: true,
  locale: true,
} as const;
export type ProfileColumn = keyof typeof PROFILE_COLUMNS;

export async function updateProfileField(
  id: number,
  column: ProfileColumn,
  value: string,
): Promise<void> {
  if (!Object.hasOwn(PROFILE_COLUMNS, column)) {
    throw new Error(`Refusing to update non-profile column: ${column}`);
  }
  // Safe interpolation: `column` is constrained to the allowlist above.
  await dbAdapter.run(`UPDATE account SET ${column} = ?1 WHERE id = ?2`, [
    value,
    id,
  ]);
}

export async function updatePasswordHash(
  id: number,
  passwordHash: string,
): Promise<void> {
  await dbAdapter.run(
    `UPDATE account SET password_hash = ?1, reset_token = NULL, reset_token_expires = NULL WHERE id = ?2`,
    [passwordHash, id],
  );
}

export async function activate(id: number): Promise<void> {
  await dbAdapter.run(
    `UPDATE account SET activated_at = ?1, activation_code = NULL WHERE id = ?2`,
    [Date.now(), id],
  );
}

export async function setResetToken(
  id: number,
  token: string,
  expiresAt: number,
): Promise<void> {
  await dbAdapter.run(
    `UPDATE account SET reset_token = ?1, reset_token_expires = ?2 WHERE id = ?3`,
    [token, expiresAt, id],
  );
}

export async function clearResetToken(id: number): Promise<void> {
  await dbAdapter.run(
    `UPDATE account SET reset_token = NULL, reset_token_expires = NULL WHERE id = ?1`,
    [id],
  );
}

export async function deleteById(id: number): Promise<void> {
  await dbAdapter.run(`DELETE FROM account WHERE id = ?1`, [id]);
}

export async function passwordHashOf(id: number): Promise<string | null> {
  const row = await dbAdapter.get<{ password_hash: string | null }>(
    `SELECT password_hash FROM account WHERE id = ?1`,
    [id],
  );
  return row?.password_hash ?? null;
}
