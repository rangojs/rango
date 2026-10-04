/**
 * A Prerender route whose handler resolves but whose tree holds an async
 * server component that throws is never baked as a Flight error row (#914).
 *
 * The handler returns an element, so #587's throwOnError never fires: the
 * throw happens later, while serializeSegments encodes the tree. Flight
 * reports it through onError and completes normally with an error row
 * (`1:E{"digest":""}`); baked, the route would serve the error boundary until
 * the next build. The encode error must take the handler-throw path instead:
 * matchForPrerender / renderStaticSegment reject with it, and the build
 * loop's prerender.onError policy decides. Real Flight (the vendored
 * react-server-dom), since the mocked codec in prerender-render-error.test.tsx
 * never renders components.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@vitejs/plugin-rsc/rsc/server", async () => {
  const RSD =
    await import("@vitejs/plugin-rsc/vendor/react-server-dom/server.edge");
  // Resolves any "use client" reference (the router's implicit layouts render
  // the client Outlet): `$$id` is `${id}#${name}`.
  const clientManifest = new Proxy(
    {},
    {
      get: (_target, key) =>
        typeof key === "string"
          ? { id: key.split("#")[0], chunks: [], name: key.split("#")[1] }
          : undefined,
    },
  );
  return {
    // The vendored implementation (not in its ambient declaration).
    createTemporaryReferenceSet: () => new WeakMap(),
    renderToReadableStream: (value: unknown, options?: object) =>
      RSD.renderToReadableStream(value, clientManifest, options),
  };
});
vi.mock("@vitejs/plugin-rsc/rsc/client", async () => {
  await import("../../testing/internal/flight-client-globals.js");
  const { createFromReadableStream } =
    await import("@vitejs/plugin-rsc/react/browser");
  return {
    createFromReadableStream: (stream: ReadableStream<Uint8Array>) =>
      createFromReadableStream(stream),
  };
});

import { createRouter } from "../../router.js";
import { Prerender } from "../../prerender.js";
import { createHandle } from "../../handle.js";
import { Skip } from "../../errors.js";
import { hashParams } from "../../prerender/param-hash.js";
import { expandPrerenderRoutes } from "../../vite/discovery/prerender-collection.js";
import type { DiscoveryState } from "../../vite/discovery/state.js";

let failReviews = false;
let skipReviews = false;

async function Reviews() {
  await Promise.resolve();
  if (skipReviews) throw new Skip("reviews are build-time only");
  if (failReviews) throw new Error("reviews upstream down");
  return <p>reviews</p>;
}

const Crumbs = createHandle<unknown>(undefined, "test#Crumbs");

const onErrorCalls: Array<{ message: string; phase: string; meta: unknown }> =
  [];

const router: any = createRouter<Record<string, never>>({
  onError: (ctx: any) => {
    onErrorCalls.push({
      message: ctx.error.message,
      phase: ctx.phase,
      meta: ctx.metadata,
    });
  },
}).routes(({ path, layout, intercept }: any) => [
  layout(<div>shell</div>, () => [
    path(
      "/product",
      Prerender(() => (
        <div>
          product
          <Reviews />
        </div>
      )),
      { name: "product" },
    ),
    path(
      "/handler-throws",
      Prerender(() => {
        throw new Error("handler failed");
      }),
      { name: "handlerThrows" },
    ),
    path(
      "/crumb",
      Prerender((ctx: any) => {
        ctx.use(Crumbs)(<Reviews />);
        return <div>crumb</div>;
      }),
      { name: "crumb" },
    ),
    path(
      "/photo",
      Prerender(() => <div>photo</div>),
      { name: "photo" },
    ),
    intercept("@modal", "photo", () => (
      <div>
        modal
        <Reviews />
      </div>
    )),
  ]),
]);

function errorRows(segments: Array<{ encoded: string }>): string[] {
  return segments.flatMap((s) => s.encoded.match(/^\d+:E.*$/gm) ?? []);
}

let consoleSpies: MockInstance[] = [];

beforeEach(() => {
  failReviews = false;
  skipReviews = false;
  onErrorCalls.length = 0;
  consoleSpies = (["log", "warn", "error"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

describe("matchForPrerender: an async child that throws during the encode", () => {
  it("control: a healthy tree bakes with no error rows", async () => {
    const result = await router.matchForPrerender("/product", {});
    expect(result.routeName).toBe("product");
    expect(errorRows(result.segments)).toEqual([]);
  });

  it("rejects with the child's error instead of baking an error row", async () => {
    failReviews = true;
    await expect(router.matchForPrerender("/product", {})).rejects.toThrow(
      "reviews upstream down",
    );
  });

  it("a Skip thrown by the child propagates as a Skip (the URL is skipped)", async () => {
    skipReviews = true;
    await expect(
      router.matchForPrerender("/product", {}),
    ).rejects.toBeInstanceOf(Skip);
  });

  it("an intercept whose tree throws rejects the whole entry", async () => {
    const healthy = await router.matchForPrerender("/photo", {});
    expect(healthy.interceptSegments).toHaveLength(1);
    expect(errorRows(healthy.interceptSegments)).toEqual([]);

    failReviews = true;
    await expect(router.matchForPrerender("/photo", {})).rejects.toThrow(
      "reviews upstream down",
    );
  });

  it("a handle value whose tree throws rejects instead of baking it", async () => {
    const healthy = await router.matchForPrerender("/crumb", {});
    expect(healthy.handles).not.toBe("");
    expect(healthy.handles).not.toMatch(/^\d+:E/m);

    failReviews = true;
    await expect(router.matchForPrerender("/crumb", {})).rejects.toThrow(
      "reviews upstream down",
    );
  });
});

describe("renderStaticSegment: an async child that throws during the encode", () => {
  const handler = () => (
    <div>
      static
      <Reviews />
    </div>
  );

  it("control: a healthy tree encodes with no error rows", async () => {
    const result = await router.renderStaticSegment(handler, "st#Reviews");
    expect(errorRows([result])).toEqual([]);
  });

  it("rejects with the child's error", async () => {
    failReviews = true;
    await expect(
      router.renderStaticSegment(handler, "st#Reviews"),
    ).rejects.toThrow("reviews upstream down");
  });
});

describe("the build's prerender.onError policy treats it like a handler throw", () => {
  async function build(
    routeName: string,
    pattern: string,
    prerenderOnError: "fail" | "warn",
  ): Promise<DiscoveryState> {
    const projectRoot = mkdtempSync(join(tmpdir(), "rango-914-"));
    const state = {
      opts: { enableBuildPrerender: true, prerenderOnError },
      isBuildMode: true,
      projectRoot,
    } as unknown as DiscoveryState;
    try {
      await expandPrerenderRoutes(
        state,
        { runner: { import: async () => ({ hashParams }) } },
        new Map([[router.id, router]]),
        [
          {
            id: router.id,
            manifest: {
              prerenderRoutes: [routeName],
              routeManifest: { [routeName]: pattern },
            },
          },
        ],
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
    return state;
  }

  const cases = [
    ["handler throw", "handlerThrows", "/handler-throws", "handler failed"],
    ["async child throw", "product", "/product", "reviews upstream down"],
  ] as const;

  for (const [label, routeName, pattern, message] of cases) {
    it(`${label}: "fail" (default) fails the build with the original error`, async () => {
      failReviews = true;
      await expect(build(routeName, pattern, "fail")).rejects.toThrow(message);
      expect(onErrorCalls).toEqual([
        { message, phase: "prerender", meta: undefined },
      ]);
    });

    it(`${label}: "warn" skips the URL and bakes nothing`, async () => {
      failReviews = true;
      const state = await build(routeName, pattern, "warn");
      expect(state.prerenderManifestEntries).toBeUndefined();
      expect(onErrorCalls).toEqual([
        { message, phase: "prerender", meta: { skipped: true } },
      ]);
    });
  }
});
