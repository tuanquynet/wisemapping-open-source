import { beforeEach, describe, expect, test } from "bun:test";

import { bunLockManager } from "../src/services/lockManager.ts";
import type { LockManager } from "../src/services/lockManager.interface.ts";
import type { Account, Mindmap } from "../src/domain/types.ts";

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

describe("bunLockManager implements LockManager", () => {
  beforeEach(() => {
    bunLockManager.clearAll();
  });

  test("satisfies LockManager interface", async () => {
    const manager: LockManager = bunLockManager;

    expect(await manager.isLocked(fakeMap)).toBe(false);
    expect(await manager.getLockInfo(fakeMap.id)).toBeNull();

    const info = await manager.lock(fakeMap, fakeUser1);
    expect(info.userId).toBe(1);
    expect(info.userEmail).toBe("user1@example.com");
    expect(info.userFullName).toBe("User One");
    expect(typeof info.session).toBe("string");

    expect(await manager.isLocked(fakeMap)).toBe(true);
    expect(await manager.isLockedBy(fakeMap, fakeUser1)).toBe(true);
    expect(await manager.isLockedBy(fakeMap, fakeUser2)).toBe(false);

    await manager.unlock(fakeMap, fakeUser1);
    expect(await manager.isLocked(fakeMap)).toBe(false);
  });

  test("unlockAll releases all locks for a user", async () => {
    const manager: LockManager = bunLockManager;
    const map2: Mindmap = { ...fakeMap, id: 200 };

    await manager.lock(fakeMap, fakeUser1);
    await manager.lock(map2, fakeUser1);

    expect(await manager.unlockAll(fakeUser1)).toBe(2);
    expect(await manager.isLocked(fakeMap)).toBe(false);
    expect(await manager.isLocked(map2)).toBe(false);
  });
});
