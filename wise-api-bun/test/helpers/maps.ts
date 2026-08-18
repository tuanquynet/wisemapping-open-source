import { API, post } from "./client.ts";
import type { TestUser } from "./auth.ts";

export const SAMPLE_XML =
  '<map version="tango" theme="prism" layout="mindmap"><topic central="true" text="Root"/></map>';

/** Creates a map and returns its id, read from the ResourceId header. */
export async function createMap(
  user: TestUser,
  title: string,
  opts: { xml?: string; description?: string } = {},
): Promise<number> {
  const params = new URLSearchParams({ title });
  if (opts.description !== undefined)
    params.set("description", opts.description);

  const res = await post(`${API}/maps?${params.toString()}`, {
    headers: user.authHeaders,
    ...(opts.xml !== undefined
      ? { raw: { body: opts.xml, contentType: "application/xml" } }
      : {}),
  });
  if (res.status !== 201) {
    throw new Error(`createMap failed: ${res.status} ${await res.text()}`);
  }
  return Number(res.headers.get("ResourceId"));
}

/** Shares a map with another user at the given role, as the owner. */
export async function share(
  owner: TestUser,
  mapId: number,
  email: string,
  role: "editor" | "viewer",
): Promise<Response> {
  return post(`${API}/maps/${mapId}/collabs/`, {
    headers: owner.authHeaders,
    json: { collaborations: [{ email, role }], message: null },
  });
}
