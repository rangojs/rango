/**
 * A Prerender() handler may return redirect() (its type allows a Response, as
 * a path() handler's does), but a build cannot bake a Response: the artifact
 * holds Flight segments only. Whatever part of the render answers with one (a
 * returned or thrown redirect, a layout inside the route, a streamed handler
 * under loading(), an async child) must reach the build as an Error that names
 * the URL and the redirect target, so prerender.onError decides (fail, or skip
 * under "warn") with a readable FAIL/WARN line and onError message. The thrown
 * Response itself has no message. Real Flight (the vendored
 * react-server-dom), since the async child and the streamed handler surface
 * only while the tree is encoded.
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
import { Static } from "../../static-handler.js";
import { redirect } from "../../route-definition/redirect.js";
import { hashParams } from "../../prerender/param-hash.js";
import { expandPrerenderRoutes } from "../../vite/discovery/prerender-collection.js";
import type { DiscoveryState } from "../../vite/discovery/state.js";

// Typed without casts: these pin that a Prerender() handler may return a
// Response, in both overloads, sync and async.
const Returned = Prerender(() => redirect("/moved"));
const ReturnedAsync = Prerender(
  async () => [{ slug: "old" }],
  async (ctx) => redirect(`/articles/${ctx.params.slug}-new`, 301),
);
const Thrown = Prerender((): never => {
  throw redirect("/moved");
});
const PlainResponse = Prerender(() => new Response("gone", { status: 410 }));
const Streamed = Prerender(async () => {
  await Promise.resolve();
  return redirect("/moved");
});
const WithChild = Prerender(() => (
  <div>
    page
    <Mover />
  </div>
));
const InnerLayout = Prerender(() => <div>page</div>);

async function Mover(): Promise<never> {
  await Promise.resolve();
  throw redirect("/moved");
}

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
}).routes(({ path, layout, loading }: any) => [
  layout(<div>shell</div>, () => [
    path("/returned", Returned, { name: "returned" }),
    path("/articles/:slug", ReturnedAsync, { name: "article" }),
    path("/thrown", Thrown, { name: "thrown" }),
    path("/plain-response", PlainResponse, { name: "plainResponse" }),
    path("/streamed", Streamed, { name: "streamed" }, () => [
      loading(<p>loading</p>),
    ]),
    path("/with-child", WithChild, { name: "withChild" }),
    path("/inner-layout", InnerLayout, { name: "innerLayout" }, () => [
      layout(() => redirect("/moved")),
    ]),
  ]),
]);

let consoleSpies: MockInstance[] = [];

beforeEach(() => {
  onErrorCalls.length = 0;
  consoleSpies = (["log", "warn", "error"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

describe("matchForPrerender: a render that answers with a Response", () => {
  const redirects = [
    ["a returned redirect", "/returned", "/moved (302)"],
    [
      "a returned redirect with a status",
      "/articles/old",
      "/articles/old-new (301)",
    ],
    ["a thrown redirect", "/thrown", "/moved (302)"],
    ["a streamed handler under loading()", "/streamed", "/moved (302)"],
    ["an async child that throws one", "/with-child", "/moved (302)"],
    ["a layout inside the route", "/inner-layout", "/moved (302)"],
  ] as const;

  for (const [label, pathname, target] of redirects) {
    it(`${label}: rejects with an Error naming the URL and the target`, async () => {
      const error = await rejection(router.matchForPrerender(pathname, {}));
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(
        `The prerender of ${pathname} redirected to ${target}.`,
      );
      expect(error.message).toContain("A build cannot store a redirect");
      expect(error.message).toContain("Passthrough()");
      expect(error.cause).toBeInstanceOf(Response);
    });
  }

  it("a Response that is not a redirect names its status", async () => {
    const error = await rejection(
      router.matchForPrerender("/plain-response", {}),
    );
    expect(error.message).toContain(
      "The prerender of /plain-response answered with a 410 Response.",
    );
    expect((error.cause as Response).status).toBe(410);
  });
});

describe("renderStaticSegment: a Static() handler that answers with a Response", () => {
  const ReturnsRedirect = Static(() => redirect("/moved") as never);
  const ThrowsRedirect = Static((): never => {
    throw redirect("/moved");
  });

  it("thrown: rejects with an Error naming the route and the target", async () => {
    const error = await rejection(
      router.renderStaticSegment(
        ThrowsRedirect.handler,
        "st#Mover",
        "docs.nav",
      ),
    );
    expect(error.message).toContain(
      'Static handler "docs.nav" redirected to /moved (302).',
    );
    expect(error.message).toContain("throw new Skip()");
    expect(error.cause).toBeInstanceOf(Response);
  });

  it("thrown, with no route name: names the handler id instead", async () => {
    const error = await rejection(
      router.renderStaticSegment(ThrowsRedirect.handler, "st#Mover"),
    );
    expect(error.message).toContain(
      'Static handler "st#Mover" redirected to /moved (302).',
    );
  });

  it("returned: keeps the existing TypeError", async () => {
    const error = await rejection(
      router.renderStaticSegment(
        ReturnsRedirect.handler,
        "st#Mover",
        "docs.nav",
      ),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toContain(
      'Static handler "docs.nav" returned a Response.',
    );
  });
});

describe("the build's prerender.onError policy reports the redirect", () => {
  async function build(
    routeName: string,
    pattern: string,
    prerenderOnError: "fail" | "warn",
  ): Promise<DiscoveryState> {
    const projectRoot = mkdtempSync(join(tmpdir(), "rango-redirect-"));
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

  const message =
    /^The prerender of \/returned redirected to \/moved \(302\)\./;

  it('"fail" (default) fails the build with an Error naming the redirect', async () => {
    const error = await rejection(build("returned", "/returned", "fail"));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(message);
    expect(onErrorCalls).toHaveLength(1);
    expect(onErrorCalls[0]!.message).toMatch(message);
    expect(onErrorCalls[0]!.phase).toBe("prerender");
    expect(onErrorCalls[0]!.meta).toBeUndefined();
    const failLine = (consoleSpies[2]!.mock.calls as unknown[][])
      .map((args) => String(args[0]))
      .find((line) => line.includes("FAIL"));
    expect(failLine).toMatch(/FAIL\s+\/returned .* redirected to \/moved/);
  });

  it('"warn" skips the URL, bakes nothing and reports the redirect', async () => {
    const state = await build("returned", "/returned", "warn");
    expect(state.prerenderManifestEntries).toBeUndefined();
    expect(onErrorCalls).toHaveLength(1);
    expect(onErrorCalls[0]!.message).toMatch(message);
    expect(onErrorCalls[0]!.meta).toEqual({ skipped: true });
  });
});
