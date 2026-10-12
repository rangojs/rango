/**
 * Userland: a cookie name is request data, so cookies() answers only for the
 * cookies the request sent, never for a member of Object.prototype (#1109).
 * Through dispatch(), the router's real matching and middleware.
 */
import { describe, expect, it, vi } from "vitest";

function pluginRscMock() {
  return {
    createFromReadableStream: vi.fn(),
    renderToReadableStream: vi.fn(),
    loadServerAction: vi.fn(),
    decodeReply: vi.fn(),
    decodeAction: vi.fn(),
    decodeFormState: vi.fn(),
    createTemporaryReferenceSet: vi.fn(),
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import { dispatch } from "../dispatch.js";
import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";
import { cookies } from "../../server/cookie-store.js";

const NAMES = ["constructor", "toString", "valueOf", "__proto__"];

const router = createRouter({}).routes(
  urls(({ path }) => [
    path.json(
      "/api/cookies",
      () =>
        NAMES.map((name) => ({
          name,
          has: cookies().has(name),
          get: cookies().get(name) ?? null,
          getAll: cookies().getAll(name),
        })),
      { name: "api.cookies" },
    ),
  ]),
) as any;

const request = (cookie: string) =>
  new Request("http://localhost/api/cookies", { headers: { cookie } });

describe("cookies() with names like Object.prototype members", () => {
  it("reads none of them when the request did not send them", async () => {
    const res = await dispatch(router, { request: request("session=s") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      NAMES.map((name) => ({ name, has: false, get: null, getAll: [] })),
    );
  });

  it("reads one the request sent like any other cookie", async () => {
    const res = await dispatch(router, {
      request: request("toString=t; __proto__=p"),
    });
    const byName = Object.fromEntries(
      ((await res.json()) as Array<{ name: string; has: boolean }>).map(
        (row) => [row.name, row],
      ),
    );
    expect(byName.toString).toEqual({
      name: "toString",
      has: true,
      get: { name: "toString", value: "t" },
      getAll: [{ name: "toString", value: "t" }],
    });
    expect(byName.__proto__).toEqual({
      name: "__proto__",
      has: true,
      get: { name: "__proto__", value: "p" },
      getAll: [{ name: "__proto__", value: "p" }],
    });
    expect(byName.constructor).toMatchObject({ has: false, get: null });
  });
});
