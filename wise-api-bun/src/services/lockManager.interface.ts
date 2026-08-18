import type { Account, Mindmap } from "../domain/types.ts";

/**
 * Edit lock model and interface.
 *
 * Implemented on Bun via in-memory Map (`lockManager.ts`) and on Cloudflare
 * Workers via a Durable Object (`MapLockDurableObject.ts`, Task 5.2).
 */

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

export interface LockManager {
  getLockInfo(mapId: number): Promise<LockInfo | null>;
  isLocked(map: Mindmap): Promise<boolean>;
  isLockedBy(map: Mindmap, user: Account): Promise<boolean>;
  lock(map: Mindmap, user: Account): Promise<LockInfo>;
  unlock(map: Mindmap, user: Account): Promise<void>;
  unlockAll(user: Account): Promise<number>;
}
