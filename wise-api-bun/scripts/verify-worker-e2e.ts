const BASE = "http://127.0.0.1:8794/api/restful";

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
  } catch (e) {
    console.error(`[FAIL] ${name}:`, e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

async function main() {
  console.log("Running E2E tests against Cloudflare Workers + D1 + Durable Objects (http://127.0.0.1:8794)...");

  // 1. App Config
  await step("1. GET /app/config", async () => {
    const res = await fetch(`${BASE}/app/config`);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body.uiBaseUrl) throw new Error("Missing uiBaseUrl");
  });

  // 2. User Registration
  const email = `cf-test-${Date.now()}@example.com`;
  let userId = 0;
  await step("2. POST /users/ (Register)", async () => {
    const res = await fetch(`${BASE}/users/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        firstname: "Cloud",
        lastname: "Flare",
        password: "password123",
        acceptedTerms: true,
      }),
    });
    if (res.status !== 201) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }
    userId = Number(res.headers.get("ResourceId"));
    if (!userId) throw new Error("Missing ResourceId header");
  });

  // 3. Login
  let token = "";
  await step("3. POST /authenticate (Login)", async () => {
    const res = await fetch(`${BASE}/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    token = (await res.text()).trim();
    if (!token) throw new Error("Empty token returned");
  });

  const authHeaders = { Authorization: `Bearer ${token}` };

  // 4. Current Account
  await step("4. GET /account", async () => {
    const res = await fetch(`${BASE}/account`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.email !== email) throw new Error(`Expected email ${email}, got ${body.email}`);
  });

  // 5. Create Map
  let mapId = 0;
  await step("5. POST /maps (Create Map)", async () => {
    const res = await fetch(`${BASE}/maps?title=CF%20Worker%20Map`, {
      method: "POST",
      headers: authHeaders,
    });
    if (res.status !== 201) throw new Error(`HTTP ${res.status}`);
    mapId = Number(res.headers.get("ResourceId"));
    if (!mapId) throw new Error("Missing ResourceId header");
  });

  // 6. Get Map
  await step("6. GET /maps/:id", async () => {
    const res = await fetch(`${BASE}/maps/${mapId}`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.title !== "CF Worker Map") throw new Error(`Unexpected title: ${body.title}`);
  });

  // 7. Lock Map (Durable Object)
  await step("7. PUT /maps/:id/lock (Acquire DO Lock)", async () => {
    const res = await fetch(`${BASE}/maps/${mapId}/lock`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain", ...authHeaders },
      body: "true",
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.email !== email) throw new Error(`Expected lock email ${email}, got ${body.email}`);
  });

  // 8. Check Metadata
  await step("8. GET /maps/:id/metadata", async () => {
    const res = await fetch(`${BASE}/maps/${mapId}/metadata`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  });

  // 9. Save Document XML
  await step("9. PUT /maps/:id/document/xml", async () => {
    const res = await fetch(`${BASE}/maps/${mapId}/document/xml`, {
      method: "PUT",
      headers: { "Content-Type": "application/xml", ...authHeaders },
      body: '<map version="tango"><topic central="true" text="Updated on Cloudflare Workers!"/></map>',
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  });

  // 10. History Revisions
  await step("10. GET /maps/:id/history", async () => {
    const res = await fetch(`${BASE}/maps/${mapId}/history`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.count < 1) throw new Error("Expected at least 1 history revision");
  });

  // 11. Create Label
  let labelId = 0;
  await step("11. POST /labels", async () => {
    const res = await fetch(`${BASE}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ title: "Production", color: "#ff0000" }),
    });
    if (res.status !== 201) throw new Error(`HTTP ${res.status}`);
    labelId = Number(res.headers.get("ResourceId"));
  });

  // 12. List Labels
  await step("12. GET /labels/", async () => {
    const res = await fetch(`${BASE}/labels/`, { headers: authHeaders });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.labels) || body.labels.length < 1) throw new Error("Expected labels array");
  });

  // 13. Unlock Map
  await step("13. PUT /maps/:id/lock (Release DO Lock)", async () => {
    const res = await fetch(`${BASE}/maps/${mapId}/lock`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain", ...authHeaders },
      body: "false",
    });
    if (res.status !== 204) throw new Error(`HTTP ${res.status}`);
  });

  // 14. Delete Map
  await step("14. DELETE /maps/:id", async () => {
    const res = await fetch(`${BASE}/maps/${mapId}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    if (res.status !== 204) throw new Error(`HTTP ${res.status}`);
  });

  console.log("\nALL 14 E2E STEPS SUCCEEDED ON CLOUDFLARE WORKERS + D1 + DURABLE OBJECTS!");
}

main();
