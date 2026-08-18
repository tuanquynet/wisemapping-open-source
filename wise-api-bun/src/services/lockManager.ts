import { LockError, TooManyLocksError } from "../domain/errors.ts";
import { fullName, type Account, type Mindmap } from "../domain/types.ts";
import { logger } from "../util/logger.ts";
import type { LockInfo, LockManager } from "./lockManager.interface.ts";

export type { LockInfo, LockManager };

/**
 * In-memory edit locks, porting `service/LockManagerImpl.java` and
 * `service/LockInfo.java`.
 *
 * Two different intervals, both from the Java source and easy to conflate:
 *   - a lock lives for 30 MINUTES  (`LockInfo.EXPIRATION_MIN`)
 *   - the sweeper runs every 1 MINUTE (`LockManagerImpl.ONE_MINUTE_MILLISECONDS`)
 *
 * Implements the async `LockManager` interface on Bun (Task 5.1, tasks/plan.md).
 * A Durable Object implementation (`MapLockDurableObject.ts`, Task 5.2)
 * provides the equivalent for Cloudflare Workers.
 */

const MAX_LOCKS = 1000;
const WARN_THRESHOLD = Math.floor(MAX_LOCKS * 0.8);
const LOCK_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

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
export async function getLockInfo(mapId: number): Promise<LockInfo | null> {
  const lock = locksByMapId.get(mapId);
  if (lock === undefined) return null;
  if (isExpired(lock)) {
    locksByMapId.delete(mapId);
    return null;
  }
  return lock;
}

export async function isLocked(map: Mindmap): Promise<boolean> {
  return (await getLockInfo(map.id)) !== null;
}

export async function isLockedBy(map: Mindmap, user: Account): Promise<boolean> {
  const lock = await getLockInfo(map.id);
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
export async function lock(map: Mindmap, user: Account): Promise<LockInfo> {
  const existing = await getLockInfo(map.id);

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
export async function unlock(map: Mindmap, user: Account): Promise<void> {
  const lock = await getLockInfo(map.id);
  if (lock === null) return; // Idempotent, as in the Java version.
  if (lock.userId !== user.id) {
    throw LockError.lockLost();
  }
  locksByMapId.delete(map.id);
}

/** Releases every lock held by a user. Called on logout. */
export async function unlockAll(user: Account): Promise<number> {
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

export const bunLockManager: LockManager & {
  clearAll(): void;
  expireForTest(mapId: number): void;
  shutdown(): void;
} = {
  getLockInfo,
  isLocked,
  isLockedBy,
  lock,
  unlock,
  unlockAll,
  clearAll,
  expireForTest,
  shutdown,
};
