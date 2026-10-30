/**
 * A prefetch the browser shares between source pages renders the same on
 * every page that adopts it (#1331), through serveShellRequest and the
 * browser's own prefetch cache and reconcile step (helpers/prefetch-browser.ts).
 *
 * Segment ids are positional, so a page holds its own copy of an id another
 * page holds too. A partial answer keeps (omits) the segments the server
 * decided the client may keep, decided against the page that sent the
 * request. The browser stores a prefetch under one key for every source page
 * unless the response says `x-rsc-prefetch-scope: source`, and a page that
 * adopts it renders ITS copy of every kept id. A keep decided for page A and
 * applied on page B shows B's copy where B's own request would have sent a
 * new one: the category hero above the product page and /cart.
 *
 * The property: for pages A, B and a target T, if the prefetch of T made on
 * A is shared, the tree B builds from it is the tree B builds from its own
 * request. Enumerated over every (A, B, T) of the fixture
 * (fixtures/source-independence-router.tsx). One difference is allowed and
 * counted: a segment A's answer sends that B's request keeps. B then shows
 * the target's fresh render where its own request keeps B's copy, which is
 * what a held layout's contract leaves open, not a copy of another page.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import type { ResolvedSegment } from "../../types.js";
import {
  adoptPrefetch,
  applyAnswer,
  createPrefetchBrowser,
  loadScreen,
  renderedTree,
  requestFrom,
  resetPrefetchCache,
  storePrefetchOf,
  type Fetched,
  type Screen,
  type Serve,
} from "./helpers/prefetch-browser.js";
import {
  SOURCE_INDEPENDENCE_URLS,
  sourceIndependenceRouter as router,
} from "./fixtures/source-independence-router.js";

const cacheStore = new MemorySegmentCacheStore();
const serve: Serve = (url, options) =>
  serveShellRequest(router, url, { cacheStore, ...options });

const PAGES = Object.values(SOURCE_INDEPENDENCE_URLS).flat();

/** A document GET of every page: bakes the Prerender routes, fills cache(). */
async function warm(): Promise<void> {
  for (const page of PAGES) await serve(page, {});
}

const heroOf = async (segments: ResolvedSegment[]): Promise<string[]> =>
  (await renderedTree(segments))
    .map((line) => /hero:[a-z]+/.exec(line)?.[0])
    .filter((hero): hero is string => hero !== undefined);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the #1331 report, as it showed on the live app", () => {
  beforeAll(async () => {
    await resetShellTestState();
    await warm();
  });

  it.each([
    ["the clientUrls() group", ""],
    ["prerendered server routes", "/baked"],
    ["cache() routes", "/cached"],
  ])(
    "%s: a product prefetched on search and clicked from a category page shows no hero, nor does /cart after it",
    async (_, base) => {
      const tab = createPrefetchBrowser(serve);
      await tab.load(`${base}/search?text=kenwood`);
      await tab.prefetch(`${base}/p1.html`);

      const category = await tab.click(`${base}/c/speakers`);
      const product = await tab.click(`${base}/p1.html`);
      const productHeroes = await heroOf(product.screen.segments);
      const cart = await tab.click(`${base}/cart`);
      expect({
        category: await heroOf(category.screen.segments),
        product: productHeroes,
        cart: await heroOf(cart.screen.segments),
      }).toEqual({
        category: ["hero:speakers"],
        product: [],
        cart: [],
      });
    },
  );
});

/**
 * What the adopted prefetch built against what B's own request built: each
 * differing segment, or both trees when their shapes differ.
 */
function describeDiff(
  adopted: string[],
  direct: string[],
  origins: string[],
): string {
  if (adopted.length !== direct.length) {
    return [
      "  adopted:",
      ...adopted.map((line, i) => `    (${origins[i]}) ${line}`),
      "  B's own navigation:",
      ...direct.map((line) => `    ${line}`),
    ].join("\n");
  }
  const lines: string[] = [];
  adopted.forEach((line, i) => {
    if (line === direct[i]) return;
    lines.push(
      `  adopted (${origins[i]}): ${line}`,
      `  B's own navigation: ${direct[i]}`,
    );
  });
  return lines.join("\n");
}

describe("a shared prefetch renders the same on every source page", () => {
  it("every (A, B, T): the prefetch of T made on A, adopted on B, renders as B's own navigation to T", async () => {
    await resetShellTestState();
    await warm();
    // A prefetch holding an id the page lacks: the reconciler warns, and
    // the browser refetches (counted below).
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const screens = new Map<string, Screen>();
    for (const page of PAGES) {
      screens.set(page, await loadScreen(serve, page));
    }
    const prefetches = new Map<string, Fetched | undefined>();
    const directs = new Map<string, Fetched>();
    const memo = async <T,>(
      map: Map<string, T>,
      key: string,
      make: () => Promise<T>,
    ): Promise<T> => {
      if (!map.has(key)) map.set(key, await make());
      return map.get(key)!;
    };

    const counts = {
      triples: 0,
      sourceScoped: 0,
      refetched: 0,
      equal: 0,
      fresher: 0,
      different: 0,
    };
    const failing: string[] = [];
    /** The report leads with the smallest diffs: the readable ones. */
    const diffs: { size: number; text: string }[] = [];

    for (const target of PAGES) {
      for (const a of PAGES) {
        if (a === target) continue;
        const screenA = screens.get(a)!;
        const prefetched = (await memo(prefetches, `${a}\0${target}`, () =>
          requestFrom(serve, screenA, target, "prefetch"),
        ))!;
        for (const b of PAGES) {
          if (b === a || b === target) continue;
          counts.triples++;
          const triple = `(A ${a}, B ${b}, T ${target})`;
          const screenB = screens.get(b)!;
          resetPrefetchCache();
          storePrefetchOf(screenA, target, prefetched);
          const adopted = await adoptPrefetch(screenB, target);
          if (prefetched.scope === "source") {
            // The cache never hands a source-scoped answer to another page.
            expect(adopted, triple).toBeNull();
            counts.sourceScoped++;
            continue;
          }
          expect(adopted, triple).not.toBeNull();
          const fromPrefetch = applyAnswer(adopted!, screenB);
          if (fromPrefetch === "missing") {
            counts.refetched++;
            continue;
          }
          const direct = await memo(
            directs,
            `${b}\0${target}`,
            async () =>
              (await requestFrom(serve, screenB, target, "navigation"))!,
          );
          const fromDirect = applyAnswer(direct.answer, screenB);
          expect(fromDirect, `${triple}: B's own answer`).not.toBe("missing");
          if (fromDirect === "missing") continue;
          const adoptedTree = await renderedTree(fromPrefetch);
          const directTree = await renderedTree(fromDirect);
          const sameShape = adoptedTree.length === directTree.length;
          if (sameShape && adoptedTree.every((l, i) => l === directTree[i])) {
            counts.equal++;
            continue;
          }
          // Where each adopted segment came from: B's copy, or A's answer.
          const held = new Set(screenB.segments);
          const fresher =
            sameShape &&
            fromPrefetch.every(
              (s, i) =>
                adoptedTree[i] === directTree[i] ||
                (!held.has(s) && held.has(fromDirect[i]!)),
            );
          if (fresher) {
            counts.fresher++;
            continue;
          }
          counts.different++;
          failing.push(triple);
          const origins = fromPrefetch.map((s) =>
            held.has(s) ? "B's copy" : "A's answer",
          );
          const text = describeDiff(adoptedTree, directTree, origins);
          diffs.push({
            size: text.split("\n").length,
            text: `${triple}\n${text}`,
          });
        }
      }
    }

    process.stdout.write(
      `[source-independence] ${PAGES.length} pages: ${JSON.stringify(counts)}\n`,
    );
    const report = diffs
      .sort((x, y) => x.size - y.size)
      .slice(0, 3)
      .map((d) => d.text)
      .join("\n\n");
    expect(
      failing,
      `${failing.length} triple(s) render differently from B's own navigation to T. Smallest:\n\n${report}\n\nAll:`,
    ).toEqual([]);
    expect(counts.equal).toBeGreaterThan(0);
    expect(counts.sourceScoped).toBeGreaterThan(0);
  }, 60_000);
});
