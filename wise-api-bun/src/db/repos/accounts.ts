import { db } from "../client.ts";
import type { AccountRow } from "../rows.ts";
import type { Account } from "../../domain/types.ts";

/**
 * Account repository.
 *
 * One table covers both registered users and invitee placeholders (rows created
 * when a map is shared with an email nobody has registered yet). A placeholder
 * has `password_hash IS NULL` and cannot authenticate.
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

export function findRowByEmail(email: string): AccountRow | null {
  return (
    db
      .query<AccountRow, [string]>(`${SELECT} WHERE email_lower = ?1`)
      .get(email.trim().toLowerCase()) ?? null
  );
}

export function findByEmail(email: string): Account | null {
  const row = findRowByEmail(email);
  return row === null ? null : toAccount(row);
}

export function findById(id: number): Account | null {
  // bun:sqlite's .get() returns null (not undefined) when there is no row.
  const row = db.query<AccountRow, [number]>(`${SELECT} WHERE id = ?1`).get(id);
  return row == null ? null : toAccount(row);
}

/**
 * Activation codes are compared as text, never parsed. The Java code generates
 * a signed 64-bit long; `Number()` on its 19 digits loses precision, which
 * would make activation fail for a subset of accounts in a way that looks
 * random.
 */
export function findByActivationCode(code: string): Account | null {
  const row = db
    .query<AccountRow, [string]>(`${SELECT} WHERE activation_code = ?1`)
    .get(code);
  return row == null ? null : toAccount(row);
}

export function findRowByResetToken(token: string): AccountRow | null {
  return (
    db
      .query<AccountRow, [string]>(`${SELECT} WHERE reset_token = ?1`)
      .get(token) ?? null
  );
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
 * Register an account, upgrading an invitee placeholder in place if one exists.
 *
 * This is the non-obvious part of registration: someone may already have a row
 * because a map was shared with their address before they signed up. Inserting
 * a second row would orphan those collaborations. The `password_hash IS NULL`
 * guard makes the upgrade safe -- it can never overwrite a real account.
 */
export function createOrUpgrade(input: NewAccount): Account {
  return db.transaction(() => {
    const existing = findRowByEmail(input.email);

    if (existing !== null) {
      if (existing.password_hash !== null) {
        // Caller is expected to have rejected this already; belt and braces.
        throw new Error(`Account already registered: ${input.email}`);
      }
      const row = db
        .query<
          AccountRow,
          [
            string, // email
            string, // firstname
            string, // lastname
            string, // password_hash
            string | null, // locale
            string | null, // activation_code
            number | null, // activated_at
            number, // id
          ]
        >(
          `UPDATE account
              SET email = ?1, firstname = ?2, lastname = ?3, password_hash = ?4,
                  locale = ?5, activation_code = ?6, activated_at = ?7
            WHERE id = ?8 AND password_hash IS NULL
            RETURNING *`,
        )
        .get(
          input.email,
          input.firstname,
          input.lastname,
          input.passwordHash,
          input.locale,
          input.activationCode,
          input.activatedAt,
          existing.id,
        );
      if (row == null)
        throw new Error(`Concurrent registration for ${input.email}`);
      return toAccount(row);
    }

    const row = db
      .query<
        AccountRow,
        [
          string,
          string,
          string,
          string,
          string,
          string | null,
          string | null,
          number | null,
          number,
        ]
      >(
        `INSERT INTO account (email, email_lower, firstname, lastname, password_hash,
                              locale, activation_code, activated_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         RETURNING *`,
      )
      .get(
        input.email,
        input.email.trim().toLowerCase(),
        input.firstname,
        input.lastname,
        input.passwordHash,
        input.locale,
        input.activationCode,
        input.activatedAt,
        Date.now(),
      )!;
    return toAccount(row);
  })();
}

/** Create a placeholder for an email that has no account, used when sharing. */
export function createPlaceholder(email: string): Account {
  const row = db
    .query<AccountRow, [string, string, number]>(
      `INSERT INTO account (email, email_lower, created_at) VALUES (?1, ?2, ?3) RETURNING *`,
    )
    .get(email.trim(), email.trim().toLowerCase(), Date.now())!;
  return toAccount(row);
}

/** Columns the account self-service routes may write, as an allowlist. */
const PROFILE_COLUMNS = {
  firstname: true,
  lastname: true,
  locale: true,
} as const;
export type ProfileColumn = keyof typeof PROFILE_COLUMNS;

export function updateProfileField(
  id: number,
  column: ProfileColumn,
  value: string,
): void {
  if (!Object.hasOwn(PROFILE_COLUMNS, column)) {
    throw new Error(`Refusing to update non-profile column: ${column}`);
  }
  // Safe interpolation: `column` is constrained to the allowlist above.
  db.run(`UPDATE account SET ${column} = ?1 WHERE id = ?2`, [value, id]);
}

export function updatePasswordHash(id: number, passwordHash: string): void {
  db.run(
    `UPDATE account SET password_hash = ?1, reset_token = NULL, reset_token_expires = NULL WHERE id = ?2`,
    [passwordHash, id],
  );
}

export function activate(id: number): void {
  db.run(
    `UPDATE account SET activated_at = ?1, activation_code = NULL WHERE id = ?2`,
    [Date.now(), id],
  );
}

export function setResetToken(
  id: number,
  token: string,
  expiresAt: number,
): void {
  db.run(
    `UPDATE account SET reset_token = ?1, reset_token_expires = ?2 WHERE id = ?3`,
    [token, expiresAt, id],
  );
}

export function clearResetToken(id: number): void {
  db.run(
    `UPDATE account SET reset_token = NULL, reset_token_expires = NULL WHERE id = ?1`,
    [id],
  );
}

export function deleteById(id: number): void {
  db.run(`DELETE FROM account WHERE id = ?1`, [id]);
}

export function passwordHashOf(id: number): string | null {
  const row = db
    .query<{ password_hash: string | null }, [number]>(
      `SELECT password_hash FROM account WHERE id = ?1`,
    )
    .get(id);
  return row?.password_hash ?? null;
}
