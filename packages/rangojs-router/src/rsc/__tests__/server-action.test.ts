import { describe, it, expect } from "vitest";
import { executeServerAction } from "../server-action.js";

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
