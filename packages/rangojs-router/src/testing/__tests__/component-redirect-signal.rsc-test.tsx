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
import {
  createLocationState,
  createRouter,
  redirect,
  urls,
} from "../../index.rsc.js";
import type { OnErrorContext, Rango } from "../../index.rsc.js";
import {
  decodeRedirectDigest,
  type RedirectSignal,
} from "../../redirect-signal.js";

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

const Flash = createLocationState<{ text: string }>();

function StateGate(): React.ReactNode {
  throw redirect("/login", { state: Flash({ text: "hi" }) });
}

function ExternalGate(): React.ReactNode {
  throw redirect("https://accounts.example.com/oauth", { external: true });
}

/** No `{ external: true }`: the same-origin rule must neutralize the target. */
function CrossOriginGate(): React.ReactNode {
  throw redirect("https://evil.example.com/x");
}

/** A Response that is not a redirect stays an error, unchanged. */
function RawResponseGate(): React.ReactNode {
  throw new Response("raw", { status: 200 });
}

const reported: OnErrorContext[] = [];

function makeRouter(opts: { basename?: string } = {}): Rango<any, any> {
  return createRouter({
    ...opts,
    onError: (ctx) => {
      reported.push(ctx);
    },
  }).routes(
    urls(({ path, loading }) => [
      path("/", () => <h1>home</h1>, { name: "home" }),
      path("/login", () => <h1>login</h1>, { name: "login" }),
      path("/account", AccountPage, { name: "account" }),
      path("/sync-account", SyncAccountPage, { name: "syncAccount" }),
      path(
        "/state",
        () => (
          <main>
            <StateGate />
          </main>
        ),
        { name: "state" },
      ),
      path(
        "/external",
        () => (
          <main>
            <ExternalGate />
          </main>
        ),
        {
          name: "external",
        },
      ),
      path(
        "/cross-origin",
        () => (
          <main>
            <CrossOriginGate />
          </main>
        ),
        {
          name: "crossOrigin",
        },
      ),
      path(
        "/raw",
        () => (
          <main>
            <RawResponseGate />
          </main>
        ),
        { name: "raw" },
      ),
      // A loading() route whose async HANDLER throws the redirect: the
      // handler result is streamed, so the throw reaches the same render
      // funnel a component's does (was: a documented limitation).
      path(
        "/loading-handler",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          throw redirect("/login");
        },
        { name: "loadingHandler" },
        () => [loading(<p>skeleton</p>)],
      ),
      // A ppr route: the shell capture must refuse a page that produced no
      // page, without reporting it as cache degradation.
      path("/ppr-account", AccountPage, {
        name: "pprAccount",
        ppr: { ttl: 300 },
      }),
    ]),
  );
}

const router = makeRouter();

/** The redirect signals a served payload carries, in wire order. */
function signalsIn(flight: string | undefined): RedirectSignal[] {
  if (!flight) return [];
  const signals: RedirectSignal[] = [];
  for (const row of flight.split("\n")) {
    const match = /^[0-9a-z]+:E(\{.*\})$/.exec(row);
    if (!match) continue;
    const decoded = decodeRedirectDigest(
      (JSON.parse(match[1]!) as { digest?: unknown }).digest,
    );
    if (decoded) signals.push(decoded);
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

  it("carries redirect(url, { state })'s record with the target", async () => {
    const answer = await serveShellRequest(router, "/state", {
      partial: { from: "/", segments: [] },
    });

    const [signal] = signalsIn(answer.flight);
    expect(signal?.to).toBe("http://localhost/login");
    expect(Object.values(signal?.state ?? {})).toEqual([{ text: "hi" }]);
  });

  it("carries the { external: true } opt-in", async () => {
    const answer = await serveShellRequest(router, "/external", {
      partial: { from: "/", segments: [] },
    });

    expect(signalsIn(answer.flight)).toEqual([
      {
        to: "https://accounts.example.com/oauth",
        status: 302,
        external: true,
      },
    ]);
  });

  it("neutralizes a cross-origin target without the opt-in", async () => {
    const answer = await serveShellRequest(router, "/cross-origin", {
      partial: { from: "/", segments: [] },
    });

    expect(signalsIn(answer.flight)).toEqual([
      // safeSameOriginLanding: the app root, as every other channel answers it.
      { to: "/", status: 302 },
    ]);
  });

  it("keeps a basename in the target", async () => {
    const based = makeRouter({ basename: "/app" });
    const answer = await serveShellRequest(based, "/app/account", {
      partial: { from: "/app", segments: [] },
    });

    expect(signalsIn(answer.flight)).toEqual([
      { to: "http://localhost/app/login", status: 302 },
    ]);
  });

  it("carries the target from an async handler under loading()", async () => {
    // The handler result is streamed, not awaited at the resolution boundary,
    // so its Response surfaces during serialization: the render funnel turns
    // it into the same digest.
    const answer = await serveShellRequest(router, "/loading-handler", {
      partial: { from: "/", segments: [] },
    });

    expect(signalsIn(answer.flight)).toEqual([
      { to: "http://localhost/login", status: 302 },
    ]);
  });

  it("is refused by a ppr capture without a cache-error report", async () => {
    const first = await serveShellRequest(router, "/ppr-account");
    const second = await serveShellRequest(router, "/ppr-account");

    // Never stored: the second document request is a fresh render, not a HIT
    // serving a page that would redirect every visitor to one target.
    expect(second.shellStatus).not.toBe("HIT");
    expect(signalsIn(second.flight)).toEqual([
      { to: "http://localhost/login", status: 302 },
    ]);
    expect(first.response.status).toBe(200);
    // Nothing reached the console as a cache failure.
    expect(console.error).not.toHaveBeenCalled();
    expect(reported.map((ctx) => ctx.phase)).not.toContain("cache");
  });

  it("leaves a Response that is not a redirect an error", async () => {
    const answer = await serveShellRequest(router, "/raw", {
      partial: { from: "/", segments: [] },
    });

    expect(signalsIn(answer.flight)).toEqual([]);
    expect(answer.flight).toContain(":E{");
    expect(reported.map((ctx) => ctx.phase)).toContain("rendering");
  });
});
