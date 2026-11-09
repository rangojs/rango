/**
 * Probe: a `redirect()` thrown during the render of an async server component
 * (the account-page session gate), served through the production handler.
 *
 * The expected column is the ticket's: a signed-out visitor ends up on /login,
 * on a document request and on a client navigation. The probe prints what the
 * server answers today so the failure quotes it.
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

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createRouter, redirect, urls } from "../../index.rsc.js";

/** The reported shape: an async server component gating on a session. */
async function AccountGate(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("/login");
}

function AccountPage(): React.ReactNode {
  return (
    <main>
      <h1>Account</h1>
      <AccountGate />
    </main>
  );
}

const router = createRouter({}).routes(
  urls(({ path }) => [
    path("/", () => <h1>Home</h1>),
    path("/account", AccountPage),
    path("/login", () => <h1>Sign in</h1>),
  ]),
);

beforeEach(() => resetShellTestState());

describe("probe: redirect() thrown in an async server component", () => {
  it("a document request sends the visitor to /login", async () => {
    const result = await serveShellRequest(router, "/account");
    console.log(
      "[probe document] status:",
      result.response.status,
      "location:",
      result.response.headers.get("location"),
      "x-rsc-redirect:",
      result.response.headers.get("x-rsc-redirect"),
      "content-type:",
      result.response.headers.get("content-type"),
    );
    console.log("[probe document] body:", JSON.stringify(result.body));

    expect(
      result.response.headers.get("location") ??
        result.response.headers.get("x-rsc-redirect") ??
        result.body,
    ).toContain("/login");
  });

  it("a client navigation sends the visitor to /login", async () => {
    const result = await serveShellRequest(router, "/account", {
      partial: { from: "/" },
    });
    console.log(
      "[probe navigation] status:",
      result.response.status,
      "location:",
      result.response.headers.get("location"),
      "x-rsc-redirect:",
      result.response.headers.get("x-rsc-redirect"),
      "content-type:",
      result.response.headers.get("content-type"),
    );
    console.log("[probe navigation] body:", JSON.stringify(result.body));

    expect(
      result.response.headers.get("location") ??
        result.response.headers.get("x-rsc-redirect") ??
        result.body,
    ).toContain("/login");
  });
});
