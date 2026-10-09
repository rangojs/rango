/**
 * A build-time shell belongs to the router that captured it (issue #1065): a
 * real `vite build` of the two-app host fixture, then document requests
 * against the built server.
 *
 * The build stages each shell under its capturing router's id and the runtime
 * looks it up under the serving router's, so the two must be one id:
 *
 * - app A's createRouter() takes an options variable, which the id transform
 *   cannot reach, so it runs on the `router_{n}` counter fallback. One such
 *   router is `router_0` in build discovery and in the built server.
 * - app B's createRouter() takes a literal and gets the injected `$$id`.
 *
 * Both routers run the same `version`, so only the manifest key keeps app A's
 * `/shelled` shell away from app B's own `/shelled` route.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFixture,
  createFixtureWorkspace,
  requestBuiltFixture,
  type FixtureBuild,
  type FixtureResponse,
  type FixtureScenario,
} from "./helpers/build-cache-versions-fixture.js";
import { routerId } from "../plugins/expose-ids/router-transform.js";

const B_ROUTER_ID = routerId("src/apps/b/router.tsx", 0);

const scenario: FixtureScenario = {
  edits: {
    // An ESM package, as an app is: the server entries build to `.js`, the
    // name the RSC entry imports the SSR entry by.
    "package.json": `{ "type": "module" }\n`,
    "src/shared/store.ts": [
      `import { MemorySegmentCacheStore } from "@rangojs/router/cache";`,
      ``,
      `export const store = new MemorySegmentCacheStore();`,
      ``,
    ].join("\n"),
    "src/apps/a/router.tsx": [
      `import { createRouter } from "@rangojs/router";`,
      `import { store } from "../../shared/store.js";`,
      `import { urlpatterns } from "./urls.js";`,
      ``,
      `const options = { version: "one", cache: { store } };`,
      `export const router = createRouter(options).routes(urlpatterns);`,
      ``,
    ].join("\n"),
    "src/apps/a/urls.tsx": (source) =>
      source
        .replace(
          `import { urls } from "@rangojs/router";`,
          [
            `import { urls, Prerender } from "@rangojs/router";`,
            `const Shelled = Prerender(async () => <main>app-a-shelled</main>);`,
          ].join("\n"),
        )
        .replace(
          `  path("/note/:id"`,
          `  path("/shelled", Shelled, { name: "shelled", ppr: true }),\n  path("/note/:id"`,
        ),
    "src/apps/b/router.tsx": [
      `import { createRouter } from "@rangojs/router";`,
      `import { store } from "../../shared/store.js";`,
      `import { urlpatterns } from "./urls.js";`,
      ``,
      `export const router = createRouter({`,
      `  version: "one",`,
      `  cache: { store },`,
      `}).routes(urlpatterns);`,
      ``,
    ].join("\n"),
    "src/apps/b/urls.tsx": (source) =>
      source
        .replace(
          `import { urls } from "@rangojs/router";`,
          [
            `import { urls, Prerender } from "@rangojs/router";`,
            `const OwnShelled = Prerender(async () => <main>app-b-own-shelled</main>);`,
          ].join("\n"),
        )
        .replace(
          `  include("/pages"`,
          [
            `  path("/b-shelled", OwnShelled, { name: "ownShelled", ppr: true }),`,
            // Not prerendered: the build captures no shell for it.
            `  path("/shelled", () => <main>app-b-shelled</main>, {`,
            `    name: "plainShelled",`,
            `    ppr: true,`,
            `  }),`,
            `  include("/pages"`,
          ].join("\n"),
        ),
  },
};

/** What a response says about the shell it was served from. */
function served(response: FixtureResponse): {
  shell: string | undefined;
  pages: string[];
} {
  return {
    shell: response.headers["x-rango-shell"],
    pages: [...new Set(response.body.match(/app-[ab]-[a-z-]*shelled/g) ?? [])],
  };
}

describe("build-time shells of a two-router build", () => {
  const workspace = createFixtureWorkspace();
  let build: FixtureBuild;

  beforeAll(async () => {
    build = await buildFixture(join(workspace.dir, "app"), scenario);
  }, 240_000);

  afterAll(() => workspace.cleanup());

  it("stages each shell under the id of the router that captured it", () => {
    const manifest = readFileSync(
      join(build.root, "dist/rsc/__shell-manifest.js"),
      "utf-8",
    );
    const keys = [...manifest.matchAll(/"([^"]*@\/[^"]*)":/g)].map(
      (match) => match[1],
    );
    expect(keys.sort()).toEqual(
      ["router_0@/shelled", `${B_ROUTER_ID}@/b-shelled`].sort(),
    );
  });

  it("a cold server's first request is a HIT from the router's own build shell", async () => {
    // A single router on the counter fallback included: its build discovery
    // id is its runtime id.
    const [fromA] = await requestBuiltFixture(build.root, [
      "http://a.localhost/shelled",
    ]);
    expect(served(fromA!)).toEqual({ shell: "HIT", pages: ["app-a-shelled"] });

    const [fromB] = await requestBuiltFixture(build.root, [
      "http://b.localhost/b-shelled",
    ]);
    expect(served(fromB!)).toEqual({
      shell: "HIT",
      pages: ["app-b-own-shelled"],
    });
  }, 60_000);

  it("a router never serves the shell the build captured for another router's route on the same pathname", async () => {
    const [fromB] = await requestBuiltFixture(build.root, [
      "http://b.localhost/shelled",
    ]);
    expect(served(fromB!)).toEqual({ shell: "MISS", pages: ["app-b-shelled"] });
  }, 60_000);
});
