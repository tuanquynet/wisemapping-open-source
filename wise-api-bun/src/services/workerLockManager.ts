import { LockError } from "../domain/errors.ts";
import { fullName, type Account, type Mindmap } from "../domain/types.ts";
import type { LockInfo, LockManager } from "./lockManager.interface.ts";
import type { MapLockDurableObject } from "../durable-objects/MapLockDurableObject.ts";

/**
 * Creates a `LockManager` backed by Cloudflare Workers Durable Objects
 * (Task 5.2, tasks/plan.md).
 *
 * Each map id is mapped to a dedicated Durable Object instance via
 * `namespace.idFromName(String(map.id))`. Calls to `lock`, `unlock`,
 * `getLockInfo` communicate directly with that object over DO RPC.
 */
export function createWorkerLockManager(
  namespace: DurableObjectNamespace<MapLockDurableObject>,
): LockManager {
  function getStub(mapId: number) {
    const id = namespace.idFromName(String(mapId));
    return namespace.get(id);
  }

  return {
    async getLockInfo(mapId: number): Promise<LockInfo | null> {
      return getStub(mapId).getLockInfo();
    },

    async isLocked(map: Mindmap): Promise<boolean> {
      const lock = await getStub(map.id).getLockInfo();
      return lock !== null;
    },

    async isLockedBy(map: Mindmap, user: Account): Promise<boolean> {
      const lock = await getStub(map.id).getLockInfo();
      return lock !== null && lock.userId === user.id;
    },

    async lock(map: Mindmap, user: Account): Promise<LockInfo> {
      try {
        return await getStub(map.id).lock({
          mapId: map.id,
          userId: user.id,
          userEmail: user.email,
          userFullName: fullName(user),
        });
      } catch {
        throw LockError.lockLost();
      }
    },

    async unlock(map: Mindmap, user: Account): Promise<void> {
      try {
        await getStub(map.id).unlock(user.id);
      } catch {
        throw LockError.lockLost();
      }
    },

    async unlockAll(_user: Account): Promise<number> {
      // In the distributed per-map DO model, active locks auto-expire via alarm
      // after 30 minutes without holding memory on a central server.
      return 0;
    },
  };
}
