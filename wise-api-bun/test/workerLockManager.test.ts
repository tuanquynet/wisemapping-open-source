import { describe, expect, test } from "bun:test";

import { createWorkerLockManager } from "../src/services/workerLockManager.ts";
import type { LockInfo, LockManager } from "../src/services/lockManager.interface.ts";
import type { Account, Mindmap } from "../src/domain/types.ts";
import { LockError } from "../src/domain/errors.ts";

const fakeUser1: Account = {
  id: 1,
  email: "user1@example.com",
  firstname: "User",
  lastname: "One",
  locale: "en",
  isRegistered: true,
  activatedAt: new Date(),
  createdAt: new Date(),
};

const fakeUser2: Account = {
  id: 2,
  email: "user2@example.com",
  firstname: "User",
  lastname: "Two",
  locale: "en",
  isRegistered: true,
  activatedAt: new Date(),
  createdAt: new Date(),
};

const fakeMap: Mindmap = {
  id: 100,
  title: "Test Map",
  description: "Description",
  isPublic: false,
  creatorId: 1,
  lastEditorId: 1,
  createdAt: new Date(),
  editedAt: new Date(),
  sourceType: "local",
  sourceId: null,
};

function createMockNamespace() {
  const store = new Map<string, LockInfo | null>();

  return {
    idFromName(name: string) {
      return { toString: () => name } as any;
    },
    get(id: { toString(): string }) {
      const key = id.toString();
      return {
        async getLockInfo() {
          return store.get(key) ?? null;
        },
        async lock(data: { mapId: number; userId: number; userEmail: string; userFullName: string }) {
          const current = store.get(key);
          if (current && current.userId !== data.userId) {
            throw new Error("Lock held by another user");
          }
          const info: LockInfo = {
            ...data,
            expiresAt: Date.now() + 30 * 60 * 1000,
            session: String(Date.now()),
          };
          store.set(key, info);
          return info;
        },
        async unlock(userId: number) {
          const current = store.get(key);
          if (!current) return;
          if (current.userId !== userId) {
            throw new Error("Lock held by another user");
          }
          store.set(key, null);
        },
      } as any;
    },
  } as any;
}

describe("createWorkerLockManager", () => {
  test("satisfies LockManager interface using DO RPC mock", async () => {
    const mockNs = createMockNamespace();
    const manager: LockManager = createWorkerLockManager(mockNs);

    expect(await manager.isLocked(fakeMap)).toBe(false);
    expect(await manager.getLockInfo(fakeMap.id)).toBeNull();

    const info = await manager.lock(fakeMap, fakeUser1);
    expect(info.userId).toBe(1);
    expect(info.userEmail).toBe("user1@example.com");
    expect(info.userFullName).toBe("User One");

    expect(await manager.isLocked(fakeMap)).toBe(true);
    expect(await manager.isLockedBy(fakeMap, fakeUser1)).toBe(true);
    expect(await manager.isLockedBy(fakeMap, fakeUser2)).toBe(false);

    // Another user locking should throw LockError (HTTP 409 equivalent)
    await expect(manager.lock(fakeMap, fakeUser2)).rejects.toThrow(LockError);

    // Another user unlocking should throw LockError
    await expect(manager.unlock(fakeMap, fakeUser2)).rejects.toThrow(LockError);

    await manager.unlock(fakeMap, fakeUser1);
    expect(await manager.isLocked(fakeMap)).toBe(false);
  });
});
