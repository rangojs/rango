/**
 * A `throw redirect()` from a server component (rango-t450).
 *
 * The throw lands inside the Flight render, after a navigation's headers and
 * its payload's first rows have left the server, so no HTTP status can answer
 * it. The target rides the error row's digest (`redirect-signal.ts`) and the
 * router's client boundary replace-navigates; a document request, which has
 * flushed nothing, answers a real 3xx (pinned in e2e: the SSR stub here
 * passes Flight through). This pins the two server-side halves a consumer can
 * see through the public primitives: what a navigation's payload carries, and
 * that a redirect is control flow, not a render error `onError` reports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { OnErrorContext } from "../../index.rsc.js";
import { decodeRedirectDigest } from "../../redirect-signal.js";

/** The signed-out session read: the throw lands after the shell flushed. */
async function getSession(): Promise<{ user: string } | null> {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return null;
}

async function AccountGate(): Promise<React.ReactNode> {
  const session = await getSession();
  if (!session) throw redirect("/login");
  return <p>account-summary</p>;
}

function AccountPage(): React.ReactNode {
  return (
    <main>
      <h1>Account</h1>
      <AccountGate />
    </main>
  );
}

/** The redirect thrown before the component awaits anything. */
function SyncGate(): React.ReactNode {
  throw redirect("/login", 303);
}

function SyncAccountPage(): React.ReactNode {
  return (
    <main>
      <h1>Account</h1>
      <SyncGate />
    </main>
  );
}

const reported: OnErrorContext[] = [];

const router = createRouter({
  onError: (ctx) => {
    reported.push(ctx);
  },
}).routes(
  urls(({ path }) => [
    path("/", () => <h1>home</h1>, { name: "home" }),
    path("/login", () => <h1>login</h1>, { name: "login" }),
    path("/account", AccountPage, { name: "account" }),
    path("/sync-account", SyncAccountPage, { name: "syncAccount" }),
  ]),
);

/** The redirect signals a served payload carries, in wire order. */
function signalsIn(
  flight: string | undefined,
): { to: string; status?: number }[] {
  if (!flight) return [];
  const signals: { to: string; status?: number }[] = [];
  for (const row of flight.split("\n")) {
    const match = /^[0-9a-z]+:E(\{.*\})$/.exec(row);
    if (!match) continue;
    const decoded = decodeRedirectDigest(
      (JSON.parse(match[1]!) as { digest?: unknown }).digest,
    );
    if (decoded) signals.push({ to: decoded.to, status: decoded.status });
  }
  return signals;
}

describe("a component's throw redirect() on a client navigation", () => {
  beforeEach(async () => {
    await resetShellTestState();
    reported.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries the target in the payload's error row (after an await)", async () => {
    const answer = await serveShellRequest(router, "/account", {
      partial: { from: "/", segments: [] },
    });

    expect(signalsIn(answer.flight)).toEqual([
      { to: "http://localhost/login", status: 302 },
    ]);
  });

  it("carries the target in the payload's error row (before any await)", async () => {
    const answer = await serveShellRequest(router, "/sync-account", {
      partial: { from: "/", segments: [] },
    });

    expect(signalsIn(answer.flight)).toEqual([
      { to: "http://localhost/login", status: 303 },
    ]);
  });

  it("is control flow, not a render error onError reports", async () => {
    await serveShellRequest(router, "/account", {
      partial: { from: "/", segments: [] },
    });

    expect(reported.map((ctx) => ctx.phase)).not.toContain("rendering");
  });

  it("carries the same signal on a document request's payload", async () => {
    // The stub SSR passes Flight through, so the document body here is the
    // payload the real render would have streamed; the 3xx answer is pinned in
    // e2e (packages/rangojs-router/e2e/component-redirect.test.ts).
    const answer = await serveShellRequest(router, "/account");

    expect(signalsIn(answer.flight)).toEqual([
      { to: "http://localhost/login", status: 302 },
    ]);
    expect(reported.map((ctx) => ctx.phase)).not.toContain("rendering");
  });
});
