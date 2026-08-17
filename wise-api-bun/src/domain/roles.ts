/**
 * Collaboration roles.
 *
 * The Java enum is `OWNER=0, EDITOR=1, VIEWER=2` and compares with
 * `role.ordinal() <= required.ordinal()` (`Collaboration.hasPermissions`). That
 * is correct but reads backwards -- "less than or equal" meaning "more powerful"
 * is exactly the kind of line someone eventually "fixes" in the wrong direction.
 *
 * Same predicate, expressed so it cannot be misread: a power table where a
 * bigger number means more authority, compared with `>=`. Ordinals never reach
 * storage (the column is TEXT), so nothing depends on the numbering.
 */

export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const POWER: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export function roleSatisfies(actual: Role, required: Role): boolean {
  return POWER[actual] >= POWER[required];
}

export function isRole(value: unknown): value is Role {
  return (
    typeof value === "string" &&
    (ROLES as readonly string[]).includes(value.toLowerCase())
  );
}

/** Parses the wire form, which is the lowercase role name. */
export function parseRole(value: unknown): Role | null {
  return isRole(value) ? (String(value).toLowerCase() as Role) : null;
}
