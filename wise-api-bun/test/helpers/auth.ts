import { API, post } from "./client.ts";

export interface TestUser {
  email: string;
  password: string;
  token: string;
  authHeaders: Record<string, string>;
}

let counter = 0;

/**
 * Register and log in a user, returning its bearer headers.
 *
 * Email confirmation is disabled in .env.test, so registration activates
 * immediately and login works without an activation round-trip.
 */
export async function createUser(
  overrides: Partial<Record<string, unknown>> = {},
): Promise<TestUser> {
  counter += 1;
  const email =
    (overrides.email as string | undefined) ??
    `user${counter}.${Bun.nanoseconds()}@example.org`;
  const password = (overrides.password as string | undefined) ?? "password123";

  const res = await post(`${API}/users/`, {
    json: {
      email,
      firstname: "Test",
      lastname: `User${counter}`,
      password,
      acceptedTerms: true,
      ...overrides,
    },
  });
  if (res.status !== 201) {
    throw new Error(`createUser failed: ${res.status} ${await res.text()}`);
  }

  const token = await login(email, password);
  return {
    email,
    password,
    token,
    authHeaders: { Authorization: `Bearer ${token}` },
  };
}

export async function login(email: string, password: string): Promise<string> {
  const res = await post(`${API}/authenticate`, { json: { email, password } });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  return res.text();
}
