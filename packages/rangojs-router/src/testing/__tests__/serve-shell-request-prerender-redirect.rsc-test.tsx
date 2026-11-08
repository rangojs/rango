/**
 * A Prerender() handler that returns redirect(), seen from an app's own test.
 *
 * The handler's type takes a Response, as a path() handler's does, so
 * `return redirect(url)` compiles. A build cannot bake a Response, and
 * serveShellRequest bakes a Prerender route the way the build does, so the
 * request rejects with the error the build's FAIL line prints: it names the
 * URL, the redirect target and where a redirect belongs instead. A param
 * whose handler renders a page still serves from its bake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createRouter, Prerender, redirect, urls } from "../../index.rsc.js";

const Article = Prerender(
  async () => [{ slug: "current" }, { slug: "old" }],
  async (ctx) => {
    if (ctx.params.slug === "old") return redirect("/articles/current", 308);
    return <article>{`article ${ctx.params.slug}`}</article>;
  },
);

const router = createRouter({}).routes(
  urls(({ path }) => [path("/articles/:slug", Article, { name: "article" })]),
);

describe("a Prerender() handler that returns redirect()", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cannot be baked: the bake rejects naming the URL and the target", async () => {
    await expect(serveShellRequest(router, "/articles/old")).rejects.toThrow(
      "The prerender of /articles/old redirected to /articles/current (308). " +
        "A build cannot store a redirect or other Response.",
    );
  });

  it("a param whose handler renders still serves from its bake", async () => {
    const result = await serveShellRequest(router, "/articles/current");
    expect(result.response.status).toBe(200);
    expect(result.body).toContain("article current");
  });
});
