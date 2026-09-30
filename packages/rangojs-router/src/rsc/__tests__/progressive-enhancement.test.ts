import { describe, it, expect, vi } from "vitest";
import { handleProgressiveEnhancement } from "../progressive-enhancement.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";
import type { HandlerContext } from "../handler-context.js";
import type { ResolvedSegment } from "../../types/segments.js";

// C1: a no-JS (PE) action that throws with NO matching error boundary must
// re-render with HTTP 500, matching the JS path (server-action.ts sets
// actionStatus=500 for the same boundaryless error). Before the fix the PE
// re-render fell through with the default 200.
//
// The boundaryless fall-through is reached only when router.matchError returns
// null (no boundary resolved). This white-box test stubs the handler context so
// matchError returns null, then asserts the re-rendered HTML response status.

const ACTION_ID = "action-1";

function buildDirectActionRequest(): Request {
  // React PE direct-action form: a multipart body carrying the $ACTION_ID_<id>
  // hidden field plus a normal field. classifyRequest treats this as a no-JS
  // form POST (content-type multipart/form-data), so handleProgressiveEnhancement
  // takes the isDirectAction branch.
  const fd = new FormData();
  fd.set(`$ACTION_ID_${ACTION_ID}`, "");
  fd.set("name", "no-js");
  return new Request("http://localhost/pe", {
    method: "POST",
    body: fd,
  });
}

function buildMalformedFormRequest(): Request {
  return new Request("http://localhost/pe", {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=missing",
    },
    body: "not-a-valid-multipart-body",
  });
}

function makeReqCtx(request: Request) {
  return createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  });
}

function makeTransitionBoundaryResult(): unknown {
  const segment = {
    id: "pe-error-seg",
    namespace: "r",
    type: "error",
    index: 0,
    component: null,
    transition: { enter: "fade" },
  } as ResolvedSegment;
  return {
    segments: [segment],
    matched: [],
    diff: [],
    resolvedIds: [],
    params: {},
    routeName: "pe.error",
  };
}

/** Record a transition({ when }) reference for the error segment, as a match does. */
function seedTransitionWhen(reqCtx: ReturnType<typeof makeReqCtx>) {
  const when = vi.fn(() => true);
  reqCtx._transitionWhenRefs = new Map([
    ["pe-error-seg", { when, site: { routeName: "pe.error" } }],
  ]);
  return when;
}

interface StubCtxOptions {
  actionThrows: boolean;
  matchErrorResult: unknown;
  // Captures the Request passed to router.match during the PE re-render.
  onMatch?: (request: Request) => void;
}

function makeStubCtx(opts: StubCtxOptions): HandlerContext<unknown> {
  const ssrModule = {
    renderHTML: vi.fn(async () => new ReadableStream()),
  };
  return {
    version: "v-test",
    router: {
      id: "test-router",
      basename: undefined,
      rootLayout: undefined,
      resolvedStateCookieName: "rango-state",
      themeConfig: undefined,
      warmupEnabled: false,
      async match(request: Request) {
        opts.onMatch?.(request);
        return {
          redirect: undefined,
          segments: [],
          matched: [],
          diff: [],
          resolvedIds: [],
          params: {},
        };
      },
      async matchError() {
        return opts.matchErrorResult;
      },
    },
    callOnError: vi.fn(),
    createTemporaryReferenceSet: () => ({}),
    // decodeReply throws so the PE direct-action path uses [formData] as args.
    decodeReply: () => {
      throw new Error("no encoded args (raw form POST)");
    },
    async loadServerAction() {
      return () => {
        if (opts.actionThrows) {
          throw new Error("PE action boom");
        }
      };
    },
    decodeFormState: async () => null,
    renderToReadableStream: () => new ReadableStream(),
    loadSSRModule: async () => ssrModule,
    resolveStreamMode: async () => "stream",
  } as unknown as HandlerContext<unknown>;
}

describe("handleProgressiveEnhancement — boundaryless action error status (C1)", () => {
  it("re-renders with HTTP 500 when the action throws and no error boundary matches", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = buildDirectActionRequest();
    const reqCtx = makeReqCtx(request);
    const ctx = makeStubCtx({ actionThrows: true, matchErrorResult: null });

    const res = await runWithRequestContext(reqCtx, () =>
      handleProgressiveEnhancement(
        ctx,
        request,
        {},
        new URL(request.url),
        false,
        reqCtx._handleStore,
        undefined,
      ),
    );

    expect(res).not.toBeNull();
    // The boundaryless re-render must carry 500, matching the JS path.
    expect(res!.status).toBe(500);
    expect(res!.headers.get("content-type")).toContain("text/html");
    errSpy.mockRestore();
  });

  it("re-renders with HTTP 200 when the same action succeeds (no status override)", async () => {
    // Parity guard: the 500 must apply ONLY to the boundaryless-error path. A
    // successful action's re-render keeps the default 200.
    const request = buildDirectActionRequest();
    const reqCtx = makeReqCtx(request);
    const ctx = makeStubCtx({ actionThrows: false, matchErrorResult: null });

    const res = await runWithRequestContext(reqCtx, () =>
      handleProgressiveEnhancement(
        ctx,
        request,
        {},
        new URL(request.url),
        false,
        reqCtx._handleStore,
        undefined,
      ),
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("text/html");
  });
});

// F12: the PE re-render request must preserve the original POST request's
// headers (Authorization, Cookie, custom headers) so loaders that read request
// headers/cookies behave identically under PE and the JS action path. It must
// also drop body-framing headers (content-type, content-length) and force a
// bodyless GET so match() treats it as a non-form GET, not another form POST.
function buildDirectActionRequestWithHeaders(): Request {
  const fd = new FormData();
  fd.set(`$ACTION_ID_${ACTION_ID}`, "");
  fd.set("name", "no-js");
  return new Request("http://localhost/pe", {
    method: "POST",
    headers: {
      authorization: "Bearer secret-token",
      cookie: "session=abc123",
      "x-custom-header": "custom-value",
    },
    body: fd,
  });
}

describe("handleProgressiveEnhancement — PE re-render preserves request headers (F12)", () => {
  it("preserves auth/cookie/custom headers and drops body-framing headers on the GET re-render", async () => {
    const request = buildDirectActionRequestWithHeaders();
    const reqCtx = makeReqCtx(request);

    let renderRequest: Request | undefined;
    const ctx = makeStubCtx({
      actionThrows: false,
      matchErrorResult: null,
      onMatch: (req) => {
        renderRequest = req;
      },
    });

    const res = await runWithRequestContext(reqCtx, () =>
      handleProgressiveEnhancement(
        ctx,
        request,
        {},
        new URL(request.url),
        false,
        reqCtx._handleStore,
        undefined,
      ),
    );

    expect(res).not.toBeNull();
    expect(renderRequest).toBeDefined();

    // Auth/cookie/custom headers carried over from the original POST.
    expect(renderRequest!.headers.get("authorization")).toBe(
      "Bearer secret-token",
    );
    expect(renderRequest!.headers.get("cookie")).toBe("session=abc123");
    expect(renderRequest!.headers.get("x-custom-header")).toBe("custom-value");

    // Body-framing headers dropped for the bodyless GET.
    expect(renderRequest!.headers.get("content-type")).toBeNull();
    expect(renderRequest!.headers.get("content-length")).toBeNull();

    // Re-render request is a non-form GET; accept forces the HTML path.
    expect(renderRequest!.method).toBe("GET");
    expect(renderRequest!.headers.get("accept")).toBe("text/html");
  });
});

describe("handleProgressiveEnhancement — transition({ when }) never runs on the server", () => {
  // A no-JS action has no browser commit to decide: the predicate is carried
  // (SSR strips it from <ViewTransition>) and never called.
  it.each([
    ["a malformed form that fails before action detection", false],
    ["a known PE action that renders an error boundary", true],
  ])("%s", async (_label, actionThrows) => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = actionThrows
      ? buildDirectActionRequest()
      : buildMalformedFormRequest();
    const reqCtx = makeReqCtx(request);
    const when = seedTransitionWhen(reqCtx);
    const ctx = makeStubCtx({
      actionThrows,
      matchErrorResult: makeTransitionBoundaryResult(),
    });

    const res = await runWithRequestContext(reqCtx, () =>
      handleProgressiveEnhancement(
        ctx,
        request,
        {},
        new URL(request.url),
        false,
        reqCtx._handleStore,
        undefined,
      ),
    );

    expect(res).not.toBeNull();
    expect(when).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
