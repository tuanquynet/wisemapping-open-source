import type { Account } from "../../domain/types.ts";
import { fullName } from "../../domain/types.ts";
import { toIso8601 } from "../../util/iso8601.ts";

/**
 * Mirrors `rest/model/RestUser.java`.
 *
 * That class is `@JsonAutoDetect(fieldVisibility = NONE, getterVisibility =
 * PUBLIC_ONLY, isGetterVisibility = PUBLIC_ONLY)` with `@JsonInclude(NON_NULL)`,
 * so the keys are its getter names -- with three `@JsonProperty` overrides that
 * keep the `is` prefix (`isActive`, `isSuspended`, `isAdmin`) where Jackson
 * would otherwise have stripped it. Getting those three wrong is silent.
 *
 * `password` is a getter on the Java class but it returns a transient field that
 * is only populated on inbound requests, so it is always absent on reads. Not
 * reproduced, because reproducing it would mean emitting a password field.
 */
export interface RestUser {
  id: number;
  email: string;
  firstname: string;
  lastname: string;
  fullName: string;
  creationDate: string;
  authenticationType: string;
  allowSendEmail: boolean;
  isActive: boolean;
  isSuspended: boolean;
  isAdmin: boolean;
  locale?: string;
  suspensionReason?: string;
  suspendedDate?: string;
}

export function toRestUser(account: Account, isAdmin: boolean): RestUser {
  const result: RestUser = {
    id: account.id,
    email: account.email,
    firstname: account.firstname,
    lastname: account.lastname,
    fullName: fullName(account),
    creationDate: toIso8601(account.createdAt),
    // Only DATABASE authentication exists here; LDAP and OAuth2 are out of scope.
    authenticationType: "DATABASE",
    allowSendEmail: false,
    isActive: account.activatedAt !== null,
    // Suspension is not modelled -- it belongs to the admin/spam machinery.
    // The keys stay present because the frontend reads them.
    isSuspended: false,
    isAdmin,
  };

  // @JsonInclude(NON_NULL): omit rather than emit null.
  if (account.locale !== null) result.locale = account.locale;

  return result;
}
