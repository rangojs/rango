/**
 * A prefetch the browser shares between source pages renders the same on
 * every page that adopts it (#1331), through serveShellRequest and the
 * browser's prefetch cache and commit (helpers/prefetch-browser.ts).
 *
 * Segment ids are positional, so a page holds its own copy of an id another
 * page holds too. A partial answer keeps (omits) the segments the server
 * decided the client may keep, decided against the page that sent the
 * request. The browser stores a prefetch under one key for every source page
 * unless the response says `x-rsc-prefetch-scope: source` (that page only)
 * or `params; <label>` (the pages with equal values of what the kept rules
 * read of the source), and a page that adopts it renders ITS
 * copy of every kept id. A keep decided for page A and
 * applied on page B shows B's copy where B's own request would have sent a
 * new one: the category hero above the product page and /cart.
 *
 * The property: for pages A, B and a target T, if the prefetch of T made on
 * A is shared, the tree B builds from it is the tree B builds from its own
 * request. Enumerated over every (A, B, T) of the fixture
 * (fixtures/source-independence-router.tsx), with B loaded as a document,
 * with T in the tab's history (the click sends the entry's ids and commits
 * over it), and with B reached by a client navigation from any page of its
 * family (B may then hold copies a document load of its URL does not, and
 * may sit at A's URL, where it adopts A's source-scoped prefetch). One
 * difference is
 * allowed and counted: a segment A's answer sends that B's request keeps,
 * when it renders what T's own document renders for that id. B then shows
 * T's fresh render where its own request keeps B's copy, which a held
 * layout's contract leaves open.
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
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { isInterceptOnlyCache } from "../../browser/intercept-utils.js";
import { pageMatchesParamsLabel } from "../../browser/prefetch/cache.js";
import { paramsScopeLabel } from "../../prefetch-source-scope.js";
import type { ResolvedSegment } from "../../types.js";
import {
  adoptPrefetch,
  commitAnswer,
  createPrefetchBrowser,
  historyBase,
  loadScreen,
  renderedOf,
  renderedTree,
  request,
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

let cacheStore: MemorySegmentCacheStore;
const serve: Serve = (url, options) =>
  serveShellRequest(router, url, { cacheStore, ...options });

const PAGES = Object.values(SOURCE_INDEPENDENCE_URLS).flat();

/**
 * A cold store, then every page requested twice: the document GET bakes the
 * Prerender routes and fills cache()'s document entries, the partial request
 * holding nothing fills its partial ones. Every later request is a HIT, so
 * the entry a test reads does not depend on which tests ran before it.
 */
async function warm(): Promise<void> {
  await resetShellTestState();
  cacheStore = new MemorySegmentCacheStore();
  for (const page of PAGES) {
    await serve(page, {});
    await loadScreen(serve, page);
  }
}

const heroOf = async (segments: ResolvedSegment[]): Promise<string[]> =>
  (await renderedTree(segments))
    .map((line) => /hero:[a-z]+/.exec(line)?.[0])
    .filter((hero): hero is string => hero !== undefined);

afterEach(() => {
  vi.restoreAllMocks();
});

const VARIANTS = [
  ["the clientUrls() group", ""],
  ["prerendered server routes", "/baked"],
  ["cache() routes", "/cached"],
] as const;

describe("the #1331 report, as it showed on the live app", () => {
  beforeEach(warm);

  it.each(VARIANTS)(
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

  it.each(VARIANTS)(
    "%s: a product visited before, prefetched on search and clicked from a category page, shows no hero",
    async (_, base) => {
      const tab = createPrefetchBrowser(serve);
      await tab.load(`${base}/p1.html`);
      await tab.click(`${base}/search?text=kenwood`);
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
  const screens = new Map<string, Screen>();
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

  beforeEach(async () => {
    screens.clear();
    prefetches.clear();
    directs.clear();
    await warm();
    for (const page of PAGES) {
      screens.set(page, await loadScreen(serve, page));
    }
  });

  /** B as one of the property's axes builds it. */
  interface PageB {
    label: string;
    screen: Screen;
  }

  /**
   * Run the property over every (A, B, T), B from `pagesB`, T in the tab's
   * history when `fromHistory`. `sameSourceUrl` keeps the triples where B is
   * at A's URL: a document B is then A itself, a navigated B is the same URL
   * reached another way.
   */
  async function property(
    pagesB: readonly PageB[],
    fromHistory: boolean,
    sameSourceUrl = false,
  ): Promise<void> {
    // A prefetch holding an id the page lacks: the reconciler warns, and
    // the browser refetches (counted below).
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const counts = {
      triples: 0,
      sourceScoped: 0,
      refetched: 0,
      sourceAdopted: 0,
      paramsShared: 0,
      paramsMissed: 0,
      equal: 0,
      fresher: 0,
      different: 0,
    };
    const failing: string[] = [];
    /** The report leads with the smallest diffs: the readable ones. */
    const diffs: { size: number; text: string }[] = [];

    for (const target of PAGES) {
      const targetHref = screens.get(target)!.href;
      const own = new Map(
        await Promise.all(
          screens
            .get(target)!
            .segments.map(async (s) => [s.id, await renderedOf(s)] as const),
        ),
      );
      const entry = fromHistory ? screens.get(target)!.segments : undefined;
      for (const a of PAGES) {
        if (a === target) continue;
        const screenA = screens.get(a)!;
        const prefetched = (await memo(prefetches, `${a}\0${target}`, () =>
          requestFrom(serve, screenA, target, "prefetch"),
        ))!;
        for (const b of pagesB) {
          const screenB = b.screen;
          if (screenB.href === targetHref) continue;
          if (!sameSourceUrl && screenB.href === screenA.href) continue;
          counts.triples++;
          const triple = `(A ${a}, B ${b.label}, T ${target}${fromHistory ? ", T in history" : ""})`;
          const ids = entry ? entry.map((s) => s.id) : screenB.matched;
          resetPrefetchCache();
          storePrefetchOf(screenA, target, prefetched);
          const adopted = await adoptPrefetch(screenB, target, ids);
          const label = paramsScopeLabel(prefetched.scope);
          if (prefetched.scope === "source") {
            // A source-scoped answer is keyed by the source URL and the ids
            // its request sent: only a page at A's URL holding A's ids adopts
            // it, and that request is what B's own would send.
            const adoptable =
              screenB.href === screenA.href &&
              ids.join() === screenA.matched.join();
            expect(adopted === null, triple).toBe(!adoptable);
            if (!adopted) {
              counts.sourceScoped++;
              continue;
            }
            counts.sourceAdopted++;
          } else if (label !== undefined) {
            // A params-scoped answer is keyed by what the kept rules read of
            // A: every page with equal values adopts it, and the property
            // must then hold for it as for a shared one.
            const adoptable = pageMatchesParamsLabel(label, screenB.page!);
            expect(adopted === null, `${triple} [${label}]`).toBe(!adoptable);
            if (!adopted) {
              counts.paramsMissed++;
              continue;
            }
            counts.paramsShared++;
          } else {
            expect(adopted, triple).not.toBeNull();
          }
          const base = entry ? historyBase(entry, screenB.segments) : undefined;
          const fromPrefetch = commitAnswer(adopted!, screenB, base);
          if (fromPrefetch === "missing") {
            counts.refetched++;
            continue;
          }
          const direct = await memo(
            directs,
            `${b.label}\0${target}\0${fromHistory}`,
            async () =>
              (await request(serve, screenB.href, ids, target, "navigation"))!,
          );
          const fromDirect = commitAnswer(direct.answer, screenB, base);
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
          const held = new Set(base ?? screenB.segments);
          const fresher =
            sameShape &&
            fromPrefetch.every(
              (s, i) =>
                adoptedTree[i] === directTree[i] ||
                (!held.has(s) &&
                  held.has(fromDirect[i]!) &&
                  own.get(s.id) === adoptedTree[i]),
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
      `[source-independence] ${PAGES.length} pages, ${pagesB.length} B${fromHistory ? ", T in history" : ""}: ${JSON.stringify(counts)}\n`,
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
    // A params-scoped answer is shared by pages other than A, and refused by
    // pages outside its group: the property runs over both.
    expect(counts.paramsShared).toBeGreaterThan(0);
    expect(counts.paramsMissed).toBeGreaterThan(0);
    if (sameSourceUrl) expect(counts.sourceAdopted).toBeGreaterThan(0);
    // Refetched triples are skipped, not compared: a fixture change that
    // turns many keeps into missing ids would empty the property silently.
    expect(counts.refetched / counts.triples).toBeLessThan(0.05);
  }

  /**
   * What the property compares carries each feature the fixture declares:
   * loading() fallbacks, slots, loader data (renderedOf `data=`) and the
   * values middleware sets, in every family.
   */
  it("the fixture's pages render loading(), parallel slots, loader data and middleware vars in every family", async () => {
    const template = [
      "loading=<p>template-loading</p>",
      "parallel(@filters)",
      "loading=<p>filters-loading</p>",
      '"deal":"deal:speakers"',
      '"product":"product:p1:-"',
    ];
    const expected: Record<string, string[]> = {
      shop: template,
      baked: template,
      cached: [...template, '"product":"product:p1:x"'],
      field: [
        "loading=<p>plain-loading</p>",
        "loading=<p>dest-loading</p>",
        "parallel(@side)",
        '"band":"high"',
        "<section>section:x</section>",
        "<article>url:2:x:visit:2</article>",
      ],
      locale: ["<section>locale:en</section>", "<section>locale:fr</section>"],
    };
    for (const [family, urls] of Object.entries(SOURCE_INDEPENDENCE_URLS)) {
      const lines = (
        await Promise.all(
          urls.map((url) => renderedTree(screens.get(url)!.segments)),
        )
      ).flat();
      expect(
        expected[family]!.filter(
          (marker) => !lines.some((line) => line.includes(marker)),
        ),
        `${family}: markers no page renders`,
      ).toEqual([]);
    }
  });

  const documentPages = (): PageB[] =>
    PAGES.map((page) => ({ label: page, screen: screens.get(page)! }));

  it(
    "every (A, B, T): the prefetch of T made on A, adopted on B, renders as B's own navigation to T",
    () => property(documentPages(), false),
    120_000,
  );

  it(
    "every (A, B, T), T in the tab's history: the click sends the entry's ids and commits over it",
    () => property(documentPages(), true),
    120_000,
  );

  /** Every click between two pages of one family. */
  const navigations = (): [string, string][] =>
    Object.values(SOURCE_INDEPENDENCE_URLS).flatMap((urls) =>
      urls.flatMap((from) =>
        urls
          .filter((to) => to !== from)
          .map((to): [string, string] => [from, to]),
      ),
    );

  /**
   * B reached by a client navigation keeps the copies of the segments the
   * page it came from held, so it can differ from the document load of its
   * URL. A navigated B that renders and matches as that document load is the
   * document axis's B, and is left out: the property runs over the ones that
   * differ, which is where the axis can find what the document axis cannot.
   */
  it("every (A, B, T), B reached by a client navigation from another page of its family", async () => {
    const navigated: PageB[] = [];
    let clicks = 0;
    let intercepts = 0;
    for (const [from, to] of navigations()) {
      const tab = createPrefetchBrowser(serve);
      await tab.load(from);
      const { screen } = await tab.click(to);
      clicks++;
      // A click on an intercept screen sends interceptSourceUrl, which the
      // navigation client never serves a prefetch for (canUsePrefetch).
      if (isInterceptOnlyCache(screen.segments)) {
        intercepts++;
        continue;
      }
      const loaded = screens.get(to)!;
      const sameScreen =
        loaded.matched.join() === screen.matched.join() &&
        (await renderedTree(loaded.segments)).join("\n") ===
          (await renderedTree(screen.segments)).join("\n");
      if (!sameScreen) navigated.push({ label: `${from} -> ${to}`, screen });
    }
    process.stdout.write(
      `[source-independence] ${clicks} navigations: ${intercepts} intercept screens, ${navigated.length} B differing from the document load of their URL, ${clicks - intercepts - navigated.length} equal to it\n`,
    );
    expect(navigated.length).toBeGreaterThan(0);
    await property(navigated, false, true);
  }, 120_000);
});
