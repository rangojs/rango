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
