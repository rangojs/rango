// Dogfood (#1087): the /pe-form-state page's useActionState form, submitted
// before hydration, through serveShellRequest and createActionForm. The POST's
// document payload carries the form state the SSR render received (the entry
// hands it to hydrateRoot); a GET carries none. The browser half is
// e2e/pe-form-state.test.ts.
import { describe, expect, it, vi } from "vitest";
import { createRouter, urls } from "@rangojs/router";
import {
  createActionForm,
  serveShellRequest,
} from "@rangojs/router/testing/flight";
import { makeOpaque, makeToken } from "../src/actions/pe-form-state.js";
import { peFormStatePatterns } from "../src/pages/pe-form-state.js";

const ACTION_ID = "src/actions/pe-form-state.ts#makeToken";

function router() {
  return createRouter({}).routes(
    urls(({ include }) => [include("/", peFormStatePatterns, { name: "" })]),
  );
}

describe("pe-form-state page", () => {
  it("a POST before hydration carries the form state in its payload", async () => {
    const result = await serveShellRequest(router(), "/pe-form-state", {
      form: createActionForm(makeToken, { id: ACTION_ID }),
    });

    expect(result.response.status).toBe(200);
    const [state, key, id, bound] = result.formState as [
      { token: string },
      string,
      string,
      number,
    ];
    expect(state.token).toMatch(/^tok-/);
    expect([key, id, bound]).toEqual(["k0", ACTION_ID, 0]);
    expect(await result.readPayloadFormState()).toEqual(result.formState);
  });

  it("a GET carries no form state", async () => {
    const result = await serveShellRequest(router(), "/pe-form-state");

    expect(result.formState).toBeUndefined();
    expect(await result.readPayloadFormState()).toBeUndefined();
  });

  it("a state Flight cannot serialize still renders; only the payload slot rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await serveShellRequest(router(), "/pe-form-state", {
      form: createActionForm(makeOpaque, {
        id: "src/actions/pe-form-state.ts#makeOpaque",
      }),
    });

    expect(result.response.status).toBe(200);
    expect((result.formState as [{ label: string }])[0].label).toBe(
      "opaque-result",
    );
    await expect(result.readHandles()).resolves.toBeDefined();
    await expect(result.readPayloadFormState()).rejects.toThrow();
  });
});
