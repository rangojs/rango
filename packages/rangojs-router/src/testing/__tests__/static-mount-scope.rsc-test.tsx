/**
 * A Static() layout, parallel slot or route exported once and mounted in
 * several include() scopes links in each mount's own module when it is served
 * from its build-time artifact, as it does live: `.settings` from the "a"
 * mount resolves /a/settings, from "b" /b/settings, from "outer.inner"
 * /outer/inner/settings. serveShellRequest serves Static() segments from the
 * artifacts the build bakes, one per mount, so the handlers run once per mount
 * (the bake) and never per request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createRouter, Static, urls } from "../../index.rsc.js";

const runs = { nav: 0, side: 0, page: 0 };

const SharedNav = Static((ctx) => {
  runs.nav++;
  return <nav>{`nav:${ctx.reverse(".settings")}`}</nav>;
});
const SharedSide = Static((ctx) => {
  runs.side++;
  return <aside>{`side:${ctx.reverse(".settings")}`}</aside>;
});
const SharedPage = Static((ctx) => {
  runs.page++;
  return <main>{`page:${ctx.reverse(".settings")}`}</main>;
});

const settingsModule = urls(({ path, layout, parallel }) => [
  layout(SharedNav, () => [
    parallel({ "@side": SharedSide }),
    path("/settings", () => <p>settings</p>, { name: "settings" }),
    path("/page", SharedPage, { name: "page" }),
  ]),
]);

function makeRouter(options: { id: string; basename?: string }) {
  return createRouter(options).routes(
    urls(({ include }) => [
      include("/a", settingsModule, { name: "a" }),
      include("/b", settingsModule, { name: "b" }),
      include(
        "/outer",
        urls(({ include }) => [
          include("/inner", settingsModule, { name: "inner" }),
        ]),
        { name: "outer" },
      ),
    ]),
  );
}

const MOUNTS = [
  { at: "/a", link: "/a/settings" },
  { at: "/b", link: "/b/settings" },
  { at: "/outer/inner", link: "/outer/inner/settings" },
];

/** The `kind:link` texts a payload carries. */
function links(flight: string | undefined): string[] {
  return [...(flight ?? "").matchAll(/(nav|side|page):(\/[\w/]*)/g)].map(
    ([, kind, link]) => `${kind}:${link}`,
  );
}

beforeEach(async () => {
  await resetShellTestState();
  runs.nav = runs.side = runs.page = 0;
});

describe("Static() served from its artifact links in its own mount's scope", () => {
  it.each(MOUNTS)(
    "a document under $at serves its own mount's layout, slot and route",
    async ({ at, link }) => {
      const router = makeRouter({ id: `static-scope-doc${at}` });
      const settings = await serveShellRequest(router, `${at}/settings`);
      expect(settings.response.status).toBe(200);
      expect(links(settings.flight).sort()).toEqual(
        [`nav:${link}`, `side:${link}`].sort(),
      );
      const page = await serveShellRequest(router, `${at}/page`);
      expect(links(page.flight).sort()).toEqual(
        [`nav:${link}`, `page:${link}`, `side:${link}`].sort(),
      );
    },
  );

  it("every mount reads its own artifact, whichever mount was baked last", async () => {
    const router = makeRouter({ id: "static-scope-all" });
    // Reach every mount first, so all of them are baked before any is served.
    for (const { at } of MOUNTS) await serveShellRequest(router, `${at}/page`);
    const baked = { ...runs };
    expect(baked).toEqual({ nav: 3, side: 3, page: 3 });
    for (const { at, link } of MOUNTS) {
      const result = await serveShellRequest(router, `${at}/page`);
      expect(links(result.flight).sort()).toEqual(
        [`nav:${link}`, `page:${link}`, `side:${link}`].sort(),
      );
    }
    // Served from the artifacts: no handler ran for these requests.
    expect(runs).toEqual(baked);
  });

  it("a client navigation between mounts serves the target mount's artifacts", async () => {
    const router = makeRouter({ id: "static-scope-nav" });
    await serveShellRequest(router, "/a/settings");
    const result = await serveShellRequest(router, "/b/page", {
      partial: { from: "/a/settings" },
    });
    expect(links(result.flight).sort()).toEqual(
      ["nav:/b/settings", "page:/b/settings", "side:/b/settings"].sort(),
    );
  });

  it("under a basename each mount links with the basename and its own scope", async () => {
    const router = makeRouter({ id: "static-scope-base", basename: "/app" });
    for (const { at, link } of MOUNTS) {
      const result = await serveShellRequest(router, `/app${at}/page`);
      expect(links(result.flight).sort()).toEqual(
        [`nav:/app${link}`, `page:/app${link}`, `side:/app${link}`].sort(),
      );
    }
  });
});
