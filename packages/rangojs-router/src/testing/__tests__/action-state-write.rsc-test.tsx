/**
 * A server action's response bumps the write part of the rango state, through
 * serveShellRequest (`action` for the JS call, `form` with createActionForm
 * for a post before hydration), the public primitives.
 *
 * The state cookie (`{version}:{timestamp}[:{write}]`) is what the client
 * sends as `X-Rango-State` on every prefetch and navigation, and responses
 * vary on it. An action without a directive answers with a Set-Cookie that
 * keeps the request's timestamp and carries a greater write part, so a
 * response the browser HTTP cache holds from before the write (its own
 * `Cache-Control: max-age`) is not answered after it, in this tab, after a
 * reload or in another tab. The timestamp stays, so the client's in-memory
 * prefetches only go stale. keepClientCache() bumps nothing;
 * invalidateClientCache() rotates the timestamp instead.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import {
  createActionForm,
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import {
  createRouter,
  invalidateClientCache,
  keepClientCache,
  redirect,
  urls,
} from "../../index.rsc.js";

const COOKIE = "rango-state_shop";

let cart = 0;

async function addToCart(): Promise<number> {
  return ++cart;
}

async function addThenFail(): Promise<void> {
  cart++;
  throw new Error("payment declined");
}

async function addThenRedirect(): Promise<void> {
  cart++;
  throw redirect("/basket");
}

async function readOnly(): Promise<number> {
  keepClientCache();
  return cart;
}

async function addAndInvalidate(): Promise<number> {
  invalidateClientCache();
  return ++cart;
}

async function addFromForm(_form: FormData): Promise<void> {
  cart++;
}

function makeRouter() {
  return createRouter({ id: "shop" }).routes(
    urls(({ path }) => [
      path("/product", () => <p>cart:{cart}</p>, { name: "product" }),
      path("/basket", () => <p>basket:{cart}</p>, { name: "basket" }),
    ]),
  );
}

/** The state Set-Cookie lines of a response. */
function stateCookies(result: ServeShellRequestResult): string[] {
  return result.response.headers
    .getSetCookie()
    .filter((line) => line.startsWith(`${COOKIE}=`));
}

/** `{ timestamp, write }` of the one state Set-Cookie a response carries. */
function stateParts(result: ServeShellRequestResult): {
  timestamp: string;
  write: string | undefined;
} {
  const lines = stateCookies(result);
  expect(lines).toHaveLength(1);
  const value = lines[0]!.slice(COOKIE.length + 1).split(";")[0]!;
  const [, timestamp, write] = value.split(":");
  return { timestamp: timestamp!, write };
}

function call(
  ref: (...args: any[]) => unknown,
  id: string,
  state = "v1:1000",
): Promise<ServeShellRequestResult> {
  return serveShellRequest(makeRouter(), "/product", {
    headers: { Cookie: `${COOKIE}=${state}` },
    action: { ref, id },
  });
}

beforeEach(async () => {
  cart = 0;
  await resetShellTestState();
});

describe("a server action's response and the state's write part", () => {
  it("keeps the timestamp and sets a write part", async () => {
    const result = await call(addToCart, "actions/cart#add");

    expect((await result.readAction())?.result).toBe(1);
    expect(stateParts(result)).toEqual({
      timestamp: "1000",
      write: expect.stringMatching(/^\d+$/),
    });
  });

  it("sets a write part greater than the one the request carried", async () => {
    const ahead = (Date.now() + 60_000) * 1000;
    const result = await call(
      addToCart,
      "actions/cart#add",
      `v1:1000:${ahead}`,
    );

    const { timestamp, write } = stateParts(result);
    expect(timestamp).toBe("1000");
    expect(Number(write)).toBeGreaterThan(ahead);
  });

  it("bumps it when the action throws or redirects: the write may have landed", async () => {
    const failed = await call(addThenFail, "actions/cart#addThenFail");
    expect((await failed.readAction())?.ok).toBe(false);
    expect(stateParts(failed).timestamp).toBe("1000");
    expect(stateParts(failed).write).toMatch(/^\d+$/);

    const redirected = await call(addThenRedirect, "actions/cart#redirect");
    expect(redirected.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/basket",
    );
    expect(stateParts(redirected).write).toMatch(/^\d+$/);
  });

  it("bumps it for a form posted before hydration", async () => {
    const result = await serveShellRequest(makeRouter(), "/product", {
      headers: { Cookie: `${COOKIE}=v1:1000` },
      form: createActionForm(addFromForm, {
        id: "actions/cart#addFromForm",
        useActionState: false,
      }),
    });

    expect(result.response.status).toBe(200);
    expect(stateParts(result)).toEqual({
      timestamp: "1000",
      write: expect.stringMatching(/^\d+$/),
    });
  });

  it("bumps nothing after keepClientCache()", async () => {
    const result = await call(readOnly, "actions/cart#readOnly");

    expect((await result.readAction())?.result).toBe(0);
    expect(stateCookies(result)).toEqual([]);
  });

  it("invalidateClientCache() rotates the timestamp instead, with no write part", async () => {
    const result = await call(addAndInvalidate, "actions/cart#invalidate");

    const { timestamp, write } = stateParts(result);
    expect(Number(timestamp)).toBeGreaterThan(1000);
    expect(write).toBeUndefined();
  });

  it("sets nothing when the request carries no state", async () => {
    const result = await serveShellRequest(makeRouter(), "/product", {
      action: { ref: addToCart, id: "actions/cart#add" },
    });

    expect((await result.readAction())?.result).toBe(1);
    expect(stateCookies(result)).toEqual([]);
  });
});
