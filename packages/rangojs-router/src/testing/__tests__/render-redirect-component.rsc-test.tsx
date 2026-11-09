/**
 * `throw redirect(...)` from inside the Flight render (an async server
 * component) is control flow, as it is from a loader: the visitor ends up on
 * the target instead of the error page.
 *
 * React owns the throw, so the router cannot answer it with a 3xx once the
 * response has started; the target rides the Flight error row's digest
 * (render-redirect.ts) and the client replaces to it (LoaderRedirect), while
 * a document whose shell fails on the row is answered with the redirect's own
 * 3xx (ssr/shell-error-document.tsx, pinned in
 * ssr/__tests__/shell-error-document.test.tsx).
 *
 * Pinned here, through serveShellRequest:
 * - the row carries the digest, on a document and on a client navigation;
 * - the render is never reported or printed: control flow, not a failure;
 * - the payload is never stored (the document cache refuses it);
 * - the target goes through the same basename/same-origin policy as a loader's;
 * - everything else is unchanged: an ordinary component throw is still an
 *   error (reported once), `notFound()` from a component is not a redirect,
 *   and a loader's `redirect()` keeps its loader-result marker.
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
import {
  createLoader,
  createRouter,
  createLocationState,
  notFound,
  redirect,
  urls,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import {
  RENDER_REDIRECT_DIGEST_PREFIX,
  renderRedirectOf,
} from "../../render-redirect.js";
import { withLocationStateKey } from "../location-state-key.js";

const Flash = withLocationStateKey(
  createLocationState<{ text: string }>({ flash: true }),
  "Flash",
);

/** The reported shape: an async server component that gates on a session. */
async function AccountGate(): Promise<React.ReactNode> {
  const session = await Promise.resolve(null);
  if (!session) throw redirect("/login");
  return <p>account-summary</p>;
}

/** The same throw from a component behind `loading()`, so it streams. */
async function SlowGate(): Promise<React.ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  throw redirect("/login");
}

async function PlainBoom(): Promise<React.ReactNode> {
  await Promise.resolve(null);
  throw new Error("gate exploded");
}

async function MissingGate(): Promise<React.ReactNode> {
  await Promise.resolve(null);
  notFound("no session");
  return null;
}

async function StateGate(): Promise<React.ReactNode> {
  await Promise.resolve(null);
  throw redirect("/login", { state: [Flash({ text: "signed out" })] });
}

async function ExternalGate(): Promise<React.ReactNode> {
  await Promise.resolve(null);
  throw redirect("https://accounts.example.com/oauth", { external: true });
}

async function CrossOriginGate(): Promise<React.ReactNode> {
  await Promise.resolve(null);
  throw redirect("https://evil.example/phish");
}

function Page({ gate }: { gate: React.ReactNode }): React.ReactNode {
  return (
    <main>
      <h1>Account</h1>
      {gate}
    </main>
  );
}

const LoaderGate = createLoader(async () => {
  throw redirect("/login");
});

const Loading = <p>loading-fallback</p>;

function patterns() {
  return urls(({ path, loader, loading }) => [
    path("/", () => <p>home</p>, { name: "home" }),
    path("/account", () => <Page gate={<AccountGate />} />, {
      name: "account",
    }),
    path(
      "/slow",
      () => <Page gate={<SlowGate />} />,
      { name: "slow" },
      () => [loading(Loading)],
    ),
    path("/boom", () => <Page gate={<PlainBoom />} />, { name: "boom" }),
    path("/missing", () => <Page gate={<MissingGate />} />, {
      name: "missing",
    }),
    path("/state", () => <Page gate={<StateGate />} />, { name: "state" }),
    path("/external", () => <Page gate={<ExternalGate />} />, {
      name: "external",
    }),
    path("/cross", () => <Page gate={<CrossOriginGate />} />, {
      name: "cross",
    }),
    path(
      "/loader",
      () => <p>loader page</p>,
      { name: "loaderPage" },
      () => [loader(LoaderGate)],
    ),
    path("/login", () => <p>login-page</p>, { name: "login" }),
  ]);
}

/** The digest the error row for a render redirect carries, decoded. */
function digestIn(flight: string): Record<string, unknown> | null {
  for (const line of flight.split("\n")) {
    if (!/^\d+:E\{/.test(line)) continue;
    const row = JSON.parse(line.slice(line.indexOf("{"))) as {
      digest?: string;
    };
    if (
      typeof row.digest === "string" &&
      row.digest.startsWith(RENDER_REDIRECT_DIGEST_PREFIX)
    ) {
      return renderRedirectOf({ digest: row.digest }) as Record<
        string,
        unknown
      >;
    }
  }
  return null;
}

function makeRouter(options: Parameters<typeof createRouter>[0] = {}) {
  const onError = vi.fn();
  const router = createRouter({ onError, ...options }).routes(patterns());
  return { router, onError };
}

function serve(
  router: ReturnType<typeof makeRouter>["router"],
  url: string,
  partial?: { from: string },
) {
  return serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
    ...(partial && { partial }),
  });
}

beforeEach(() => {
  resetShellTestState();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a redirect thrown from a server component", () => {
  it("navigation: the error row carries the target as a digest", async () => {
    const { router, onError } = makeRouter();
    const res = await serve(router, "/account", { from: "/" });

    expect(res.response.status).toBe(200);
    // No header and no payload metadata: the response had already started
    // when React reported the throw.
    expect(res.response.headers.get("x-rsc-redirect")).toBeNull();
    expect(digestIn(res.flight)).toEqual({
      to: "http://localhost/login",
      status: 302,
    });
    // Control flow, not a failure.
    expect(onError).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("document: the same row, so the shell-error answer is a 3xx", async () => {
    const { router, onError } = makeRouter();
    const res = await serve(router, "/account");

    expect(digestIn(res.flight)).toEqual({
      to: "http://localhost/login",
      status: 302,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("a redirect behind loading() keeps the fallback in the stream and the digest in the row", async () => {
    const { router } = makeRouter();
    const res = await serve(router, "/slow", { from: "/" });

    expect(res.flight).toContain("loading-fallback");
    expect(digestIn(res.flight)).toEqual({
      to: "http://localhost/login",
      status: 302,
    });
  });

  it("carries redirect(url, { state }) on the digest, so the client replace carries it", async () => {
    const { router } = makeRouter();
    const res = await serve(router, "/state", { from: "/" });

    expect(digestIn(res.flight)).toMatchObject({
      to: "http://localhost/login",
      state: { __rsc_ls_Flash: { text: "signed out" } },
    });
  });

  it("keeps an explicit off-origin target and blocks an implicit one, as the loader lane does", async () => {
    const { router } = makeRouter();
    const external = await serve(router, "/external", { from: "/" });
    expect(digestIn(external.flight)).toMatchObject({
      to: "https://accounts.example.com/oauth",
      external: true,
    });

    const blocked = await serve(router, "/cross", { from: "/" });
    // safeSameOriginLanding: a blocked target lands on the app root.
    expect(digestIn(blocked.flight)).toMatchObject({ to: "/" });
  });

  it("keeps the router's basename on the target", async () => {
    const { router } = makeRouter({ basename: "/app" });
    const res = await serve(router, "/app/account", { from: "/app" });

    expect(digestIn(res.flight)).toEqual({
      to: "http://localhost/app/login",
      status: 302,
    });
  });

  it("is never stored: a second document request renders the component again", async () => {
    const { router } = makeRouter();
    const first = await serve(router, "/account");
    expect(digestIn(first.flight)).not.toBeNull();
    // A stored document would answer the second request from the cache, with
    // the first request's redirect and no render of its own.
    expect(await first.readEntry()).toBeNull();
    const second = await serve(router, "/account");
    expect(digestIn(second.flight)).not.toBeNull();
  });

  it("an ordinary component throw is still an error, reported once", async () => {
    const { router, onError } = makeRouter();
    const res = await serve(router, "/boom", { from: "/" });

    expect(digestIn(res.flight)).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("notFound() from a component is not a redirect: unchanged", async () => {
    const { router } = makeRouter();
    const res = await serve(router, "/missing", { from: "/" });

    expect(digestIn(res.flight)).toBeNull();
    expect(res.flight).toMatch(/^\d+:E\{/m);
  });

  it("a loader's redirect() keeps its loader-result marker", async () => {
    const { router } = makeRouter();
    const res = await serve(router, "/loader", { from: "/" });

    expect(res.flight).toContain('"redirect":{"to":"http://localhost/login"');
    expect(digestIn(res.flight)).toBeNull();
  });
});
