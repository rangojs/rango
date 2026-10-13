/**
 * A clientUrls() group under a parameterized include(), through a public
 * primitive: a client navigation (`serveShellRequest` with
 * `partial: { from }`) between the group's routes activates its module-local
 * intercept under `/:locale` and `/:locale?` as under a literal mount. An
 * origin the router routes elsewhere (a root `/login` that the group's
 * `/:slug` also matches, a sibling `/:locale/about`), or in another mount
 * instance (another locale), gets the full page. The group's routes carry
 * the server routes that compete with them for a URL (`foreign`), so the
 * browser does not present those either.
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
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import { createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import group from "./fixtures/client-urls-param-mount.js";

function routerUnder(mount: string) {
  return createRouter({}).routes(
    urls(({ path, layout, include }) => [
      layout(
        () => <main>shell</main>,
        () => [
          // Unnamed: the origin gate looks it up in the router's trie.
          path("/login", () => <p>login</p>),
          path("/about/us", () => <p>about</p>, { name: "about" }),
          path("/:locale/about", () => <p>locale about</p>, {
            name: "localeAbout",
          }),
          include(mount, group, { name: "shop" }),
        ],
      ),
    ]),
  );
}

function payload(result: ServeShellRequestResult): string {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row, "a Flight payload").toBeDefined();
  return row!;
}

function interceptSegmentIds(result: ServeShellRequestResult): string[] {
  const { segments } = JSON.parse(payload(result).slice(2)).metadata as {
    segments: Array<{ id: string; namespace?: string }>;
  };
  return segments
    .filter((segment) => segment.namespace?.startsWith("intercept:"))
    .map((segment) => segment.id);
}

/** The `foreign` prop of the group's ClientUrlsRoot in the payload. */
function foreign(result: ServeShellRequestResult): string[] | undefined {
  const found = /"foreign":(\[[^\]]*\])/.exec(payload(result));
  return found ? (JSON.parse(found[1]!) as string[]).sort() : undefined;
}

async function navigator(mount: string) {
  const router = routerUnder(mount);
  const serve = (to: string, from: string) =>
    serveShellRequest(router, to, {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from },
    });
  // A router's first serveShellRequest matches before its route trie is
  // built (the regex fallback, first match in definition order); every later
  // one matches with the trie, as an app does. The group's /:slug makes
  // `/detail/1` ambiguous, so warm the router first.
  await serve("/about/us", "/about/us");
  return {
    serve,
    intercepts: async (to: string, from: string): Promise<boolean> =>
      interceptSegmentIds(await serve(to, from)).length > 0,
  };
}

beforeEach(() => resetShellTestState());

describe("clientUrls() intercept under a parameterized include()", () => {
  it("a literal mount (control)", async () => {
    const { intercepts } = await navigator("/shop");
    expect(await intercepts("/shop/detail/1", "/shop")).toBe(true);
    expect(await intercepts("/shop/detail/1", "/about/us")).toBe(false);
  });

  it("/:locale: an in-group origin of the same locale opens the modal", async () => {
    const { intercepts } = await navigator("/:locale");
    expect(await intercepts("/en/detail/1", "/en")).toBe(true);
    expect(await intercepts("/en/detail/1", "/en/shoe")).toBe(true);
    // Another locale is another instance of the include: the full page.
    expect(await intercepts("/en/detail/1", "/de")).toBe(false);
    expect(await intercepts("/en/detail/1", "/about/us")).toBe(false);
    // The group's /:slug matches /en/about too, but the router serves the
    // sibling route there.
    expect(await intercepts("/en/detail/1", "/en/about")).toBe(false);
  });

  it("/:locale?: with and without the prefix; a prefix change is the full page", async () => {
    const { intercepts } = await navigator("/:locale?");
    expect(await intercepts("/detail/1", "/")).toBe(true);
    expect(await intercepts("/detail/1", "/shoe")).toBe(true);
    expect(await intercepts("/en/detail/1", "/en/shoe")).toBe(true);
    expect(await intercepts("/detail/1", "/en/shoe")).toBe(false);
    expect(await intercepts("/en/detail/1", "/shoe")).toBe(false);
    expect(await intercepts("/detail/1", "/about/us")).toBe(false);
    // The group's /:slug matches a root /login (unnamed) too, but the router
    // serves the login route there.
    expect(await intercepts("/detail/1", "/login")).toBe(false);
  });
});

describe("clientUrls() group routes carry the server routes that compete with them", () => {
  // Every route a URL of the group can also be: under /:locale?, the root
  // /login (the group's /:slug and its /:locale index both match it),
  // /about/us and /:locale/about (/:locale/:slug matches both).
  it("/:locale?", async () => {
    const { serve } = await navigator("/:locale?");
    expect(foreign(await serve("/", "/about/us"))).toEqual([
      "/:locale/about",
      "/about/us",
      "/login",
    ]);
  });

  it("/:locale", async () => {
    const { serve } = await navigator("/:locale");
    expect(foreign(await serve("/en", "/about/us"))).toEqual([
      "/:locale/about",
      "/about/us",
      "/login",
    ]);
  });

  // /shop/about matches /:locale/about and the group's /shop/:slug; the
  // router's trie, and so the browser's, gives it to the group (a static
  // segment first).
  it("a literal mount", async () => {
    const { serve } = await navigator("/shop");
    expect(foreign(await serve("/shop", "/about/us"))).toEqual([
      "/:locale/about",
    ]);
  });
});
