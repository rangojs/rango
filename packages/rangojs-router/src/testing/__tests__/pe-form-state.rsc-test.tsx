/**
 * A form submitted before hydration (a no-JS POST) through `serveShellRequest`
 * and `createActionForm`, the public primitives (#1087):
 * - the re-rendered document's payload carries the useActionState form state,
 *   the same value the SSR render receives, so the entry can hand it to
 *   hydrateRoot and the hook does not reset;
 * - a GET, a plain-action POST and a redirecting action carry none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  createActionForm,
  resetShellTestState,
  serveShellRequest,
} from "../flight.entry.js";
import { createRouter, redirect, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

type TokenState = { token: string } | null;

async function makeToken(
  _prev: TokenState,
  _form: FormData,
): Promise<TokenState> {
  return { token: "tok-1" };
}

async function plainAction(_form: FormData): Promise<void> {}

async function redirectingAction(
  _prev: TokenState,
  _form: FormData,
): Promise<TokenState> {
  throw redirect("/elsewhere");
}

class OpaqueResult {
  label = "opaque";
}

async function opaqueAction(
  _prev: TokenState,
  _form: FormData,
): Promise<OpaqueResult> {
  return new OpaqueResult();
}

async function fieldAction(
  _prev: TokenState,
  form: FormData,
): Promise<{ token: string }> {
  return { token: String(form.get("name")) };
}

async function throwingAction(
  _prev: TokenState,
  _form: FormData,
): Promise<TokenState> {
  throw new Error("boom");
}

function makeRouter(options: Parameters<typeof createRouter>[0] = {}) {
  return createRouter(options).routes(
    urls(({ path }) => [
      path("/token", () => <p>token page</p>, { name: "token" }),
      path("/elsewhere", () => <p>elsewhere</p>, { name: "elsewhere" }),
      path("/shelled", () => <p>shelled page</p>, {
        name: "shelled",
        ppr: true,
      }),
    ]),
  );
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a form submitted before hydration", () => {
  it("carries the useActionState form state in the payload, the value SSR received", async () => {
    const result = await serveShellRequest(makeRouter(), "/token", {
      form: createActionForm(makeToken, { id: "actions/token#makeToken" }),
    });

    expect(result.response.status).toBe(200);
    expect(result.formState).toEqual([
      { token: "tok-1" },
      "k0",
      "actions/token#makeToken",
      0,
    ]);
    expect(await result.readPayloadFormState()).toEqual(result.formState);
  });

  it("carries no form state on a GET", async () => {
    const result = await serveShellRequest(makeRouter(), "/token");

    expect(result.formState).toBeUndefined();
    expect(await result.readPayloadFormState()).toBeUndefined();
    expect(result.flight).not.toContain("formState");
  });

  it("carries no form state for a plain <form action={fn}> POST", async () => {
    const result = await serveShellRequest(makeRouter(), "/token", {
      form: createActionForm(plainAction, {
        id: "actions/token#plainAction",
        useActionState: false,
      }),
    });

    expect(result.response.status).toBe(200);
    expect(result.formState).toBeUndefined();
    expect(await result.readPayloadFormState()).toBeUndefined();
  });

  it("answers a redirecting action with the redirect, no document", async () => {
    const result = await serveShellRequest(makeRouter(), "/token", {
      form: createActionForm(redirectingAction, {
        id: "actions/token#redirectingAction",
      }),
    });

    expect(result.response.status).toBeGreaterThanOrEqual(300);
    expect(result.response.status).toBeLessThan(400);
    expect(result.response.headers.get("location")).toContain("/elsewhere");
    expect(result.flight).toBeUndefined();
  });

  it("hands the thrown-action re-render the same form state on both sides", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await serveShellRequest(makeRouter(), "/token", {
      form: createActionForm(throwingAction, {
        id: "actions/token#throwingAction",
      }),
    });

    expect(result.response.status).toBe(500);
    expect(await result.readPayloadFormState()).toEqual(result.formState);
  });

  it("reports the thrown action to onError by its reference id", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();
    await serveShellRequest(makeRouter({ onError }), "/token", {
      form: createActionForm(throwingAction, {
        id: "actions/token#throwingAction",
      }),
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "action",
        actionId: "actions/token#throwingAction",
      }),
    );
  });

  it("is never stored as a PPR shell, and the GET after it is a MISS", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const post = await serveShellRequest(makeRouter(), "/shelled", {
      cacheStore,
      form: createActionForm(makeToken, { id: "actions/token#makeToken" }),
    });

    expect(post.shellStatus).toBeNull();
    expect(await post.readEntry()).toBeNull();

    const get = await serveShellRequest(makeRouter(), "/shelled", {
      cacheStore,
    });
    expect(get.shellStatus).toBe("MISS");
  });

  it("hands the action the form's own fields", async () => {
    const result = await serveShellRequest(makeRouter(), "/token", {
      form: createActionForm(fieldAction, {
        id: "actions/token#fieldAction",
        fields: { name: "ada" },
      }),
    });

    expect((result.formState as [{ token: string }])[0]).toEqual({
      token: "ada",
    });
    expect(await result.readPayloadFormState()).toEqual(result.formState);
  });

  it("renders the document when the action's state is not Flight-serializable; only the payload slot rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();
    const result = await serveShellRequest(makeRouter({ onError }), "/token", {
      form: createActionForm(opaqueAction, {
        id: "actions/token#opaqueAction",
      }),
    });

    // SSR still receives the raw value, so the HTML shows the result.
    expect(result.response.status).toBe(200);
    expect(result.flight).toContain("token page");
    expect((result.formState as [OpaqueResult])[0]).toBeInstanceOf(
      OpaqueResult,
    );
    // The payload root still decodes (the entry hydrates from it); only the
    // form state slot rejects, and the entry catches that.
    await expect(result.readHandles()).resolves.toBeDefined();
    await expect(result.readPayloadFormState()).rejects.toThrow();
    // The rejected slot reaches the app's onError as a rendering error.
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "rendering", method: "POST" }),
    );
  });
});
