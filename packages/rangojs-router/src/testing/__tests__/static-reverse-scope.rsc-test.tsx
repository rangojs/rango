/**
 * A Static() layout or slot bakes ctx.reverse(".name") in the module that
 * defines it, at every nesting depth (root included), so the baked segment
 * links where the same segment links when it renders live.
 *
 * The bake used to hand the def's name PREFIX to resolveRouteName, which
 * strips one more segment: the project layout baked the account route and a
 * root-level layout threw "Unknown route". Both halves are asserted here
 * against each other, so a drift in either one fails.
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
import {
  createRouter,
  getRequestContext,
  Static,
  urls,
} from "../../index.rsc.js";
import type { StaticBuildContext } from "../../index.rsc.js";
import { toInternal } from "../../router/router-interfaces.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

// Literal segments: a Static segment has no params, so a route with a required
// mount param could only bake `Missing param` in both the old and new code.
/** A server component the layout hands its ctx to; renders later. */
async function ProjectChildLink({ ctx }: { ctx: StaticBuildContext }) {
  await Promise.resolve();
  return <p>{`project-child:${ctx.reverse(".settings")}`}</p>;
}

const ProjectLayout = Static(async (ctx) => {
  // After an await: the scope rides the ctx, not the call frame, exactly as
  // it does for a live layout.
  await Promise.resolve();
  // Detached: the scope is closed over, not read off the receiver.
  const { reverse } = ctx;
  return (
    <section>
      <p>{`project-layout-detached:${reverse(".settings")}`}</p>
      <p>{`project-layout:${ctx.reverse(".settings")}`}</p>
      <p>{`project-layout-up:${ctx.reverse(".billing")}`}</p>
      <p>{`project-layout-request:${getRequestContext()!.reverse(".settings")}`}</p>
      <ProjectChildLink ctx={ctx} />
    </section>
  );
});

const ProjectSlot = Static((ctx) => (
  <aside>{`project-slot:${ctx.reverse(".settings")}`}</aside>
));

const RootLayout = Static((ctx) => (
  <main>{`root-layout:${ctx.reverse(".home")}`}</main>
));

const projectUrls = urls(({ path, layout, parallel }) => [
  layout(ProjectLayout, () => [
    parallel({ "@aside": ProjectSlot }),
    path("/issues", () => <article>issues</article>, { name: "issues" }),
    path("/settings", () => <article>project settings</article>, {
      name: "settings",
    }),
  ]),
]);

const accountUrls = urls(({ path, layout, include }) => [
  layout(
    (ctx) => <div>{`account-layout:${ctx.reverse(".settings")}`}</div>,
    () => [
      path("/settings", () => <article>account settings</article>, {
        name: "settings",
      }),
      path("/billing", () => <article>account billing</article>, {
        name: "billing",
      }),
      include("/web", projectUrls, { name: "project" }),
    ],
  ),
]);

const router = createRouter({}).routes(
  urls(({ path, layout, include }) => [
    layout(RootLayout, () => [
      path("/", () => <p>home</p>, { name: "home" }),
      include("/acme", accountUrls, { name: "account" }),
    ]),
  ]),
);

/** The bake entry the build's static collector calls. */
async function bake(def: any): Promise<string> {
  const result = await toInternal(router).renderStaticSegment(
    def.handler,
    def.$$id,
    def.$$routeName ?? def.$$routePrefix,
    undefined,
    undefined,
    def.$$reverseScope,
  );
  return result?.encoded ?? "";
}

async function renderLive(url: string): Promise<string> {
  const result = await serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
  });
  expect(result.response.status).toBe(200);
  return result.flight ?? "";
}

beforeEach(() => resetShellTestState());

describe("a Static() segment bakes the same reverse() the live segment resolves", () => {
  it("a layout and a slot in a nested module bake their own module's route", async () => {
    // The live render runs first: includes are lazy, so it fills the router's
    // route map the way a first request does before the bake reads it.
    const live = await renderLive("/acme/web/issues");
    expect(live).toContain("project-layout:/acme/web/settings");
    expect(live).toContain("project-slot:/acme/web/settings");
    expect(live).toContain("project-child:/acme/web/settings");
    expect(live).toContain("project-layout-detached:/acme/web/settings");
    expect(live).toContain("project-layout-request:/acme/web/settings");

    const layoutBaked = await bake(ProjectLayout);
    const slotBaked = await bake(ProjectSlot);

    // Before: the prefix lost its last segment and both baked /acme/settings.
    expect(layoutBaked).toContain("project-layout:/acme/web/settings");
    expect(layoutBaked).toContain("project-layout-up:/acme/billing");
    expect(layoutBaked).toContain("project-layout-detached:/acme/web/settings");
    expect(layoutBaked).toContain("project-layout-request:/acme/web/settings");
    expect(layoutBaked).toContain("project-child:/acme/web/settings");
    expect(slotBaked).toContain("project-slot:/acme/web/settings");
  });

  it("a root-level layout bakes a root-scope dot name", async () => {
    const live = await renderLive("/acme/web/issues");
    expect(live).toContain("root-layout:/");

    const baked = await bake(RootLayout);

    // Before: no prefix, so ".home" threw Unknown route at build.
    expect(baked).toContain("root-layout:/");
  });
});
