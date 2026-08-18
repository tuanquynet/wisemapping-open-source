import { DurableObject } from "cloudflare:workers";

import type { LockInfo } from "../services/lockManager.interface.ts";

/**
 * Durable Object enforcing single-editor-per-map edit locks on Cloudflare Workers
 * (Task 5.2, tasks/plan.md, Architecture Decision 4).
 *
 * One instance per map id, addressed via `env.MAP_LOCKS.idFromName(String(mapId))`.
 *
 * Lease duration is 30 minutes, matching the Java app and Bun implementation.
 * The DO's `alarm()` API replaces the fixed 60-second polling sweep: an alarm
 * is set for the exact timestamp of `expiresAt`, clearing the lock automatically
 * when it fires without requiring a client request.
 */
export class MapLockDurableObject extends DurableObject {
  private currentLock: LockInfo | null = null;

  override async alarm(): Promise<void> {
    this.currentLock = null;
  }

  async getLockInfo(): Promise<LockInfo | null> {
    if (this.currentLock !== null && this.currentLock.expiresAt <= Date.now()) {
      this.currentLock = null;
    }
    return this.currentLock;
  }

  async lock(data: {
    mapId: number;
    userId: number;
    userEmail: string;
    userFullName: string;
  }): Promise<LockInfo> {
    const existing = await this.getLockInfo();
    if (existing !== null && existing.userId !== data.userId) {
      throw new Error("Lock held by another user");
    }

    const expiresAt = Date.now() + 30 * 60 * 1000;
    this.currentLock = {
      ...data,
      expiresAt,
      session: String(Date.now()),
    };

    await this.ctx.storage.setAlarm(expiresAt);
    return this.currentLock;
  }

  async unlock(userId: number): Promise<void> {
    const existing = await this.getLockInfo();
    if (existing === null) return;
    if (existing.userId !== userId) {
      throw new Error("Lock held by another user");
    }

    this.currentLock = null;
    await this.ctx.storage.deleteAlarm();
  }
}
