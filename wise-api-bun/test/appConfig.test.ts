import { describe, expect, test } from "bun:test";

import { API, get } from "./helpers/client.ts";

/**
 * The frontend reads this endpoint at boot. Key names come from
 * `rest/model/RestAppConfig.java` -- every public getter, with null strings
 * omitted per `@JsonInclude(NON_NULL)`.
 */
describe("GET /app/config", () => {
  test("is public and returns the documented keys", async () => {
    const res = await get(`${API}/app/config`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");

    const body = await res.json();
    expect(body).toEqual({
      apiBaseUrl: "http://localhost:8080",
      uiBaseUrl: "http://localhost:3000",
      googleOauth2Enabled: false,
      facebookOauth2Enabled: false,
      registrationEnabled: true,
      recaptcha2Enabled: false,
      jwtExpirationMin: 10080,
    });
  });

  test("omits optional string keys rather than sending null", async () => {
    // @JsonInclude(NON_NULL): the frontend sees absent keys, not nulls.
    const body = (await (await get(`${API}/app/config`)).json()) as Record<
      string,
      unknown
    >;
    expect("recaptcha2SiteKey" in body).toBe(false);
    expect("analyticsAccount" in body).toBe(false);
    expect("googleOauth2Url" in body).toBe(false);
    expect("facebookOauth2Url" in body).toBe(false);
  });

  test("uses the boolean getter names, not the isXxx form", async () => {
    // Jackson strips the `is` prefix from isGoogleOauth2Enabled() etc.
    const body = (await (await get(`${API}/app/config`)).json()) as Record<
      string,
      unknown
    >;
    expect("isRegistrationEnabled" in body).toBe(false);
    expect(body.registrationEnabled).toBe(true);
  });
});
