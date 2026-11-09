/**
 * A `redirect()` thrown during the render of an async server component.
 *
 * The report: an account page checks the session in an async server component,
 * and a signed-out visitor gets the error page instead of /login — on a
 * document request and on a client navigation.
 *
 * Today both lanes answer 200 and the payload carries the masked error row
 * (`3:E{"digest":""}`) the client's `RootErrorBoundary` renders: the throw
 * reaches `createFlightStage`'s `onError` (`rsc/render-pipeline.ts`), which
 * never inspects a thrown `Response`. `redirect()`'s documented sites are a
 * handler return, middleware and a loader throw (`skills/route/SKILL.md`
 * "Redirects", `skills/loader/SKILL.md` "Loader Authority"); a component
 * render is not one of them, and the written contracts state the error-page
 * outcome for it.
 *
 * These cases pin the reported expectation and are RED until that is decided.
 * If the documented sites stay as they are, invert them into a pin of the
 * error page (and of the dev warning that names the supported sites) rather
 * than deleting the file.
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
import { createLoader, createRouter, redirect, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

// The report's gate: an async server component that throws a redirect once the
// session read comes back empty.
async function AccountGate(): Promise<React.ReactElement> {
  await Promise.resolve();
  throw redirect("/login");
}

function AccountPage(): React.ReactElement {
  return (
    <main>
      <h1>Account</h1>
      <AccountGate />
    </main>
  );
}

function HomePage(): React.ReactElement {
  return <h1>Home</h1>;
}

function LoginPage(): React.ReactElement {
  return <h1>Login</h1>;
}

const Loading = <p>loading-fallback</p>;

// The supported site next door: a loader's redirect() rides the same two lanes,
// so a failure above is the component site and not the harness.
const gateLoader = createLoader(async () => {
  throw redirect("/login");
});

const patterns = urls(({ path, loading, loader }) => [
  path("/", HomePage, { name: "home" }),
  path("/account", AccountPage, { name: "account" }),
  path("/account-loader", HomePage, { name: "accountLoader" }, () => [
    loader(gateLoader),
  ]),
  // The same render behind a `loading()` boundary: the streamed branch of the
  // same route must answer the same way.
  path("/account-loading", AccountPage, { name: "accountLoading" }, () => [
    loading(Loading),
  ]),
  path("/login", LoginPage, { name: "login" }),
]);

function makeRouter() {
  return createRouter({}).routes(patterns);
}

beforeEach(() => resetShellTestState());

describe("redirect() thrown from an async server component", () => {
  it("document: /account answers a redirect to /login", async () => {
    const router = makeRouter();
    const res = await serveShellRequest(router, "/account", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("location")).toBe("/login");
  });

  it("navigation: /account answers a soft redirect to /login", async () => {
    const router = makeRouter();
    const res = await serveShellRequest(router, "/account", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/" },
    });
    expect(res.response.headers.get("x-rsc-redirect")).toBe("/login");
  });

  it("document: the same render under loading() answers a redirect", async () => {
    const router = makeRouter();
    const res = await serveShellRequest(router, "/account-loading", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("location")).toBe("/login");
  });

  it("navigation: the same render under loading() answers a soft redirect", async () => {
    const router = makeRouter();
    const res = await serveShellRequest(router, "/account-loading", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/" },
    });
    expect(res.response.headers.get("x-rsc-redirect")).toBe("/login");
  });

  // Control, green today: the same redirect thrown from a loader is carried as
  // `__loaderResult.redirect` and leaves no error row behind. It keeps passing
  // whichever way the component site is decided.
  it("control: a loader's redirect() is carried and writes no error row", async () => {
    const router = makeRouter();
    const res = await serveShellRequest(router, "/account-loader", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/" },
    });
    expect(res.flight).toContain('"redirect"');
    expect(res.flight).not.toContain('E{"digest":""}');
  });
});
