import { LockError, TooManyLocksError } from "../domain/errors.ts";
import { fullName, type Account, type Mindmap } from "../domain/types.ts";
import { logger } from "../util/logger.ts";

/**
 * In-memory edit locks, porting `service/LockManagerImpl.java` and
 * `service/LockInfo.java`.
 *
 * Two different intervals, both from the Java source and easy to conflate:
 *   - a lock lives for 30 MINUTES  (`LockInfo.EXPIRATION_MIN`)
 *   - the sweeper runs every 1 MINUTE (`LockManagerImpl.ONE_MINUTE_MILLISECONDS`)
 *
 * SINGLE PROCESS ONLY. This state is per-instance, so the API cannot be scaled
 * horizontally without moving locks into SQLite or Redis. That limitation is
 * inherited from the Java design.
 */

const MAX_LOCKS = 1000;
const WARN_THRESHOLD = Math.floor(MAX_LOCKS * 0.8);
const LOCK_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

export interface LockInfo {
  mapId: number;
  userId: number;
  userEmail: string;
  userFullName: string;
  expiresAt: number;
  /**
   * Opaque session id. A string, not a number: the Java version uses
   * `System.nanoTime()`, and `Bun.nanoseconds()` exceeds
   * `Number.MAX_SAFE_INTEGER` within hours of uptime -- this value is serialised
   * to the client, so as a JS number it would silently lose precision.
   */
  session: string;
}

const locksByMapId = new Map<number, LockInfo>();

function isExpired(lock: LockInfo, now = Date.now()): boolean {
  return lock.expiresAt <= now;
}

/**
 * Reads a lock, treating an expired one as absent.
 *
 * The Java `getLockInfo` returns the raw entry and relies entirely on the
 * sweeper, so an expired lock keeps blocking other editors for up to a minute.
 * Checking on read closes that window; it can only ever release a lock earlier
 * than the Java version would, never later.
 */
export function getLockInfo(mapId: number): LockInfo | null {
  const lock = locksByMapId.get(mapId);
  if (lock === undefined) return null;
  if (isExpired(lock)) {
    locksByMapId.delete(mapId);
    return null;
  }
  return lock;
}

export function isLocked(map: Mindmap): boolean {
  return getLockInfo(map.id) !== null;
}

export function isLockedBy(map: Mindmap, user: Account): boolean {
  const lock = getLockInfo(map.id);
  return lock !== null && lock.userId === user.id;
}

function newSession(): string {
  return Bun.nanoseconds().toString();
}

/**
 * Takes or refreshes the lock.
 *
 * The refresh-on-every-call behaviour is load-bearing: the lock is a lease, and
 * the editor's periodic save is what keeps it alive.
 */
export function lock(map: Mindmap, user: Account): LockInfo {
  const existing = getLockInfo(map.id);

  if (existing !== null && existing.userId !== user.id) {
    throw LockError.lockLost();
  }

  if (existing !== null) {
    existing.expiresAt = Date.now() + LOCK_TTL_MS;
    return existing;
  }

  // The capacity check applies only when creating, as in the Java version.
  if (locksByMapId.size >= MAX_LOCKS) {
    logger.error(
      `Maximum lock limit (${MAX_LOCKS}) reached; cannot lock map ${map.id}. Expired locks may not be being cleaned up.`,
    );
    throw new TooManyLocksError(
      "Maximum concurrent locks reached. Please try again later.",
    );
  }
  if (locksByMapId.size >= WARN_THRESHOLD) {
    logger.warn(
      `Lock count (${locksByMapId.size}) is approaching the maximum of ${MAX_LOCKS}.`,
    );
  }

  const created: LockInfo = {
    mapId: map.id,
    userId: user.id,
    userEmail: user.email,
    userFullName: fullName(user),
    expiresAt: Date.now() + LOCK_TTL_MS,
    session: newSession(),
  };
  locksByMapId.set(map.id, created);
  return created;
}

/** Releases the lock. Throws if it is held by someone else. */
export function unlock(map: Mindmap, user: Account): void {
  const lock = getLockInfo(map.id);
  if (lock === null) return; // Idempotent, as in the Java version.
  if (lock.userId !== user.id) {
    throw LockError.lockLost();
  }
  locksByMapId.delete(map.id);
}

/** Releases every lock held by a user. Called on logout. */
export function unlockAll(user: Account): number {
  let released = 0;
  for (const [mapId, lock] of locksByMapId) {
    if (lock.userId === user.id) {
      locksByMapId.delete(mapId);
      released += 1;
    }
  }
  return released;
}

function sweep(): void {
  const now = Date.now();
  for (const [mapId, lock] of locksByMapId) {
    if (isExpired(lock, now)) locksByMapId.delete(mapId);
  }
}

/**
 * `.unref()` is the Bun equivalent of the Java daemon-thread flag: without it
 * this timer keeps the process alive forever, and a leaked interval across
 * `bun test` files is the usual way that bites.
 */
const sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
sweeper.unref();

export function shutdown(): void {
  clearInterval(sweeper);
  locksByMapId.clear();
}

/** Test seam: drop all locks without stopping the sweeper. */
export function clearAll(): void {
  locksByMapId.clear();
}

/** Test seam: age a lock so expiry can be exercised without waiting 30 minutes. */
export function expireForTest(mapId: number): void {
  const lock = locksByMapId.get(mapId);
  if (lock !== undefined) lock.expiresAt = Date.now() - 1;
}
