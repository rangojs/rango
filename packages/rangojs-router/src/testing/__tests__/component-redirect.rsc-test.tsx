/**
 * A component that throws redirect() while React renders it is answered by the
 * render, as a handler's throw is: a document request answers the redirect's
 * 3xx (with its location-state cookie, or the external opt-in), and a client
 * navigation answers 204 + X-RSC-Redirect, or the redirect payload when the
 * redirect carries location state.
 *
 * Only while the status is still open: a synchronous component's throw is in
 * the render's opening flush, so a Flight response holds that flush and answers
 * it; a document answers it once the shell is ready. An async component is a
 * task of its own, so its error row lands in a later chunk, after the response
 * committed: that case is pinned here as the documented limit
 * (docs/internal/execution-model.md, "A component that throws redirect()
 * redirects, if the render says so in time"). A real document render answers
 * the async case when the throw fails its shell, which needs real Fizz and is
 * covered by e2e (`e2e/component-redirect.test.ts` in both apps).
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
import { withLocationStateKey } from "../location-state-key.js";
import {
  createLocationState,
  createRouter,
  redirect,
  urls,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

/** A page component: React renders it, so its throw never reaches a handler. */
function SyncRedirectPage(): React.ReactNode {
  throw redirect("/target");
}

const Flash = withLocationStateKey(
  createLocationState<{ text: string }>({ flash: true }),
  "Flash",
);

function SyncStateRedirectPage(): React.ReactNode {
  throw redirect("/target", { state: [Flash({ text: "saved" })] });
}

function SyncExternalRedirectPage(): React.ReactNode {
  throw redirect("https://elsewhere.example/x", { external: true });
}

function SyncBlockedRedirectPage(): React.ReactNode {
  throw redirect("javascript:alert(1)");
}

/** An async component: its throw is a task of its own, reported later. */
async function AsyncRedirectPage(): Promise<React.ReactNode> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  throw redirect("/target");
}

const patterns = urls(({ path, errorBoundary }) => [
  path("/start", () => <p>start</p>, { name: "start" }),
  path("/target", () => <p>target-page</p>, { name: "target" }),
  path("/sync", () => <SyncRedirectPage />, { name: "sync" }),
  path("/sync-state", () => <SyncStateRedirectPage />, { name: "syncState" }),
  path("/sync-external", () => <SyncExternalRedirectPage />, {
    name: "syncExternal",
  }),
  path("/sync-blocked", () => <SyncBlockedRedirectPage />, {
    name: "syncBlocked",
  }),
  // A declared boundary is no place for control flow: the redirect still
  // answers the response, the fallback never renders.
  path(
    "/sync-bounded",
    () => <SyncRedirectPage />,
    { name: "syncBounded" },
    () => [errorBoundary(({ error }) => <p>bounded:{error.message}</p>)],
  ),
  path("/async", () => <AsyncRedirectPage />, { name: "async" }),
]);

function makeRouter(basename?: string) {
  return createRouter({ basename }).routes(patterns);
}

function documentRequest(path: string, basename?: string) {
  return serveShellRequest(makeRouter(basename), path, {
    cacheStore: new MemorySegmentCacheStore(),
  });
}

function navigation(from: string, path: string, basename?: string) {
  return serveShellRequest(makeRouter(basename), path, {
    cacheStore: new MemorySegmentCacheStore(),
    partial: { from },
  });
}

beforeEach(() => resetShellTestState());

describe("a component's redirect (serveShellRequest)", () => {
  it("document: answers the redirect's 3xx, not the boundary", async () => {
    const res = await documentRequest("/sync");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe("/target");
    expect(res.flight).toBeUndefined();
  });

  it("document: carries the redirect's location state in the state cookie", async () => {
    const res = await documentRequest("/sync-state");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe("/target");
    expect(res.response.headers.get("Set-Cookie")).toContain("rango-state");
  });

  it("document: keeps an explicit off-host target", async () => {
    const res = await documentRequest("/sync-external");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe(
      "https://elsewhere.example/x",
    );
  });

  it("document: neutralizes an unsafe scheme to the app root", async () => {
    const res = await documentRequest("/sync-blocked");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe("/");
  });

  it("document: keeps a root-relative target under the basename", async () => {
    const res = await documentRequest("/app/sync", "/app");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe("/app/target");
  });

  it("document: a declared errorBoundary does not intercept it", async () => {
    const res = await documentRequest("/sync-bounded");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe("/target");
  });

  it("navigation: answers 204 + X-RSC-Redirect", async () => {
    const res = await navigation("/start", "/sync");
    expect(res.response.status).toBe(204);
    expect(res.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/target",
    );
    expect(res.flight).toBeUndefined();
  });

  it("navigation: a root-relative target keeps the basename", async () => {
    const res = await navigation("/app/start", "/app/sync", "/app");
    expect(res.response.status).toBe(204);
    expect(res.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/app/target",
    );
  });

  it("navigation: a declared errorBoundary does not intercept it", async () => {
    const res = await navigation("/start", "/sync-bounded");
    expect(res.response.status).toBe(204);
    expect(res.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/target",
    );
  });

  it("navigation: a redirect with location state travels as the redirect payload", async () => {
    const res = await navigation("/start", "/sync-state");
    expect(res.response.status).toBe(200);
    expect(await res.readRedirect()).toEqual({
      url: "http://localhost/target",
    });
    expect(await res.readLocationState()).toEqual({
      [Flash.__rsc_ls_key]: { text: "saved" },
    });
  });

  it("navigation: an explicit off-host target travels as the redirect payload", async () => {
    const res = await navigation("/start", "/sync-external");
    expect(res.response.status).toBe(200);
    expect(await res.readRedirect()).toEqual({
      url: "https://elsewhere.example/x",
      external: true,
    });
  });

  it("prefetch: answers the redirect instead of a body a click would adopt", async () => {
    const res = await serveShellRequest(makeRouter(), "/sync", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/start", prefetch: true },
    });
    expect(res.response.status).toBe(204);
    expect(res.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/target",
    );
  });

  it("limit: an async component's redirect is reported after the status commits, so the boundary renders", async () => {
    // Pinned, not wanted: see the module comment. The document lane answers it
    // in a real render (its shell fails first), the Flight lane cannot.
    const res = await navigation("/start", "/async");
    expect(res.response.status).toBe(200);
    expect(res.flight).toContain('"digest"');
    expect(res.response.headers.get("X-RSC-Redirect")).toBeNull();
  });
});
