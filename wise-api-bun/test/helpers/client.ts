import { app } from "../../src/app.ts";

const BASE = "http://localhost";
export const API = "/api/restful";

export interface Options {
  headers?: Record<string, string>;
  /** Raw string body sent as `text/plain`, for the many text/plain routes. */
  text?: string;
  /** JSON body. */
  json?: unknown;
  /** Raw body with an explicit content type (e.g. `application/xml`). */
  raw?: { body: string; contentType: string };
}

/**
 * Drive the Hono app directly via `app.fetch` -- no socket, no port, no server
 * lifecycle. Equivalent coverage to the Java `TestRestTemplate` integration
 * tests, minus the boot cost.
 */
export function request(
  method: string,
  path: string,
  opts: Options = {},
): Promise<Response> {
  const headers = new Headers(opts.headers);
  let body: string | undefined;

  if (opts.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(opts.json);
  } else if (opts.text !== undefined) {
    headers.set("Content-Type", "text/plain");
    body = opts.text;
  } else if (opts.raw !== undefined) {
    headers.set("Content-Type", opts.raw.contentType);
    body = opts.raw.body;
  }

  // app.fetch is typed `Response | Promise<Response>`; normalise to a promise.
  return Promise.resolve(
    app.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers,
        ...(body !== undefined && { body }),
      }),
    ),
  );
}

/**
 * Parse a JSON response body.
 *
 * `Response.json()` is typed `Promise<unknown>`, which is correct but turns
 * every assertion on a response field into a type error. Tests assert on shapes
 * the server itself controls, so a loose record type is the right trade.
 */
export async function json(
  res: Response | Promise<Response>,
): Promise<Record<string, any>> {
  return (await (await res).json()) as Record<string, any>;
}

export const get = (path: string, opts?: Options) => request("GET", path, opts);
export const post = (path: string, opts?: Options) =>
  request("POST", path, opts);
export const put = (path: string, opts?: Options) => request("PUT", path, opts);
export const del = (path: string, opts?: Options) =>
  request("DELETE", path, opts);
