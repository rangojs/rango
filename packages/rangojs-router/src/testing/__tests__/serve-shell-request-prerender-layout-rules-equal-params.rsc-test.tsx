/**
 * A held layout's revalidate() rules on a navigation that keeps the params,
 * served from a `Prerender()` bake, next to the same navigation rendered live
 * and served from a cache() HIT.
 *
 * The layout marks the active route, so each route's bake holds its own copy.
 * A live walk asks the rules of a held layout above the route whatever the
 * params (router/revalidation.ts "nav:non-route-skip" is only their seed),
 * and a cache() HIT does the same (match-middleware/cache-lookup.ts
 * cachedSegmentSends). A bake HIT asked them only when the params changed
 * (storedEntrySends): between two routes with equal params, on a search-only
 * change, on a stale request and on a server action it kept the layout the
 * client held, the copy that marks the previous route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  createHandle,
  createRouter,
  Prerender,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import type { ResolvedSegment } from "../../types.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Where the pages come from. */
type Target = "live" | "cache" | "prerender";

const TARGETS: readonly Target[] = ["live", "cache", "prerender"];

/** The layout's rule: none, or a revalidate() that answers this. */
type Rule = "none" | boolean;

const RULES: readonly Rule[] = [true, false, "none"];

function page(
  push: (crumb: string) => void,
  name: string,
  id: string,
): React.ReactNode {
  push(`${name}-${id}`);
  return <article>{`${name} ${id} body`}</article>;
}

const getParams = async () => [{ id: "1" }];

const PrerenderedA = Prerender(getParams, (ctx) =>
  page(ctx.use(Crumbs), "a", ctx.params.id),
);
const PrerenderedB = Prerender(getParams, (ctx) =>
  page(ctx.use(Crumbs), "b", ctx.params.id),
);

const livePage =
  (name: string) =>
  (ctx: HandlerContext<{ id: string }>): React.ReactNode =>
    page(ctx.use(Crumbs), name, ctx.params.id);

function makeRouter(target: Target, rule: Rule) {
  return createRouter({}).routes(
    urls(({ path, cache, layout, revalidate }) => {
      const tree = () =>
        layout(
          (ctx: HandlerContext) => {
            ctx.use(Crumbs)("layout");
            return <nav>{`active:${ctx.routeName}`}</nav>;
          },
          () => [
            ...(rule === "none" ? [] : [revalidate(() => rule)]),
            target === "prerender"
              ? path("/a/:id", PrerenderedA, { name: "a" })
              : path("/a/:id", livePage("a"), { name: "a" }),
            target === "prerender"
              ? path("/b/:id", PrerenderedB, { name: "b" })
              : path("/b/:id", livePage("b"), { name: "b" }),
          ],
        );
      return target === "cache"
        ? [cache({ ttl: 600 }, () => [tree()])]
        : [tree()];
    }),
  );
}

interface Answer {
  segments: ResolvedSegment[];
  matched: string[];
}

async function answerOf(result: ServeShellRequestResult): Promise<Answer> {
  const { segments, matched } = (
    await deserializeResult<{ metadata: Answer }>(result.flight!)
  ).metadata;
  return { segments, matched };
}

/** The Crumbs values the response carries, by segment id. */
async function sentCrumbs(
  result: ServeShellRequestResult,
): Promise<Record<string, string[]>> {
  const handles = await result.readHandles();
  const data = (handles?.late.at(-1) ?? handles?.hydration ?? {}) as Record<
    string,
    Record<string, string[]>
  >;
  return data[Crumbs.$$id] ?? {};
}

/** The client-held navigation from `from` to `to`, with the params kept. */
interface Navigation {
  name: string;
  from: string;
  to: string;
  stale?: boolean;
  /** A server action called from `from`, which is also `to`. */
  action?: boolean;
  /** The route the layout marks on the page the navigation lands on. */
  active: string;
}

const NAVIGATIONS: readonly Navigation[] = [
  {
    name: "a route to another with equal params",
    from: "/a/1",
    to: "/b/1",
    active: "b",
  },
  {
    name: "a search-only change",
    from: "/a/1?tab=x",
    to: "/a/1?tab=y",
    active: "a",
  },
  {
    name: "a stale request for the same page",
    from: "/a/1",
    to: "/a/1",
    stale: true,
    active: "a",
  },
  {
    name: "a server action on the page",
    from: "/a/1",
    to: "/a/1",
    action: true,
    active: "a",
  },
];

async function save(): Promise<string> {
  return "saved";
}

const SAVE = "src/page.actions.ts#save";

/**
 * Navigate with the source page's segments held. Under cache() and over a
 * Prerender() the second request is the one compared: the first writes the
 * record or bakes the artifact.
 */
async function navigate(
  target: Target,
  rule: Rule,
  navigation: Navigation,
): Promise<{ result: ServeShellRequestResult; layoutId: string }> {
  const router = makeRouter(target, rule);
  const source = await serveShellRequest(router, navigation.from, {
    cacheStore: new MemorySegmentCacheStore(),
    partial: true,
  });
  const [layoutId] = Object.entries(await sentCrumbs(source)).find(
    ([, crumbs]) => crumbs.includes("layout"),
  )!;
  const cacheStore = new MemorySegmentCacheStore();
  const segments = (await answerOf(source)).matched;
  const serve = () =>
    serveShellRequest(
      router,
      navigation.to,
      navigation.action
        ? { cacheStore, action: { ref: save, id: SAVE, segments } }
        : {
            cacheStore,
            partial: {
              from: navigation.from,
              segments,
              stale: navigation.stale,
            },
          },
    );
  if (target !== "live") await serve();
  return { result: await serve(), layoutId };
}

/** Whether the response sends the layout segment. */
async function sendsLayout(
  result: ServeShellRequestResult,
  layoutId: string,
): Promise<boolean> {
  const { segments } = await answerOf(result);
  return (segments.find((s) => s.id === layoutId)?.component ?? null) !== null;
}

describe("a held layout's revalidate() is asked when the params do not change, from a Prerender() bake as live", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const navigation of NAVIGATIONS) {
    for (const rule of RULES) {
      const sends = rule === true;
      const ruleName =
        rule === "none" ? "no revalidate()" : `revalidate(() => ${rule})`;
      describe(`${navigation.name}, ${ruleName}`, () => {
        for (const target of TARGETS) {
          it(`${target}: ${sends ? "sends" : "keeps"} the layout`, async () => {
            const { result, layoutId } = await navigate(
              target,
              rule,
              navigation,
            );
            expect(await sendsLayout(result, layoutId)).toBe(sends);
            if (sends) {
              expect(result.flight).toContain(`active:${navigation.active}`);
              expect((await sentCrumbs(result))[layoutId]).toEqual(["layout"]);
            } else {
              expect(result.flight).not.toContain("active:");
              expect(await sentCrumbs(result)).not.toHaveProperty(layoutId);
            }
          });
        }
      });
    }
  }
});
