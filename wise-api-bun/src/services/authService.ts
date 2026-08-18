import * as accounts from "../db/repos/accounts.ts";
import { config } from "../config.ts";
import type { Account } from "../domain/types.ts";
import {
  AccountNotActivatedError,
  BadRequestError,
  InvalidCredentialsError,
  RegistrationError,
  ValidationError,
} from "../domain/errors.ts";
import { logger } from "../util/logger.ts";
import { signToken } from "../util/jwt.ts";

/** From `Account.MIN/MAX_PASSWORD_LENGTH_SIZE`. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 40;
/** From `model/Constants.java`. */
const MAX_NAME_LENGTH = 255;

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // one hour, as in UserServiceImpl

/**
 * Argon2id via `Bun.password`. Greenfield, so none of the Java compatibility
 * machinery applies -- no `ENC:` unsalted SHA-1, no `{bcrypt}` prefix dispatch.
 * `Bun.password.verify` reads the algorithm from the stored hash, so migrating
 * to something else later needs no dual-read path.
 */
function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: "argon2id" });
}

function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}

/**
 * Generates an activation code in the Java format: a signed 64-bit integer.
 * Kept as a string end to end -- it has up to 19 digits and would silently lose
 * precision as a JS number.
 */
function newActivationCode(): string {
  return crypto.getRandomValues(new BigInt64Array(1))[0]!.toString();
}

// Deliberately permissive, matching the Java validator's intent rather than
// attempting to encode RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RegistrationInput {
  email?: unknown;
  firstname?: unknown;
  lastname?: unknown;
  password?: unknown;
  acceptedTerms?: unknown;
}

export interface RegisteredAccount {
  account: Account;
  /** Present only when email confirmation is enabled. */
  activationCode: string | null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function register(
  input: RegistrationInput,
): Promise<RegisteredAccount> {
  if (!config.registrationEnabled) {
    throw new BadRequestError("Registration is disabled.");
  }
  if (input.acceptedTerms !== true) {
    throw new RegistrationError(
      "You must accept the Terms of Use and Privacy Policy to register.",
    );
  }

  const email = asString(input.email).trim();
  const firstname = asString(input.firstname).trim();
  const lastname = asString(input.lastname).trim();
  const password = asString(input.password);

  // Field-keyed errors, matching the keys the Java UserValidator rejects on so
  // the frontend can attach messages to the right inputs.
  const fieldErrors: Record<string, string> = {};

  if (email === "") fieldErrors.email = "This field is required.";
  else if (!EMAIL_RE.test(email))
    fieldErrors.email = "Please enter a valid email address.";

  if (firstname === "") fieldErrors.firstname = "This field is required.";
  else if (firstname.length > MAX_NAME_LENGTH)
    fieldErrors.firstname = `The firstname must have less than ${MAX_NAME_LENGTH} characters.`;

  if (lastname === "") fieldErrors.lastname = "This field is required.";
  else if (lastname.length > MAX_NAME_LENGTH)
    fieldErrors.lastname = `The lastname must have less than ${MAX_NAME_LENGTH} characters.`;

  if (password === "") fieldErrors.password = "This field is required.";
  else if (password.length < MIN_PASSWORD_LENGTH)
    fieldErrors.password = `The password must have at least ${MIN_PASSWORD_LENGTH} characters.`;
  else if (password.length > MAX_PASSWORD_LENGTH)
    fieldErrors.password = `The password must have less than ${MAX_PASSWORD_LENGTH} characters.`;

  if (fieldErrors.email === undefined) {
    const existing = accounts.findRowByEmail(email);
    // A placeholder is not a conflict -- registration upgrades it in place.
    if (existing !== null && existing.password_hash !== null) {
      fieldErrors.email =
        "This email is already in use. Please try another one.";
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError(
      fieldErrors,
      "Registration could not be completed.",
    );
  }

  const needsConfirmation = config.emailConfirmationEnabled;
  const activationCode = needsConfirmation ? newActivationCode() : null;

  const account = accounts.createOrUpgrade({
    email,
    firstname,
    lastname,
    passwordHash: await hashPassword(password),
    locale: null,
    activationCode,
    activatedAt: needsConfirmation ? null : Date.now(),
  });

  if (activationCode !== null) {
    // No mailer is in scope; the flow stays exercisable via the log.
    logger.info(
      `Activation required for ${account.email}: ${config.uiBaseUrl}/c/activation?code=${activationCode}`,
    );
  }

  return { account, activationCode };
}

export function activate(code: string): void {
  const account = accounts.findByActivationCode(code);
  if (account === null) {
    // Covers both an unknown code and an already-activated one, since
    // activation clears the code.
    throw new BadRequestError(
      "The activation code is invalid or has already been used.",
    );
  }
  accounts.activate(account.id);
}

/**
 * Verifies credentials and returns a signed token.
 *
 * Check order follows `security/AuthenticationProvider.java`: unknown user and
 * wrong password produce the same error, and the not-activated check comes after
 * the password check so it cannot be used to enumerate accounts.
 */
export async function login(
  emailInput: unknown,
  passwordInput: unknown,
): Promise<string> {
  const email = asString(emailInput).trim();
  const password = asString(passwordInput);

  const row = email === "" ? null : accounts.findRowByEmail(email);

  if (row === null || row.password_hash === null) {
    // Verify against a real throwaway hash so a missing account costs the same
    // as a wrong password; otherwise response latency enumerates valid emails.
    await verifyPassword(password, await dummyHash());
    throw new InvalidCredentialsError();
  }

  if (!(await verifyPassword(password, row.password_hash))) {
    throw new InvalidCredentialsError();
  }

  if (row.activated_at === null) {
    throw new AccountNotActivatedError();
  }

  return signToken(row.email.toLowerCase());
}

/**
 * A genuine argon2id hash of a random value, computed once on first use and
 * used only to equalise timing on the unknown-account path. Generated rather
 * than hardcoded so it is guaranteed to be a valid encoding with the same
 * parameters as real hashes -- a literal would drift from `hashPassword` and a
 * malformed one would throw instead of taking the intended time.
 */
let dummyHashPromise: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(crypto.randomUUID());
  return dummyHashPromise;
}

export async function changePassword(
  account: Account,
  newPassword: unknown,
): Promise<void> {
  const password = asString(newPassword);
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new BadRequestError(
      `The password must have at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new BadRequestError(
      `The password must have less than ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }
  accounts.updatePasswordHash(account.id, await hashPassword(password));
}

/** Mirrors `RestResetPasswordAction`. OAUTH2_USER is unreachable here. */
export type ResetPasswordAction = "EMAIL_SENT" | "OAUTH2_USER";

export function requestPasswordReset(email: unknown): {
  action: ResetPasswordAction;
} {
  const account = accounts.findRowByEmail(asString(email));

  // Always report EMAIL_SENT: a distinct "no such user" reply would let anyone
  // test which addresses are registered. (The Java app throws
  // EmailNotExistsException here; not reproducing that is a deliberate choice.)
  if (account !== null && account.password_hash !== null) {
    const token = crypto.randomUUID().replaceAll("-", "");
    accounts.setResetToken(account.id, token, Date.now() + RESET_TOKEN_TTL_MS);
    logger.info(
      `Password reset for ${account.email}: ${config.uiBaseUrl}/c/reset-password?token=${token}`,
    );
  }

  return { action: "EMAIL_SENT" };
}

export async function resetPasswordFromToken(
  token: unknown,
  newPassword: unknown,
): Promise<void> {
  const raw = asString(token);
  const row = raw === "" ? null : accounts.findRowByResetToken(raw);

  if (row === null || row.reset_token_expires === null) {
    throw new BadRequestError("The reset link is invalid or has expired.");
  }
  if (row.reset_token_expires < Date.now()) {
    accounts.clearResetToken(row.id);
    throw new BadRequestError("The reset link is invalid or has expired.");
  }

  const password = asString(newPassword);
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new BadRequestError(
      `The password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }

  // updatePasswordHash clears the token, making it single-use.
  accounts.updatePasswordHash(row.id, await hashPassword(password));
}

/** Admin is a single configured email, as in the Java app (`app.admin.user`). */
export function isAdmin(account: Account | null): boolean {
  if (account === null || config.adminEmail === "") return false;
  return account.email.trim().toLowerCase() === config.adminEmail;
}
