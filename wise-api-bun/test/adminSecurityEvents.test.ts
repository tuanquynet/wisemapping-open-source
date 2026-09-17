import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { buildConfig, getConfig, setConfig, type Config } from "../src/config.ts";
import { dbAdapter } from "../src/db/client.ts";
import * as securityEventRepo from "../src/db/repos/securityEventRepo.ts";
import { createUser } from "./helpers/auth.ts";
import { API, get } from "./helpers/client.ts";
import { resetDb } from "./helpers/db.ts";

const VALID_JWT_SECRET = Buffer.from("a".repeat(32)).toString("base64");
const VALID_KEY = Buffer.from("k".repeat(32)).toString("base64");
const OPERATOR_EMAIL = "audit.operator@example.com";
const GENERAL_ADMIN_EMAIL = "general.admin@example.com";

describe("Admin Security Events Review (Story 4.5, FR35, FR36, FR37, FR38, UX-DR21)", () => {
  const initialConfig = getConfig();

  beforeEach(() => {
    resetDb();
    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "true",
        TWO_FACTOR_SECRET_KEY: VALID_KEY,
        ADMIN_EMAIL: GENERAL_ADMIN_EMAIL,
        TWO_FACTOR_RESET_EMAILS: OPERATOR_EMAIL,
      }),
    );
  });

  afterAll(() => setConfig(initialConfig));

  test("returns 401 when unauthenticated", async () => {
    const res = await get(`${API}/admin/securityEvents`);
    expect(res.status).toBe(401);
  });

  test("returns 404 when TWO_FACTOR_ENABLED is false", async () => {
    setConfig(
      buildConfig({
        JWT_SECRET: VALID_JWT_SECRET,
        TWO_FACTOR_ENABLED: "false",
        ADMIN_EMAIL: GENERAL_ADMIN_EMAIL,
        TWO_FACTOR_RESET_EMAILS: OPERATOR_EMAIL,
      }),
    );
    const operator = await createUser({ email: OPERATOR_EMAIL });
    const res = await get(`${API}/admin/securityEvents`, {
      headers: operator.authHeaders,
    });
    expect(res.status).toBe(404);
  });

  test("refuses non-admin and general admin without reset permission (FR35)", async () => {
    const regularUser = await createUser({ email: "regular@example.com" });
    const regularRes = await get(`${API}/admin/securityEvents`, {
      headers: regularUser.authHeaders,
    });
    expect(regularRes.status).toBe(403);

    const generalAdmin = await createUser({ email: GENERAL_ADMIN_EMAIL });
    const adminRes = await get(`${API}/admin/securityEvents`, {
      headers: generalAdmin.authHeaders,
    });
    expect(adminRes.status).toBe(403);
  });

  test("authorized operator receives paginated response (FR37, UX-DR21)", async () => {
    const operator = await createUser({ email: OPERATOR_EMAIL });
    const target = await createUser({ email: "target1@example.com" });

    // Seed events
    const now = Date.now();
    await securityEventRepo.recordSecurityEvent({
      affectedAccountId: target.authHeaders ? 2 : 1, // target account id
      actorEmail: "admin@example.com",
      action: "admin_reset_approved",
      outcome: "success",
      reason: "Device lost",
      createdAt: now - 1000,
    });
    await securityEventRepo.recordSecurityEvent({
      affectedAccountId: target.authHeaders ? 2 : 1,
      actorEmail: "target1@example.com",
      action: "enrollment_activated",
      outcome: "success",
      createdAt: now,
    });

    const res = await get(`${API}/admin/securityEvents?page=0&pageSize=10`, {
      headers: operator.authHeaders,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        id: number;
        actorEmail: string;
        action: string;
        outcome: string;
        reason: string | null;
        createdAt: number;
        affectedAccountEmail?: string | null;
      }>;
      page: number;
      pageSize: number;
      totalElements: number;
      totalPages: number;
      hasNext: boolean;
      hasPrevious: boolean;
    };

    expect(body.page).toBe(0);
    expect(body.pageSize).toBe(10);
    expect(body.totalElements).toBeGreaterThanOrEqual(2);
    expect(body.data.length).toBeGreaterThanOrEqual(2);

    // Verify ordering: newest first
    expect(body.data[0]!.createdAt).toBeGreaterThanOrEqual(body.data[1]!.createdAt);

    // Verify no secret or code material in event objects (FR38)
    for (const event of body.data) {
      expect((event as Record<string, unknown>).secret).toBeUndefined();
      expect((event as Record<string, unknown>).code).toBeUndefined();
      expect((event as Record<string, unknown>).recoveryCode).toBeUndefined();
    }
  });

  test("filters events by action (UX-DR21)", async () => {
    const operator = await createUser({ email: OPERATOR_EMAIL });
    const target = await createUser({ email: "target.filter@example.com" });
    const targetId = (await dbAdapter.get<{ id: number }>("SELECT id FROM account WHERE email = ?", [
      "target.filter@example.com",
    ]))!.id;

    await securityEventRepo.recordSecurityEvent({
      affectedAccountId: targetId,
      actorEmail: "operator@example.com",
      action: "admin_reset_approved",
      outcome: "success",
      reason: "Lost phone",
    });
    await securityEventRepo.recordSecurityEvent({
      affectedAccountId: targetId,
      actorEmail: "target.filter@example.com",
      action: "enrollment_activated",
      outcome: "success",
    });

    const res = await get(`${API}/admin/securityEvents?action=admin_reset_approved`, {
      headers: operator.authHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ action: string }>;
      totalElements: number;
    };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    for (const event of body.data) {
      expect(event.action).toBe("admin_reset_approved");
    }
  });

  test("filters events by account substring and numeric ID (UX-DR21)", async () => {
    const operator = await createUser({ email: OPERATOR_EMAIL });
    const target = await createUser({ email: "specific.target@example.com" });
    const targetId = (await dbAdapter.get<{ id: number }>("SELECT id FROM account WHERE email = ?", [
      "specific.target@example.com",
    ]))!.id;

    await securityEventRepo.recordSecurityEvent({
      affectedAccountId: targetId,
      actorEmail: "actor.someone@example.com",
      action: "device_revoked",
      outcome: "success",
    });

    // Filter by email substring
    const resEmail = await get(`${API}/admin/securityEvents?account=specific.target`, {
      headers: operator.authHeaders,
    });
    expect(resEmail.status).toBe(200);
    const bodyEmail = (await resEmail.json()) as { data: Array<{ affectedAccountId: number }> };
    expect(bodyEmail.data.length).toBeGreaterThanOrEqual(1);
    expect(bodyEmail.data[0]!.affectedAccountId).toBe(targetId);

    // Filter by numeric account ID
    const resId = await get(`${API}/admin/securityEvents?account=${targetId}`, {
      headers: operator.authHeaders,
    });
    expect(resId.status).toBe(200);
    const bodyId = (await resId.json()) as { data: Array<{ affectedAccountId: number }> };
    expect(bodyId.data.length).toBeGreaterThanOrEqual(1);
    expect(bodyId.data[0]!.affectedAccountId).toBe(targetId);
  });

  test("filters events by date range (UX-DR21)", async () => {
    const operator = await createUser({ email: OPERATOR_EMAIL });
    const target = await createUser({ email: "dates.target@example.com" });
    const targetId = (await dbAdapter.get<{ id: number }>("SELECT id FROM account WHERE email = ?", [
      "dates.target@example.com",
    ]))!.id;

    const t1 = 1700000000000;
    const t2 = 1700001000000;
    const t3 = 1700002000000;

    await securityEventRepo.recordSecurityEvent({
      affectedAccountId: targetId,
      actorEmail: "actor@example.com",
      action: "event_t1",
      outcome: "success",
      createdAt: t1,
    });
    await securityEventRepo.recordSecurityEvent({
      affectedAccountId: targetId,
      actorEmail: "actor@example.com",
      action: "event_t2",
      outcome: "success",
      createdAt: t2,
    });
    await securityEventRepo.recordSecurityEvent({
      affectedAccountId: targetId,
      actorEmail: "actor@example.com",
      action: "event_t3",
      outcome: "success",
      createdAt: t3,
    });

    const res = await get(`${API}/admin/securityEvents?fromDate=${t1 + 500}&toDate=${t2 + 500}`, {
      headers: operator.authHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ action: string; createdAt: number }> };
    expect(body.data.length).toBe(1);
    expect(body.data[0]!.action).toBe("event_t2");
  });

  test("pagination parameters (page, pageSize) divide result set properly", async () => {
    const operator = await createUser({ email: OPERATOR_EMAIL });
    const target = await createUser({ email: "pages.target@example.com" });
    const targetId = (await dbAdapter.get<{ id: number }>("SELECT id FROM account WHERE email = ?", [
      "pages.target@example.com",
    ]))!.id;

    // Insert 5 distinct events
    for (let i = 0; i < 5; i++) {
      await securityEventRepo.recordSecurityEvent({
        affectedAccountId: targetId,
        actorEmail: "operator@example.com",
        action: `paginated_event_${i}`,
        outcome: "success",
        createdAt: 1700000000000 + i * 1000,
      });
    }
    // Page 0, pageSize 2
    const p0Res = await get(`${API}/admin/securityEvents?page=0&pageSize=2&account=${targetId}`, {
      headers: operator.authHeaders,
    });
    const p0 = (await p0Res.json()) as {
      data: Array<{ action: string }>;
      page: number;
      pageSize: number;
      totalElements: number;
      totalPages: number;
      hasNext: boolean;
      hasPrevious: boolean;
    };
    expect(p0.page).toBe(0);
    expect(p0.pageSize).toBe(2);
    expect(p0.totalElements).toBe(5);
    expect(p0.totalPages).toBe(3);
    expect(p0.hasNext).toBe(true);
    // Page 1, pageSize 2
    const p1Res = await get(`${API}/admin/securityEvents?page=1&pageSize=2&account=${targetId}`, {
      headers: operator.authHeaders,
    });
    const p1 = (await p1Res.json()) as typeof p0;
    expect(p1.page).toBe(1);
    expect(p1.data.length).toBe(2);
    expect(p1.hasNext).toBe(true);
    // Page 2, pageSize 2 (last page, 1 item)
    const p2Res = await get(`${API}/admin/securityEvents?page=2&pageSize=2&account=${targetId}`, {
      headers: operator.authHeaders,
    });
    const p2 = (await p2Res.json()) as typeof p0;
    expect(p2.page).toBe(2);
    expect(p2.data.length).toBe(1);
    expect(p2.hasNext).toBe(false);
    expect(p2.hasPrevious).toBe(true);
  });
});
