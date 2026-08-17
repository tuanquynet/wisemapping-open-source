/**
 * Date formatting for the wire.
 *
 * The Java DTOs are inconsistent here and the inconsistency is observable:
 * most stringify dates themselves, but `RestUser.getCreationDate()` returns a
 * raw `java.util.Calendar` that Jackson serialises. With Spring Boot's default
 * `WRITE_DATES_AS_TIMESTAMPS=false` that yields an ISO-8601 string, which is
 * what we emit.
 *
 * FLAGGED FOR DIFFERENTIAL VERIFICATION: confirm the exact `creationDate` shape
 * against a running Java instance before pointing a real frontend at this. It
 * is the one field whose format was inferred rather than read off a getter.
 */

/** ISO-8601 with milliseconds, UTC -- e.g. 2026-07-29T06:38:00.000Z */
export function toIso8601(value: Date | number): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function toIso8601OrNull(
  value: Date | number | null | undefined,
): string | null {
  return value === null || value === undefined ? null : toIso8601(value);
}
