import { beforeEach, describe, expect, test } from "bun:test";

import { API, del, get, json, post, put } from "./helpers/client.ts";
import { createUser, login } from "./helpers/auth.ts";
import { resetDb } from "./helpers/db.ts";

beforeEach(() => resetDb());

const validRegistration = {
  email: "alice@example.org",
  firstname: "Alice",
  lastname: "Anderson",
  password: "password123",
  acceptedTerms: true,
};

describe("POST /users/ (registration)", () => {
  test("returns 201 with Location and ResourceId headers", async () => {
    const res = await post(`${API}/users/`, { json: validRegistration });
    expect(res.status).toBe(201);
    expect(res.headers.get("ResourceId")).toBe("1");
    expect(res.headers.get("Location")).toBe("/api/restful/users/1");
    expect(await res.text()).toBe("");
  });

  test("accepts the no-trailing-slash spelling too", async () => {
    // The Java mapping is `value = "/"`; both spellings must route.
    expect(
      (await post(`${API}/users`, { json: validRegistration })).status,
    ).toBe(201);
  });

  test("rejects a duplicate email with a field error", async () => {
    await post(`${API}/users/`, { json: validRegistration });
    const res = await post(`${API}/users/`, { json: validRegistration });

    expect(res.status).toBe(400);
    const body = await json(res);
    // The RestErrors shape: three keys, no debugInfo.
    expect(Object.keys(body).sort()).toEqual([
      "fieldErrors",
      "globalErrors",
      "globalSeverity",
    ]);
    expect(body.fieldErrors.email).toContain("already in use");
    expect(body.globalSeverity).toBe("WARNING");
    expect(Array.isArray(body.globalErrors)).toBe(true);
  });

  test("treats email as case-insensitive for duplicate detection", async () => {
    await post(`${API}/users/`, { json: validRegistration });
    const res = await post(`${API}/users/`, {
      json: { ...validRegistration, email: "ALICE@EXAMPLE.ORG" },
    });
    expect(res.status).toBe(400);
  });

  test("requires accepted terms", async () => {
    const res = await post(`${API}/users/`, {
      json: { ...validRegistration, acceptedTerms: false },
    });
    expect(res.status).toBe(400);
    expect((await json(res)).globalErrors[0]).toContain("Terms of Use");
  });

  test("enforces the 8-40 character password bounds", async () => {
    const short = await post(`${API}/users/`, {
      json: { ...validRegistration, password: "short1" },
    });
    expect(short.status).toBe(400);
    expect((await json(short)).fieldErrors.password).toContain("at least 8");

    const long = await post(`${API}/users/`, {
      json: { ...validRegistration, password: "x".repeat(41) },
    });
    expect(long.status).toBe(400);
    expect((await json(long)).fieldErrors.password).toContain("less than 40");
  });

  test("reports every invalid field at once", async () => {
    const res = await post(`${API}/users/`, {
      json: {
        email: "not-an-email",
        firstname: "",
        lastname: "",
        password: "x",
        acceptedTerms: true,
      },
    });
    expect(res.status).toBe(400);
    const { fieldErrors } = await json(res);
    expect(Object.keys(fieldErrors).sort()).toEqual([
      "email",
      "firstname",
      "lastname",
      "password",
    ]);
  });

  test("rejects a non-JSON body", async () => {
    expect((await post(`${API}/users/`, { text: "nope" })).status).toBe(400);
  });
});

describe("POST /authenticate", () => {
  test("returns the BARE token as the body, not JSON", async () => {
    await post(`${API}/users/`, { json: validRegistration });
    const res = await post(`${API}/authenticate`, {
      json: {
        email: validRegistration.email,
        password: validRegistration.password,
      },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    // Three dot-separated segments, and crucially NOT quoted or wrapped.
    expect(body.split(".")).toHaveLength(3);
    expect(body.startsWith('"')).toBe(false);
    expect(body.startsWith("{")).toBe(false);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });

  test("also echoes the token in the Authorization response header", async () => {
    await post(`${API}/users/`, { json: validRegistration });
    const res = await post(`${API}/authenticate`, {
      json: {
        email: validRegistration.email,
        password: validRegistration.password,
      },
    });

    const token = await res.text();
    expect(res.headers.get("Authorization")).toBe(`Bearer ${token}`);
  });

  test("is case-insensitive on email", async () => {
    await post(`${API}/users/`, { json: validRegistration });
    expect(
      await login("ALICE@EXAMPLE.ORG", validRegistration.password),
    ).toBeTruthy();
  });

  test("rejects a wrong password and an unknown user identically", async () => {
    await post(`${API}/users/`, { json: validRegistration });

    const wrongPassword = await post(`${API}/authenticate`, {
      json: { email: validRegistration.email, password: "wrongpassword" },
    });
    const unknownUser = await post(`${API}/authenticate`, {
      json: { email: "nobody@example.org", password: "password123" },
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    // Identical bodies: the endpoint must not reveal which emails exist.
    expect(await json(wrongPassword)).toEqual(await json(unknownUser));
  });

  test("rejects an empty body", async () => {
    expect((await post(`${API}/authenticate`, { text: "" })).status).toBe(400);
  });
});

describe("POST /logout", () => {
  test("is public and idempotent", async () => {
    expect((await post(`${API}/logout`)).status).toBe(200);
    expect(
      (
        await post(`${API}/logout`, {
          headers: { Authorization: "Bearer garbage" },
        })
      ).status,
    ).toBe(200);
  });
});

describe("GET /account", () => {
  test("returns the RestUser contract keys", async () => {
    const user = await createUser({
      email: "bob@example.org",
      firstname: "Bob",
      lastname: "Brown",
    });
    const res = await get(`${API}/account`, { headers: user.authHeaders });

    expect(res.status).toBe(200);
    const body = await json(res);

    expect(body.email).toBe("bob@example.org");
    expect(body.firstname).toBe("Bob");
    expect(body.lastname).toBe("Brown");
    expect(body.fullName).toBe("Bob Brown");
    expect(body.authenticationType).toBe("DATABASE");
    expect(typeof body.id).toBe("number");
    expect(typeof body.creationDate).toBe("string");
  });

  test("keeps the is-prefixed keys that @JsonProperty pins", async () => {
    const user = await createUser();
    const body = await json(get(`${API}/account`, { headers: user.authHeaders }));

    // These three survive Jackson's is-stripping via @JsonProperty. Emitting
    // `active`/`suspended`/`admin` instead would break the frontend silently.
    expect(body.isActive).toBe(true);
    expect(body.isSuspended).toBe(false);
    expect(body.isAdmin).toBe(false);
    expect("active" in body).toBe(false);
    expect("suspended" in body).toBe(false);
    expect("admin" in body).toBe(false);
  });

  test("never returns a password field", async () => {
    const user = await createUser();
    const body = await json(get(`${API}/account`, { headers: user.authHeaders }));
    expect("password" in body).toBe(false);
  });

  test("reports isAdmin for the configured admin email", async () => {
    // ADMIN_EMAIL=admin@wisemapping.org in .env.test
    const admin = await createUser({ email: "admin@wisemapping.org" });
    const body = await json(get(`${API}/account`, { headers: admin.authHeaders }));
    expect(body.isAdmin).toBe(true);
  });

  test("401s with the {msg} shape, not RestErrors", async () => {
    const res = await get(`${API}/account`);
    expect(res.status).toBe(401);
    // Deliberately a different shape from RestErrors; see AppConfig's entry point.
    expect(await json(res)).toEqual({ msg: "Unauthorized" });
  });

  test("401s on a forged or malformed token", async () => {
    for (const header of [
      "Bearer garbage",
      "Bearer a.b.c",
      "not-a-bearer",
      "Bearer ",
    ]) {
      expect(
        (await get(`${API}/account`, { headers: { Authorization: header } }))
          .status,
      ).toBe(401);
    }
  });
});

describe("account updates (text/plain bodies)", () => {
  test("updates firstname, lastname and locale", async () => {
    const user = await createUser();

    expect(
      (
        await put(`${API}/account/firstname`, {
          text: "Renamed",
          headers: user.authHeaders,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await put(`${API}/account/lastname`, {
          text: "Surname",
          headers: user.authHeaders,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await put(`${API}/account/locale`, {
          text: "es",
          headers: user.authHeaders,
        })
      ).status,
    ).toBe(204);

    const body = await json(get(`${API}/account`, { headers: user.authHeaders }));
    expect(body.firstname).toBe("Renamed");
    expect(body.lastname).toBe("Surname");
    expect(body.locale).toBe("es");
    expect(body.fullName).toBe("Renamed Surname");
  });

  test("omits locale entirely until it is set", async () => {
    // @JsonInclude(NON_NULL) -- an absent key, not null.
    const user = await createUser();
    const body = await json(get(`${API}/account`, { headers: user.authHeaders }));
    expect("locale" in body).toBe(false);
  });

  test("rejects a blank value", async () => {
    const user = await createUser();
    expect(
      (
        await put(`${API}/account/firstname`, {
          text: "  ",
          headers: user.authHeaders,
        })
      ).status,
    ).toBe(400);
  });

  test("changes the password and invalidates the old one", async () => {
    const user = await createUser();

    expect(
      (
        await put(`${API}/account/password`, {
          text: "newpassword456",
          headers: user.authHeaders,
        })
      ).status,
    ).toBe(204);

    const withOld = await post(`${API}/authenticate`, {
      json: { email: user.email, password: user.password },
    });
    expect(withOld.status).toBe(401);
    expect(await login(user.email, "newpassword456")).toBeTruthy();
  });

  test("enforces password bounds on change", async () => {
    const user = await createUser();
    expect(
      (
        await put(`${API}/account/password`, {
          text: "short",
          headers: user.authHeaders,
        })
      ).status,
    ).toBe(400);
  });

  test("requires authentication", async () => {
    expect((await put(`${API}/account/firstname`, { text: "X" })).status).toBe(
      401,
    );
  });
});

describe("DELETE /account", () => {
  test("removes the account and invalidates its token", async () => {
    const user = await createUser();
    expect(
      (await del(`${API}/account`, { headers: user.authHeaders })).status,
    ).toBe(204);

    // The account is reloaded from the database per request, so the still-valid
    // token stops working immediately.
    expect(
      (await get(`${API}/account`, { headers: user.authHeaders })).status,
    ).toBe(401);
  });
});

describe("activation", () => {
  test("rejects an unknown activation code", async () => {
    const res = await put(`${API}/users/activation?code=1234567890123456789`);
    expect(res.status).toBe(400);
  });

  test("requires a code", async () => {
    expect((await put(`${API}/users/activation`)).status).toBe(400);
  });

  test("handles a 19-digit code without precision loss", async () => {
    // A code beyond Number.MAX_SAFE_INTEGER must round-trip as text. If it were
    // parsed as a number this would match a different account, or none.
    const big = "-9223372036854775807";
    const res = await put(
      `${API}/users/activation?code=${encodeURIComponent(big)}`,
    );
    expect(res.status).toBe(400);
  });
});

describe("password reset", () => {
  test("reports EMAIL_SENT for a known address", async () => {
    const user = await createUser();
    const res = await put(
      `${API}/users/resetPassword?email=${encodeURIComponent(user.email)}`,
    );
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ action: "EMAIL_SENT" });
  });

  test("reports EMAIL_SENT for an unknown address too", async () => {
    // Not an account-existence oracle. This diverges from the Java app, which
    // throws EmailNotExistsException here.
    const res = await put(
      `${API}/users/resetPassword?email=nobody@example.org`,
    );
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ action: "EMAIL_SENT" });
  });

  test("requires an email parameter", async () => {
    expect((await put(`${API}/users/resetPassword`)).status).toBe(400);
  });

  test("rejects an invalid reset token", async () => {
    const res = await post(`${API}/users/resetPasswordToken`, {
      json: { token: "nonexistent", password: "newpassword456" },
    });
    expect(res.status).toBe(400);
  });
});
