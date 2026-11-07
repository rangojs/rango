/**
 * An intercept or parallel slot handler's redirect() answers the request as a
 * route handler's does: returned or thrown, sync or async, with or without
 * loading() and loaders, on a document request, a client navigation, an
 * action's revalidation and an on-demand refresh.
 *
 * The rules, the route handler's: a redirect is the request's answer (a 302
 * for a document, 204 + X-RSC-Redirect for the rest), except from an async
 * handler under loading(), which streams into the 200 it already started. An
 * action awaits every handler before it answers, so its redirect is always
 * the action's answer.
 *
 * An intercept under loading() streamed an async handler on an action too, so
 * the action answered 200 with the Response in its payload. A parallel slot
 * did the same, and a redirect a slot handler returned (rather than threw)
 * was rendered as the slot's content on every request.
 */
import { describe, expect, it, vi } from "vitest";
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
  serveShellRequest,
  type ServeShellRequestOptions,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import {
  createLoader,
  createRouter,
  redirect,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";

/**
 * Where the handler runs: an intercept of /target opened from /page, a slot of
 * the layout both pages share, a slot of the /target route itself, or the
 * /target route handler (the reference).
 */
type Kind = "intercept" | "layout slot" | "route slot" | "route";
type Mode = "returned async" | "thrown async" | "returned sync" | "thrown sync";
type RequestKind = "document" | "navigation" | "action" | "refresh";

const KINDS: readonly Kind[] = [
  "intercept",
  "layout slot",
  "route slot",
  "route",
];
const MODES: readonly Mode[] = [
  "returned async",
  "thrown async",
  "returned sync",
  "thrown sync",
];

const SlotLoader = createLoader(async () => "slot data");

/**
 * Renders until `armed.on` or a `?go=1` request, then redirects to /elsewhere
 * as `mode` says.
 */
function redirectingHandler(mode: Mode, armed: { on: boolean; runs: number }) {
  return (ctx: HandlerContext): any => {
    if (!armed.on && ctx.url.searchParams.get("go") !== "1") {
      return <p>slot body</p>;
    }
    armed.runs++;
    if (mode === "returned sync") return redirect("/elsewhere");
    if (mode === "thrown sync") throw redirect("/elsewhere");
    return (async () => {
      await Promise.resolve();
      if (mode === "thrown async") throw redirect("/elsewhere");
      return redirect("/elsewhere");
    })();
  };
}

function makeRouter(
  kind: Kind,
  withLoading: boolean,
  withLoader: boolean,
  handler: (ctx: HandlerContext) => any,
  cached = false,
) {
  return createRouter({}).routes(
    urls(
      ({
        path,
        layout,
        intercept,
        parallel,
        loading,
        loader,
        revalidate,
        cache,
      }) => {
        const interceptUse = () => [
          ...(withLoading ? [loading(<i>loading</i>)] : []),
          ...(withLoader ? [loader(SlotLoader)] : []),
        ];
        // A held slot re-renders on every request, as the target does.
        const use = () => [...interceptUse(), revalidate(() => true)];
        const page = () => path("/page", () => <p>page</p>, { name: "page" });
        const target = () =>
          path("/target", () => <p>target</p>, { name: "target" });
        const children = () => {
          switch (kind) {
            case "intercept":
              return [
                page(),
                target(),
                intercept("@modal", ".target", handler, interceptUse),
              ];
            case "layout slot":
              return [parallel({ "@side": handler }, use), page(), target()];
            case "route slot":
              return [
                page(),
                path(
                  "/target",
                  () => <p>target</p>,
                  { name: "target" },
                  () => [parallel({ "@side": handler }, use)],
                ),
              ];
            case "route":
              return [
                page(),
                path("/target", handler, { name: "target" }, use),
              ];
          }
        };
        const tree = () => layout(() => <main>shell</main>, children);
        return cached ? [cache({ ttl: 600 }, () => [tree()])] : [tree()];
      },
    ),
  );
}

async function matchedOf(result: ServeShellRequestResult): Promise<string[]> {
  return (
    await deserializeResult<{ metadata: { matched: string[] } }>(result.flight!)
  ).metadata.matched;
}

async function touch(): Promise<string> {
  return "touched";
}
let actionSeq = 0;

interface Answer {
  status: number;
  location: string | null;
  xRedirect: string | null;
  /** Whether the redirecting handler ran for this request. */
  ran: boolean;
}

/**
 * Opens /target from /page (the intercept, for `intercept`), arms the handler,
 * then serves /target as each request kind the browser sends.
 */
async function answers(
  kind: Kind,
  withLoading: boolean,
  withLoader: boolean,
  mode: Mode,
): Promise<Record<RequestKind, Answer>> {
  const armed = { on: false, runs: 0 };
  const router = makeRouter(
    kind,
    withLoading,
    withLoader,
    redirectingHandler(mode, armed),
  );
  const cacheStore = new MemorySegmentCacheStore();
  const source =
    kind === "intercept" ? { interceptSource: "/page" } : undefined;
  const sourceHeader =
    kind === "intercept"
      ? { "X-RSC-Router-Intercept-Source": "/page" }
      : undefined;
  const pageSegments = await matchedOf(
    await serveShellRequest(router, "/page", { cacheStore, partial: true }),
  );
  const openSegments = await matchedOf(
    await serveShellRequest(router, "/target", {
      cacheStore,
      partial: { from: "/page", segments: pageSegments, ...source },
    }),
  );
  armed.on = true;

  const serve = async (
    request: () => Promise<ServeShellRequestResult>,
  ): Promise<Answer> => {
    armed.runs = 0;
    const { response } = await request();
    return {
      status: response.status,
      location: response.headers.get("location"),
      xRedirect: response.headers.get("X-RSC-Redirect"),
      ran: armed.runs > 0,
    };
  };
  return {
    document: await serve(() =>
      serveShellRequest(router, "/target", {
        cacheStore: new MemorySegmentCacheStore(),
      }),
    ),
    navigation: await serve(() =>
      serveShellRequest(router, "/target", {
        cacheStore: new MemorySegmentCacheStore(),
        partial: { from: "/page", segments: pageSegments, ...source },
      }),
    ),
    action: await serve(() =>
      serveShellRequest(router, "/target", {
        cacheStore,
        headers: sourceHeader,
        action: {
          ref: touch,
          id: `src/slot-redirect.actions.ts#touch${++actionSeq}`,
          segments: openSegments,
        },
      }),
    ),
    // useRouter().refresh(): nothing held, every segment rendered again.
    refresh: await serve(() =>
      serveShellRequest(router, "/target", {
        cacheStore,
        partial: { from: "/target", segments: [], stale: true, ...source },
      }),
    ),
  };
}

const REDIRECTED_DOCUMENT = {
  status: 302,
  location: "/elsewhere",
  xRedirect: "soft",
};
const REDIRECTED_PARTIAL = {
  status: 204,
  location: null,
  xRedirect: "http://localhost/elsewhere",
};
/** A 200 that renders (and, for a streamed handler, streams) the page. */
const RENDERED = { status: 200, location: null, xRedirect: null };

/** The route handler's rule (see the file comment). */
function expected(
  request: RequestKind,
  withLoading: boolean,
  mode: Mode,
): Omit<Answer, "ran"> {
  const streams = withLoading && mode.endsWith("async") && request !== "action";
  if (streams) return RENDERED;
  return request === "document" ? REDIRECTED_DOCUMENT : REDIRECTED_PARTIAL;
}

function expectRouteHandlerAnswers(
  kind: Kind,
  got: Record<RequestKind, Answer>,
  withLoading: boolean,
  mode: Mode,
): void {
  for (const request of Object.keys(got) as RequestKind[]) {
    const { ran, ...answer } = got[request];
    // An intercept never renders on a document request: the target page
    // answers it.
    if (kind === "intercept" && request === "document") {
      expect(ran, request).toBe(false);
      expect(answer, request).toEqual(RENDERED);
      continue;
    }
    expect(ran, `${request}: the handler ran`).toBe(true);
    expect(answer, request).toEqual(expected(request, withLoading, mode));
  }
}

describe("an intercept or parallel slot handler's redirect answers as a route handler's does", () => {
  for (const kind of KINDS) {
    for (const withLoading of [true, false]) {
      for (const withLoader of [false, true]) {
        for (const mode of MODES) {
          const title = `${kind}, ${withLoading ? "loading()" : "no loading()"}, ${withLoader ? "a loader" : "no loader"}, ${mode}`;
          it(title, async () => {
            expectRouteHandlerAnswers(
              kind,
              await answers(kind, withLoading, withLoader, mode),
              withLoading,
              mode,
            );
          });
        }
      }
    }
  }
});

// A redirect depends on the request, so cache() never stores it: the same
// request served twice on one store runs the handler and redirects both times.
describe("under cache(), a redirect is never stored", () => {
  for (const kind of KINDS) {
    for (const withLoading of [true, false]) {
      for (const mode of ["returned async", "returned sync"] as const) {
        it(`${kind}, ${withLoading ? "loading()" : "no loading()"}, ${mode}`, async () => {
          const armed = { on: false, runs: 0 };
          const router = makeRouter(
            kind,
            withLoading,
            false,
            redirectingHandler(mode, armed),
            true,
          );
          const cacheStore = new MemorySegmentCacheStore();
          const pageSegments = await matchedOf(
            await serveShellRequest(router, "/page", {
              cacheStore,
              partial: true,
            }),
          );
          const twice = async (
            partial?: ServeShellRequestOptions["partial"],
          ): Promise<Answer[]> => {
            const served: Answer[] = [];
            for (let i = 0; i < 2; i++) {
              armed.runs = 0;
              const { response } = await serveShellRequest(
                router,
                "/target?go=1",
                { cacheStore, partial },
              );
              served.push({
                status: response.status,
                location: response.headers.get("location"),
                xRedirect: response.headers.get("X-RSC-Redirect"),
                ran: armed.runs > 0,
              });
            }
            return served;
          };
          const got = {
            document: await twice(),
            navigation: await twice({
              from: "/page",
              segments: pageSegments,
              ...(kind === "intercept" ? { interceptSource: "/page" } : {}),
            }),
          };
          for (const request of ["document", "navigation"] as const) {
            const [first, second] = got[request];
            expect(second, `${request}, served again`).toEqual(first);
            expectRouteHandlerAnswers(
              kind,
              { [request]: first } as Record<RequestKind, Answer>,
              withLoading,
              mode,
            );
          }
        });
      }
    }
  }
});
