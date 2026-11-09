/**
 * Userland contract: `redirect()` thrown from a SERVER COMPONENT navigates the
 * visitor, on a document load and on a client navigation, instead of landing
 * on an error boundary.
 *
 * A Response thrown from a handler or a loader is caught by the router. One
 * thrown from a component is caught by React's Flight renderer, which reports
 * it through `onError` and emits an error row for the read site; the digest
 * that `onError` returns is the only thing that reaches the browser. The
 * payload therefore carries the redirect there (`render-redirect.ts`), and the
 * two read sites resolve it: `answerShellError` answers a 3xx on a document
 * whose shell fails (pinned by `ssr/__tests__/shell-error-document.test.tsx`),
 * `RootErrorBoundary` mounts `LoaderRedirect` otherwise.
 *
 * Here: the payload the browser actually receives, through the production
 * handler (serveShellRequest), decoded the way the browser decodes it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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
  createRouter,
  createLocationState,
  redirect,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { renderRedirectOf } from "../../render-redirect.js";
import { Outlet, ParallelOutlet } from "../../client.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import type { InterceptSelectorContext } from "../../server/context.js";

/** The state a gated page carries onto /login. */
const Flash = createLocationState<{ text: string }>({ flash: true });

/**
 * The target the browser is handed: RESOLVED by the server
 * (`resolveSoftRedirect` against the request origin), so both read sites -- the
 * shell's 3xx and the client boundary -- land on the same URL.
 */
const LOGIN = "http://localhost/login";

/**
 * The reported shape: an async server component that resolves a session and
 * redirects a visitor who has none.
 */
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

async function StatefulGate(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("/login", { state: Flash({ text: "signed out" }) });
}

function StatefulPage(): React.ReactNode {
  return (
    <main>
      <h1>Account</h1>
      <StatefulGate />
    </main>
  );
}

/** A COMPONENT inside a layout's tree that throws: a segment kind of its own. */
async function GateInLayout(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("/login");
}

function GatedLayout(): React.ReactNode {
  return (
    <div>
      <GateInLayout />
      <Outlet />
    </div>
  );
}

/** A COMPONENT inside a parallel slot's tree that throws. */
async function GateInSlot(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("/login");
}

function GatedSlot(): React.ReactNode {
  return <GateInSlot />;
}

function SlotHost(): React.ReactNode {
  return (
    <main>
      <h1>Account</h1>
      <ParallelOutlet name="@side" />
    </main>
  );
}

/** A gate whose target is off-host with no `{ external: true }` opt-in. */
async function OffHostGate(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("https://evil.example/x");
}

function OffHostPage(): React.ReactNode {
  return (
    <main>
      <h1>Off-host</h1>
      <OffHostGate />
    </main>
  );
}

/** A gate that opts into an off-host target. */
async function ExternalGate(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("https://accounts.example.com/oauth", { external: true });
}

function ExternalPage(): React.ReactNode {
  return (
    <main>
      <h1>External</h1>
      <ExternalGate />
    </main>
  );
}

function makeRouter() {
  return createRouter().routes(
    urls(({ path, layout, parallel }) => [
      path("/", () => <p>home</p>, { name: "home" }),
      path("/account", AccountPage, { name: "account" }),
      path("/account/state", StatefulPage, { name: "accountState" }),
      path("/account/off-host", OffHostPage, { name: "accountOffHost" }),
      path("/account/external", ExternalPage, { name: "accountExternal" }),
      layout(GatedLayout, () => [
        path("/gated-layout", () => <p>account</p>, {
          name: "gatedLayout",
        }),
      ]),
      layout(
        () => <SlotHost />,
        () => [
          path(
            "/gated-slot",
            () => <p>account</p>,
            { name: "gatedSlot" },
            () => [parallel({ "@side": GatedSlot })],
          ),
        ],
      ),
      path("/login", () => <p>login</p>, { name: "login" }),
    ]),
  );
}

/**
 * The digest of every Flight error row in a payload, as the browser's Flight
 * client reads it (`resolveErrorProd`: a fresh Error carrying `digest` alone).
 */
function errorDigests(flight: string): string[] {
  const digests: string[] = [];
  for (const line of flight.split("\n")) {
    const at = line.indexOf(":E");
    if (at === -1) continue;
    digests.push(JSON.parse(line.slice(at + 2)).digest as string);
  }
  return digests;
}

/** The redirect the payload hands the browser, if any. */
function redirectOfPayload(flight: string): unknown {
  return errorDigests(flight)
    .map((digest) => renderRedirectOf({ digest }))
    .find((redirect) => redirect !== undefined);
}

afterEach(() => {
  resetShellTestState();
});

describe("a component that throws redirect()", () => {
  it("a document load hands the browser a navigation to the target, not an error", async () => {
    const result = await serveShellRequest(makeRouter(), "/account");

    expect(result.flight).toBeDefined();
    expect(redirectOfPayload(result.flight!)).toEqual({
      location: LOGIN,
      status: 302,
    });
    // Not an ordinary render failure: the empty digest is the error page.
    expect(errorDigests(result.flight!)).not.toContain("");
  });

  it("a client navigation hands the browser the same navigation", async () => {
    const result = await serveShellRequest(makeRouter(), "/account", {
      partial: { from: "/" },
    });

    expect(redirectOfPayload(result.flight!)).toEqual({
      location: LOGIN,
      status: 302,
    });
    expect(errorDigests(result.flight!)).not.toContain("");
  });

  it("a prefetch hands the browser the same navigation", async () => {
    const result = await serveShellRequest(makeRouter(), "/account", {
      partial: { from: "/", prefetch: true },
    });

    expect(redirectOfPayload(result.flight!)).toEqual({
      location: LOGIN,
      status: 302,
    });
  });

  it("carries redirect(url, { state }) onto the target", async () => {
    const result = await serveShellRequest(makeRouter(), "/account/state", {
      partial: { from: "/" },
    });

    const redirect = redirectOfPayload(result.flight!) as {
      location: string;
      status: number;
      state?: Record<string, unknown>;
    };
    expect(redirect.location).toBe(LOGIN);
    expect(redirect.status).toBe(302);
    // A bare test has no injected location-state key, so read the value.
    expect(Object.values(redirect.state ?? {})).toEqual([
      { text: "signed out" },
    ]);
  });

  it("a LAYOUT whose component throws hands the browser the same navigation", async () => {
    const result = await serveShellRequest(makeRouter(), "/gated-layout");

    expect(redirectOfPayload(result.flight!)).toEqual({
      location: LOGIN,
      status: 302,
    });
  });

  it("a PARALLEL SLOT whose component throws hands the browser the same navigation", async () => {
    const result = await serveShellRequest(makeRouter(), "/gated-slot");

    expect(redirectOfPayload(result.flight!)).toEqual({
      location: LOGIN,
      status: 302,
    });
  });

  it("lands an off-host target with no opt-in on the app root, as the document lane does", async () => {
    // The same-origin rule applies to a component throw as to every other
    // redirect, and it is applied where the digest is built: the browser read
    // site (`LoaderRedirect`) treats an off-origin target as the external
    // opt-in, so a raw one there would navigate off-origin while the document
    // lane's outgoing guard neutralizes the same throw.
    const result = await serveShellRequest(makeRouter(), "/account/off-host");

    expect(redirectOfPayload(result.flight!)).toEqual({
      location: "/",
      status: 302,
    });
  });

  it("lands an off-host target on the app root on an action's revalidation too", async () => {
    const result = await serveShellRequest(makeRouter(), "/account/off-host", {
      partial: { from: "/", stale: true },
    });

    expect(redirectOfPayload(result.flight!)).toEqual({
      location: "/",
      status: 302,
    });
  });

  it("lands an off-host target thrown inside an INTERCEPT on the app root", async () => {
    const router = createRouter().routes(
      urls(({ path, layout, intercept }) => [
        layout(
          () => <main>shell</main>,
          () => [
            path("/list", () => <ul>list</ul>, { name: "list" }),
            path("/item/:id", () => <article>item</article>, { name: "item" }),
            intercept("@modal", ".item", () => <OffHostGate />, {
              when: (ctx: InterceptSelectorContext) =>
                ctx.from.routeName === "list",
            }),
          ],
        ),
      ]),
    );

    const result = await serveShellRequest(router, "/item/1", {
      partial: { from: "/list" },
    });

    expect(redirectOfPayload(result.flight!)).toEqual({
      location: "/",
      status: 302,
    });
  });

  it("keeps an opted-in { external: true } target off-host", async () => {
    const result = await serveShellRequest(makeRouter(), "/account/external");

    expect(redirectOfPayload(result.flight!)).toEqual({
      location: "https://accounts.example.com/oauth",
      status: 302,
      external: true,
    });
  });

  it("lands a blocked target on the basename root", async () => {
    const router = createRouter({ basename: "/app" }).routes(
      urls(({ path }) => [
        path("/account/off-host", OffHostPage, { name: "offHost" }),
      ]),
    );

    const result = await serveShellRequest(router, "/app/account/off-host");

    expect(redirectOfPayload(result.flight!)).toEqual({
      location: "/app",
      status: 302,
    });
  });

  it("stores no ppr shell for a page whose component redirects", async () => {
    // The digest carries a resolved, origin-bearing target, so a stored shell
    // would send a later visitor to the origin it was built at. The render
    // records the throw in `_renderErrors`, which the capture refuses on.
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({ cache: { store: cacheStore } }).routes(
      urls(({ path }) => [
        path("/ppr-off-host", OffHostPage, { name: "pprOffHost", ppr: true }),
      ]),
    );

    const result = await serveShellRequest(router, "/ppr-off-host", {
      cacheStore,
    });

    expect(await result.readEntry()).toBeNull();
  });

  it("reports nothing to onError and prints nothing: control flow, not a failure", async () => {
    const onError = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      await serveShellRequest(
        createRouter({ onError }).routes(
          urls(({ path }) => [
            path("/", () => <p>home</p>, { name: "home" }),
            path("/account", AccountPage, { name: "account" }),
            path("/login", () => <p>login</p>, { name: "login" }),
          ]),
        ),
        "/account",
      );
      expect(onError).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps a route handler's own redirect() a real redirect on a document load", async () => {
    // The neighbouring lane: a handler RETURNING redirect() is a 3xx on the
    // document request and has nothing to do with the render's error row.
    const router = createRouter().routes(
      urls(({ path }) => [
        path("/gate", (_ctx: HandlerContext) => redirect("/login"), {
          name: "gate",
        }),
        path("/login", () => <p>login</p>, { name: "login" }),
      ]),
    );
    const result = await serveShellRequest(router, "/gate");
    expect(result.response.status).toBe(302);
    expect(result.response.headers.get("location")).toBe("/login");
  });
});
