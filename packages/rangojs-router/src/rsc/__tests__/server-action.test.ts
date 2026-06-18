import { describe, it, expect } from "vitest";
import {
  executeServerAction,
  revalidateAfterAction,
  type ActionContinuation,
} from "../server-action.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";

// D1: a JS-path action argument-decode failure (truncated/oversized/malformed
// Flight body, or garbage posted to ?_rsc_action=...) must produce a
// router-controlled response — a route error boundary when one matches, else an
// explicit 400 — NOT an opaque host 500 from re-throwing. This mirrors the no-JS
// PE path (progressive-enhancement.ts) so JS and no-JS converge. The original
// decode error must never leak to the client-facing response.
describe("executeServerAction — decode failure is router-controlled (D1)", () => {
  // Stub whose decodeReply throws. matchError is configurable so the test can
  // exercise both the no-boundary (plain 400) and matched-boundary (deferred
  // continuation) branches. callOnError records the reported error.
  function ctxThatFailsDecode(
    detail: string,
    matchError: () => Promise<unknown>,
    onError?: (err: unknown, phase: string, info: any) => void,
  ) {
    return {
      createTemporaryReferenceSet: () => ({}),
      decodeReply: () => {
        throw new Error(detail);
      },
      callOnError: onError ?? (() => {}),
      router: { id: "test", matchError },
    } as any;
  }

  function decodeFailRequest(): Request {
    return new Request("http://localhost/?_rsc_action=a1", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "non-empty-body",
    });
  }

  it("returns an explicit 400 (no throw, no leak) when no error boundary matches", async () => {
    const SECRET = "SECRET internal decode detail";
    const request = decodeFailRequest();
    const reported: { err: unknown; info: any }[] = [];

    const result = await executeServerAction(
      ctxThatFailsDecode(
        SECRET,
        async () => null,
        (err, _phase, info) => reported.push({ err, info }),
      ),
      request,
      {} as any,
      new URL(request.url),
      "a1",
      {} as any,
    );

    // Router-controlled response, NOT a thrown error.
    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(400);
    // No decode internals leak into the client-facing body.
    const body = await res.text();
    expect(body).not.toContain(SECRET);
    // onError still fired with the sanitized error (cause preserved) as unhandled.
    expect(reported).toHaveLength(1);
    expect(reported[0]!.err).toBeInstanceOf(Error);
    expect((reported[0]!.err as Error).message).toBe(
      "Failed to decode action arguments",
    );
    expect((reported[0]!.err as Error).message).not.toContain(SECRET);
    expect(((reported[0]!.err as Error).cause as Error).message).toBe(SECRET);
    expect(reported[0]!.info.handledByBoundary).toBe(false);
  });

  it("defers to an errorBoundary continuation (status 400) when a boundary matches", async () => {
    const SECRET = "SECRET internal decode detail";
    const request = decodeFailRequest();
    const ERROR_MATCH = {
      segments: [],
      matched: ["err"],
      diff: ["err"],
      resolvedIds: ["err"],
      params: {},
      routeName: "boom",
    };

    const result = await executeServerAction(
      ctxThatFailsDecode(SECRET, async () => ERROR_MATCH),
      request,
      {} as any,
      new URL(request.url),
      "a1",
      {} as any,
    );

    // The boundary render is deferred under route middleware, exactly like the
    // action-threw path — so the result is a continuation, not a Response.
    expect(result).not.toBeInstanceOf(Response);
    const cont = result as ActionContinuation;
    expect(cont.errorBoundary).toBe(ERROR_MATCH);
    // Decode failure is a bad request -> 400 (action runtime errors use 500).
    expect(cont.actionStatus).toBe(400);
    expect(cont.returnValue.ok).toBe(false);
    // The continuation carries the sanitized error, not the raw decode detail.
    expect((cont.returnValue.data as Error).message).toBe(
      "Failed to decode action arguments",
    );
    expect(JSON.stringify(cont.actionContext.actionResult)).not.toContain(
      SECRET,
    );
  });
});

// C2: shouldRevalidate({ formData }) must receive the action's FormData for a JS
// server action, matching the PE path. A form-driven JS action is invoked as
// action(formData) (direct) or action(prevState, formData) (useActionState), so
// the FormData arrives inside the decoded args. executeServerAction must surface
// the FIRST FormData arg as continuation.actionContext.formData (which feeds
// shouldRevalidate via revalidation.ts) — NOT the raw multipart request body,
// whose keys are Flight-encoded (e.g. `_1_name`).
describe("executeServerAction — formData surfaced to shouldRevalidate (C2)", () => {
  // Verified (react-server-dom round-trip): encodeReply wraps a FormData arg in a
  // multipart envelope, and decodeReply returns args containing the original
  // FormData. The stub returns the decoded args directly so the test pins the
  // surfacing logic, not React's codec.
  function ctxWithDecodedArgs(args: unknown[]) {
    return {
      createTemporaryReferenceSet: () => ({}),
      decodeReply: () => args,
      loadServerAction: async () => async () => undefined,
      callOnError: () => {},
      router: { id: "test" },
    } as any;
  }

  function actionRequest(): Request {
    // Non-empty body so hasBodyContent() is true and decodeReply runs. The exact
    // bytes are irrelevant — decodeReply is stubbed to return our chosen args.
    return new Request("http://localhost/page?_rsc_action=a1", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "encoded-args",
    });
  }

  it("surfaces the FormData for a direct action invoked as action(formData)", async () => {
    const fd = new FormData();
    fd.set("name", "alice");
    const request = actionRequest();

    const result = await executeServerAction(
      ctxWithDecodedArgs([fd]),
      request,
      {} as any,
      new URL(request.url),
      "a1",
      {} as any,
    );

    // Success path returns the continuation (not a Response).
    expect(result).not.toBeInstanceOf(Response);
    const cont = result as ActionContinuation;
    expect(cont.actionContext.formData).toBe(fd);
    // The clean consumer key is present — proving it is NOT the Flight-encoded
    // multipart envelope (which would carry `_1_name`, not `name`).
    expect(cont.actionContext.formData?.get("name")).toBe("alice");
  });

  it("surfaces the FormData for a useActionState action invoked as action(prevState, formData)", async () => {
    const fd = new FormData();
    fd.set("name", "bob");
    const request = actionRequest();

    const result = await executeServerAction(
      ctxWithDecodedArgs([{ prev: 1 }, fd]),
      request,
      {} as any,
      new URL(request.url),
      "a1",
      {} as any,
    );

    const cont = result as ActionContinuation;
    // FormData is the SECOND arg here — found by scanning, not args[0].
    expect(cont.actionContext.formData).toBe(fd);
    expect(cont.actionContext.formData?.get("name")).toBe("bob");
  });

  it("leaves formData undefined for a non-form action (no FormData in args)", async () => {
    const request = actionRequest();

    const result = await executeServerAction(
      ctxWithDecodedArgs(["plain-string-arg", 42]),
      request,
      {} as any,
      new URL(request.url),
      "a1",
      {} as any,
    );

    const cont = result as ActionContinuation;
    expect(cont.actionContext.formData).toBeUndefined();
  });
});

// C3: when an action throws and a route error boundary matches, the error
// boundary render must run INSIDE the route-middleware wrapper, exactly like a
// successful revalidation. Previously executeServerAction built + returned the
// error Response itself, bypassing route middleware (vars/headers/cookies set by
// route middleware did not apply to the error render). The fix defers the render
// to the revalidation phase via an `errorBoundary` continuation. These tests pin
// (1) executeServerAction returns the deferred continuation (not a Response) and
// (2) revalidateAfterAction renders the error boundary and merges request-context
// stub headers (what route middleware sets) onto the response.
describe("executeServerAction — action error boundary deferred under middleware (C3)", () => {
  const ERROR_MATCH = {
    segments: [],
    matched: ["err"],
    diff: ["err"],
    resolvedIds: ["err"],
    params: { id: "1" },
    routeName: "boom",
  };

  function ctxThrowsWithBoundary() {
    return {
      version: "v-test",
      createTemporaryReferenceSet: () => ({}),
      decodeReply: () => [],
      loadServerAction: async () => async () => {
        throw new Error("action boom");
      },
      callOnError: () => {},
      renderToReadableStream: () => new ReadableStream(),
      router: {
        id: "test",
        async matchError() {
          return ERROR_MATCH;
        },
      },
    } as any;
  }

  it("returns an errorBoundary continuation (not a Response) when a boundary matches", async () => {
    const request = new Request("http://localhost/page?_rsc_action=a1", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "encoded-args",
    });

    const result = await executeServerAction(
      ctxThrowsWithBoundary(),
      request,
      {} as any,
      new URL(request.url),
      "a1",
      { stream: () => ({}) } as any,
    );

    // The error render is NOT performed here — it is deferred so the revalidation
    // phase can run it under route middleware.
    expect(result).not.toBeInstanceOf(Response);
    const cont = result as ActionContinuation;
    expect(cont.errorBoundary).toBe(ERROR_MATCH);
    expect(cont.actionStatus).toBe(500);
    expect(cont.returnValue.ok).toBe(false);
  });

  it("revalidateAfterAction renders the error boundary AND merges route-middleware stub headers (the C3 contract)", async () => {
    const request = new Request("http://localhost/page?_rsc_action=a1", {
      method: "POST",
    });
    const reqCtx = createRequestContext({
      env: {},
      request,
      url: new URL(request.url),
      variables: {},
    });

    const ctx = {
      version: "v-test",
      callOnError: () => {},
      renderToReadableStream: () => new ReadableStream(),
      router: { id: "test" },
    } as any;

    const continuation: ActionContinuation = {
      returnValue: { ok: false, data: new Error("action boom") },
      actionStatus: 500,
      temporaryReferences: undefined,
      actionContext: {
        actionId: "a1",
        actionUrl: new URL(request.url),
        actionResult: new Error("action boom"),
      },
      errorBoundary: ERROR_MATCH as any,
    };

    const res = await runWithRequestContext(reqCtx, () => {
      // Simulate a route middleware that set a response header before the render.
      // createResponseWithMergedHeaders (inside revalidateAfterAction) must merge
      // it onto the error-boundary response — proving route middleware applies to
      // the error render, not just the success one.
      reqCtx.res.headers.set("X-Route-Mw", "applied");
      return revalidateAfterAction(
        ctx,
        request,
        {},
        new URL(request.url),
        reqCtx._handleStore,
        continuation,
      );
    });

    // Error-boundary response shape: 500 + Flight content type + router id.
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/x-component");
    expect(res.headers.get("X-RSC-Router-Id")).toBe("test");
    // The route-middleware header survived onto the error render.
    expect(res.headers.get("X-Route-Mw")).toBe("applied");
  });
});

describe("executeServerAction — thrown non-redirect Response is serialized", () => {
  // ctx stub for an action that throws a non-redirect Response. The catch path
  // with matchError === null falls through to building an ActionContinuation.
  function ctxThatThrowsResponse(response: Response) {
    return {
      createTemporaryReferenceSet: () => ({}),
      version: "1",
      loadServerAction: () => async () => {
        throw response;
      },
      // noop: the thrown Response is not a redirect, so this is never reached.
      createRedirectFlightResponse: () => null,
      callOnError: () => {},
      router: {
        id: "test",
        matchError: async () => null,
      },
    } as any;
  }

  it("stores a serializable Error (not the raw Response) as returnValue.data", async () => {
    // Empty body so decodeReply (hasBodyContent) is never invoked.
    const request = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "",
    });
    const url = new URL(request.url);

    const result = await executeServerAction(
      ctxThatThrowsResponse(new Response("nope", { status: 403 })),
      request,
      {} as any,
      url,
      "actionId",
      {} as any,
    );

    // matchError === null → falls through to an ActionContinuation, not a Response.
    expect(result).not.toBeInstanceOf(Response);
    const continuation = result as Exclude<typeof result, Response>;

    expect(continuation.returnValue.ok).toBe(false);
    // data must NOT be a raw Response; the asymmetric thrown case now mirrors
    // the returned-Response discard and stores a serializable Error.
    expect(continuation.returnValue.data).not.toBeInstanceOf(Response);
    expect(continuation.returnValue.data).toBeInstanceOf(Error);

    // The fix's contract: the embedded value is Flight/structuredClone-safe.
    expect(() => structuredClone(continuation.returnValue.data)).not.toThrow();

    // actionResult mirrors returnValue.data into the continuation actionContext.
    expect(continuation.actionContext.actionResult).not.toBeInstanceOf(
      Response,
    );
  });
});
