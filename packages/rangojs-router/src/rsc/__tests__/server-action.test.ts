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

describe("executeServerAction — decode-error info disclosure", () => {
  // The decode failure is caught at the very top of executeServerAction (before
  // any router/render machinery), so a minimal ctx stub reaches the catch.
  function ctxThatFailsDecode(detail: string) {
    return {
      createTemporaryReferenceSet: () => ({}),
      decodeReply: () => {
        throw new Error(detail);
      },
    } as any;
  }

  it("throws a generic message and keeps the original error as cause (no leak)", async () => {
    const SECRET = "SECRET internal decode detail";
    const request = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "non-empty-body",
    });
    const url = new URL(request.url);

    let thrown: unknown;
    try {
      await executeServerAction(
        ctxThatFailsDecode(SECRET),
        request,
        {} as any,
        url,
        "actionId",
        {} as any,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // Message is static — does NOT interpolate the raw decode error.
    expect((thrown as Error).message).toBe("Failed to decode action arguments");
    expect((thrown as Error).message).not.toContain(SECRET);
    // The original error is preserved on `cause` for server-side logging.
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect(((thrown as Error).cause as Error).message).toBe(SECRET);
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
