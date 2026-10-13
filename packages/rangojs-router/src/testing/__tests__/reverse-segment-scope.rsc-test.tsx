/**
 * A segment's `ctx.reverse(".name")` resolves in the module that DEFINES the
 * segment (dc-t52). One handler ctx serves the whole request and is built
 * from the matched route's name, so a parent module's layout used to resolve
 * `.settings` from the matched child module first: on `/acme/web/issues` the
 * account layout linked to the project's settings. The layout, its parallel
 * slot and its loader now link inside the account module on every page below
 * it; the matched route's own dot names, global names, mount-param autofill
 * and explicit params are unchanged.
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

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import {
  createLoader,
  createRouter,
  rewrite,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { cachedSettingsLink } from "./fixtures/reverse-segment-scope-data.js";

const AccountSettingsLink = createLoader(async (ctx) => {
  await Promise.resolve();
  return `account-loader:${ctx.reverse(".settings")}`;
});

/** The project route's loader, which the account layout also reads first. */
const IssuesSettingsLink = createLoader(async (ctx) => {
  await Promise.resolve();
  return `issues-loader:${ctx.reverse(".settings")}`;
});

/** A server component the account layout hands its ctx to; renders later. */
async function AccountChildLink({ ctx }: { ctx: HandlerContext }) {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return <p>{`account-child:${ctx.reverse(".settings")}`}</p>;
}

const projectUrls = urls(({ path, layout, loader }) => [
  layout(
    (ctx) => (
      <section>
        <p>{`project-layout:${ctx.reverse(".settings")}`}</p>
        <p>{`project-layout-up:${ctx.reverse(".billing")}`}</p>
      </section>
    ),
    () => [
      path(
        "/issues",
        (ctx) => (
          <article>
            <p>{`project-route:${ctx.reverse(".settings")}`}</p>
            <p>{`project-route-global:${ctx.reverse("account.settings")}`}</p>
          </article>
        ),
        { name: "issues" },
        () => [loader(IssuesSettingsLink)],
      ),
      path("/settings", () => <article>project settings</article>, {
        name: "settings",
      }),
    ],
  ),
]);

const accountUrls = urls(({ path, layout, include, parallel, loader }) => [
  layout(
    async (ctx) => {
      // After an await: the scope rides the handler's async continuation.
      await new Promise((resolve) => setTimeout(resolve, 1));
      // Starts the project route's loader before the route does: the loader
      // must not inherit this layout's scope.
      if (ctx.params.projectId) await ctx.use(IssuesSettingsLink);
      return (
        <div>
          <p>{`account-layout:${ctx.reverse(".settings")}`}</p>
          <p>
            {`account-layout-explicit:${ctx.reverse(".settings", { accountId: "other" })}`}
          </p>
          <p>{`account-layout-global:${ctx.reverse("account.project.settings", { projectId: "api" })}`}</p>
          <AccountChildLink ctx={ctx} />
          <p>{`account-layout-from:${ctx.rewrittenFrom?.pathname ?? "direct"}`}</p>
        </div>
      );
    },
    () => [
      loader(AccountSettingsLink),
      parallel({
        "@aside": (ctx) => (
          <aside>{`account-slot:${ctx.reverse(".settings")}`}</aside>
        ),
      }),
      path("/settings", () => <article>account settings</article>, {
        name: "settings",
      }),
      path("/billing", () => <article>account billing</article>, {
        name: "billing",
      }),
      include("/:projectId", projectUrls, { name: "project" }),
    ],
  ),
]);

const router = createRouter({})
  .use(async (ctx, next) => {
    if (ctx.pathname === "/acme/old-settings") throw rewrite("/acme/settings");
    return next();
  })
  .routes(
    urls(({ path, include }) => [
      path("/", () => <p>home</p>, { name: "home" }),
      include("/:accountId", accountUrls, { name: "account" }),
    ]),
  );

/** A root layout above the account module, linking to a root route. */
const rootLayoutRouter = createRouter({}).routes(
  urls(({ path, layout, include }) => [
    layout(
      (ctx) => <main>{`root-layout:${ctx.reverse(".home")}`}</main>,
      () => [
        path("/", () => <p>home</p>, { name: "home" }),
        include("/:accountId", accountUrls, { name: "account" }),
      ],
    ),
  ]),
);

/** Which segment calls cachedSettingsLink(ctx) on the next request. */
let cachedCaller: "layout" | "route" = "layout";

const cachedRouter = createRouter({}).routes(
  urls(({ path, include }) => [
    include(
      "/:accountId",
      urls(({ path, layout, include }) => [
        layout(
          async (ctx) => (
            <div>
              {cachedCaller === "layout"
                ? `cached-layout:${await cachedSettingsLink(ctx)}`
                : null}
            </div>
          ),
          () => [
            path("/settings", () => <article>account settings</article>, {
              name: "settings",
            }),
            include(
              "/:projectId",
              urls(({ path }) => [
                path(
                  "/issues",
                  async (ctx) => (
                    <article>
                      {cachedCaller === "route"
                        ? `cached-route:${await cachedSettingsLink(ctx)}`
                        : null}
                    </article>
                  ),
                  { name: "issues" },
                ),
                path("/settings", () => <article>project settings</article>, {
                  name: "settings",
                }),
              ]),
              { name: "project" },
            ),
          ],
        ),
      ]),
      { name: "account" },
    ),
    path("/", () => <p>home</p>, { name: "home" }),
  ]),
);

beforeEach(() => resetShellTestState());

async function render(
  url: string,
  partial?: { from: string },
  app: typeof router = router,
): Promise<string> {
  const result = await serveShellRequest(app, url, {
    cacheStore: new MemorySegmentCacheStore(),
    ...(partial ? { partial } : {}),
  });
  expect(result.response.status).toBe(200);
  return result.flight ?? "";
}

describe("ctx.reverse('.name') resolves in the module that defines the segment", () => {
  it("the account layout, slot and loader link to the account route on the account page", async () => {
    const flight = await render("/acme/settings");
    expect(flight).toContain("account-layout:/acme/settings");
    expect(flight).toContain("account-slot:/acme/settings");
    expect(flight).toContain("account-loader:/acme/settings");
  });

  it.each([
    ["a document load", undefined],
    ["a navigation from outside the account", { from: "/" }],
  ] as const)(
    "on a project page (%s) they still link to the account route",
    async (_label, partial) => {
      const flight = await render("/acme/web/issues", partial);
      expect(flight).toContain("account-layout:/acme/settings");
      expect(flight).toContain("account-slot:/acme/settings");
      expect(flight).toContain("account-loader:/acme/settings");
      // The scope rides the ctx into a component that renders after the
      // layout's handler returned.
      expect(flight).toContain("account-child:/acme/settings");
      expect(flight).not.toContain("account-layout:/acme/web/settings");
    },
  );

  it("the layout's scoped ctx reads every other field through", async () => {
    const flight = await render("/acme/old-settings");
    expect(flight).toContain("account-layout:/acme/settings");
    expect(flight).toContain("account-layout-from:/acme/old-settings");
  });

  it("the matched route's own dot names still resolve in its module", async () => {
    const flight = await render("/acme/web/issues");
    expect(flight).toContain("project-route:/acme/web/settings");
    // Its loader too, though the account layout's handler started it first.
    expect(flight).toContain("issues-loader:/acme/web/settings");
    expect(flight).toContain("project-route-global:/acme/settings");
  });

  it("a nested module's layout resolves in its own module, then walks up", async () => {
    const flight = await render("/acme/web/issues");
    expect(flight).toContain("project-layout:/acme/web/settings");
    expect(flight).toContain("project-layout-up:/acme/billing");
  });

  it("explicit params win and global names are unchanged in a segment", async () => {
    const flight = await render("/acme/web/issues");
    expect(flight).toContain("account-layout-explicit:/other/settings");
    expect(flight).toContain("account-layout-global:/acme/api/settings");
  });

  it("a root layout resolves dot names at root scope", async () => {
    // Before: the matched route's named-include scope has no bare-name
    // fallback, so the root layout threw "Unknown route" on every nested page.
    const flight = await render(
      "/acme/web/issues",
      undefined,
      rootLayoutRouter,
    );
    expect(flight).toContain('"root-layout:/"');
  });

  it('a "use cache" function taking ctx keys by the segment\'s scope', async () => {
    // Same route, pathname and params: only the scope tells the layout's
    // call from the route's. Keyed without it, the route read the layout's
    // cached "/acme/settings".
    const cacheStore = new MemorySegmentCacheStore();
    const serve = async () => {
      const result = await serveShellRequest(cachedRouter, "/acme/web/issues", {
        cacheStore,
      });
      return result.flight ?? "";
    };
    cachedCaller = "layout";
    expect(await serve()).toContain("cached-layout:/acme/settings");
    cachedCaller = "route";
    expect(await serve()).toContain("cached-route:/acme/web/settings");
  });
});
