// A Prerender() route's intercept variant holds the slot of every intercept
// the build baked; a navigation that selects one it did not bake misses
// (selectInterceptVariant) and renders the intercept live, with the request
// and without BuildContext. matchForPrerender names those intercepts
// (`liveIntercepts`), and the build warns once per route and slot
// (warnLiveIntercepts, vite/utils/prerender-utils.ts).
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";

function pluginRscMock() {
  return {
    createFromReadableStream: vi.fn(),
    renderToReadableStream: vi.fn(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("BAKED"));
            controller.close();
          },
        }),
    ),
    loadServerAction: vi.fn(),
    decodeReply: vi.fn(),
    decodeAction: vi.fn(),
    decodeFormState: vi.fn(),
    createTemporaryReferenceSet: vi.fn(() => ({})),
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import { Prerender } from "../../prerender.js";
import { createRouter } from "../../router.js";
import { urls } from "../../urls/urls-function.js";
import { warnLiveIntercepts } from "../../vite/utils/prerender-utils.js";
import type { LiveIntercept } from "../prerender-match.js";

type BakeResult = {
  routeName: string;
  interceptSegments?: unknown[];
  liveIntercepts?: LiveIntercept[];
};

type InternalRouter = {
  matchForPrerender: (
    pathname: string,
    params: Record<string, string>,
  ) => Promise<BakeResult | null>;
};

const shop = urls(({ path }) => [
  path(
    "/item/:id",
    Prerender(
      async () => [{ id: "1" }, { id: "2" }],
      () => "item page",
    ),
    { name: "item" },
  ),
]);

const shell = (): string => "shell";
const modal = (): string => "modal body";
const redirect = (): Response => Response.redirect("http://prerender/", 302);

/**
 * The route is "shop.item", mounted under the layout that declares these
 * intercepts. "item" is its local name, which the match falls back to when
 * no intercept for "shop.item" applies (match-api.ts). Under an unnamed
 * include() its key is internal ("$prefix_0.item").
 */
type Shape =
  | "single"
  | "same slot"
  | "handler response"
  | "layout response"
  | "local name"
  | "local name, unnamed include"
  | "local name, full name behind when()"
  | "local name, full name without when()";

function makeRouter(shape: Shape): InternalRouter {
  return createRouter<Record<string, never>>({}).routes(
    urls(({ layout, intercept, include }) => [
      layout(shell, () => {
        const intercepts = {
          single: () => [intercept("@modal", "shop.item", modal)],
          "same slot": () => [
            intercept("@modal", "shop.item", modal, { when: () => true }),
            intercept("@modal", "shop.item", modal, { when: () => false }),
          ],
          "handler response": () => [
            intercept("@modal", "shop.item", redirect),
          ],
          "layout response": () => [
            intercept("@modal", "shop.item", modal, () => [layout(redirect)]),
          ],
          "local name": () => [intercept("@modal", "item", modal)],
          "local name, unnamed include": () => [
            intercept("@modal", "item", modal),
          ],
          "local name, full name behind when()": () => [
            intercept("@modal", "item", modal),
            intercept("@drawer", "shop.item", modal, { when: () => false }),
          ],
          "local name, full name without when()": () => [
            intercept("@modal", "item", modal),
            intercept("@drawer", "shop.item", modal),
          ],
        }[shape];
        return [
          shape === "local name, unnamed include"
            ? include("/shop", shop)
            : include("/shop", shop, { name: "shop" }),
          ...intercepts(),
        ];
      }),
    ]),
  ) as unknown as InternalRouter;
}

async function bake(shape: Shape, pathname: string): Promise<BakeResult> {
  const result = await makeRouter(shape).matchForPrerender(pathname, {});
  expect(result).not.toBeNull();
  return result!;
}

/** The build's warnings for these baked URLs, in order. */
function buildWarnings(
  baked: Array<[urlPath: string, result: BakeResult, routerId?: string]>,
): string[] {
  const warned = new Set<string>();
  for (const [urlPath, result, routerId = "router"] of baked) {
    warnLiveIntercepts(
      warned,
      routerId,
      result.routeName,
      urlPath,
      result.liveIntercepts,
    );
  }
  return warnSpy.mock.calls.map((call) => String(call[0]));
}

const LIVE =
  "A navigation that selects it renders it live, and its handler runs per request without BuildContext.";

let warnSpy: MockInstance<typeof console.warn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("a Prerender() route's intercepts the build does not bake", () => {
  test("a single intercept is baked, and the build does not warn", async () => {
    const result = await bake("single", "/shop/item/1");

    expect(result.interceptSegments).toHaveLength(1);
    expect(result.liveIntercepts).toEqual([]);
    expect(buildWarnings([["/shop/item/1", result]])).toEqual([]);
  });

  test("two intercepts that fill one slot: one warning for the slot", async () => {
    const result = await bake("same slot", "/shop/item/1");

    expect(result.interceptSegments).toBeUndefined();
    expect(result.liveIntercepts).toEqual([
      { slot: "@modal", reason: "same-slot" },
      { slot: "@modal", reason: "same-slot" },
    ]);
    expect(buildWarnings([["/shop/item/1", result]])).toEqual([
      `[rango] Prerender route "shop.item": intercept @modal is not pre-rendered: two intercepts on one layout fill @modal. ${LIVE}`,
    ]);
  });

  test("an intercept handler that returns a Response at build time", async () => {
    const result = await bake("handler response", "/shop/item/1");

    expect(result.interceptSegments).toBeUndefined();
    expect(result.liveIntercepts).toEqual([
      { slot: "@modal", reason: "handler-response" },
    ]);
    expect(buildWarnings([["/shop/item/1", result]])).toEqual([
      `[rango] Prerender route "shop.item": intercept @modal is not pre-rendered: its handler returned a Response for /shop/item/1. ${LIVE}`,
    ]);
  });

  test("an intercept layout that returns a Response at build time", async () => {
    const result = await bake("layout response", "/shop/item/1");

    expect(result.interceptSegments).toBeUndefined();
    expect(result.liveIntercepts).toEqual([
      { slot: "@modal", reason: "layout-response" },
    ]);
    expect(buildWarnings([["/shop/item/1", result]])).toEqual([
      `[rango] Prerender route "shop.item": intercept @modal is not pre-rendered: its layout returned a Response for /shop/item/1. ${LIVE}`,
    ]);
  });

  test("an intercept that targets the route by its local name", async () => {
    const result = await bake("local name", "/shop/item/1");

    expect(result.routeName).toBe("shop.item");
    expect(result.interceptSegments).toBeUndefined();
    expect(result.liveIntercepts).toEqual([
      { slot: "@modal", reason: "local-name" },
    ]);
    expect(buildWarnings([["/shop/item/1", result]])).toEqual([
      `[rango] Prerender route "shop.item": intercept @modal is not pre-rendered: it targets "item", the route's name inside its include(). ${LIVE}`,
    ]);
  });

  test("a route in an unnamed include(): the warning names its URL", async () => {
    const result = await bake("local name, unnamed include", "/shop/item/1");

    expect(result.routeName).toBe("$prefix_0.item");
    expect(result.interceptSegments).toBeUndefined();
    expect(result.liveIntercepts).toEqual([
      { slot: "@modal", reason: "local-name" },
    ]);
    expect(buildWarnings([["/shop/item/1", result]])).toEqual([
      `[rango] Prerender route "/shop/item/1": intercept @modal is not pre-rendered: it targets "item", the route's name inside its include(). ${LIVE}`,
    ]);
  });

  test("a local-name intercept warns while every full-name intercept has a when()", async () => {
    const result = await bake(
      "local name, full name behind when()",
      "/shop/item/1",
    );

    expect(result.interceptSegments).toHaveLength(1);
    expect(result.liveIntercepts).toEqual([
      { slot: "@modal", reason: "local-name" },
    ]);
  });

  test("a full-name intercept without when() always applies, so the local-name one is never selected", async () => {
    const result = await bake(
      "local name, full name without when()",
      "/shop/item/1",
    );

    expect(result.interceptSegments).toHaveLength(1);
    expect(result.liveIntercepts).toEqual([]);
    expect(buildWarnings([["/shop/item/1", result]])).toEqual([]);
  });

  test("the build warns once per router, route and slot across the route's URLs", async () => {
    const first = await bake("handler response", "/shop/item/1");
    const second = await bake("handler response", "/shop/item/2");
    const warning = `[rango] Prerender route "shop.item": intercept @modal is not pre-rendered: its handler returned a Response for /shop/item/1. ${LIVE}`;

    expect(second.liveIntercepts).toEqual(first.liveIntercepts);
    expect(
      buildWarnings([
        ["/shop/item/1", first, "a"],
        ["/shop/item/2", second, "a"],
        ["/shop/item/1", first, "b"],
      ]),
    ).toEqual([warning, warning]);
  });
});
