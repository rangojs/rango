/**
 * A server component that throws redirect() while React renders it.
 *
 * It is not a handler's return, so it never reaches handleHandlerResult: React
 * reports it to the Flight onError and renders the nearest error boundary, and
 * the request used to answer a 200 error page (a document) or an error row (a
 * client navigation). The render answers it instead, in the shape the request's
 * channel can carry: a real 3xx for a document, the Flight redirect a
 * navigation already understands.
 *
 * A redirect the render reports AFTER the body started streaming keeps the
 * error row it always had: the status line has already committed by then. That
 * is a component that suspends before throwing (an async one, or any behind
 * loading()) on a client navigation, and the same shape on a document whose
 * shell is a loading() fallback. It is the class
 * streamed-handler-boundary.rsc-test.tsx pins for a handler's late Response.
 *
 * An explicit Accept: text/x-component document is not a channel the client
 * follows a redirect on, so it keeps the error row and the render reports it.
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
import { withLocationStateKey } from "../location-state-key.js";
import {
  createLocationState,
  createRouter,
  redirect,
  urls,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";

const Flash = withLocationStateKey(
  createLocationState<{ text: string }>({ flash: true }),
  "Flash",
);
const FLASH = Flash.__rsc_ls_key;

function ThrowSync(): React.ReactNode {
  throw redirect("/target", 302);
}

async function ThrowAsync(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("/target", 302);
}

function ThrowPaid(): React.ReactNode {
  throw redirect("/target", { status: 303, state: [Flash({ text: "paid" })] });
}

function ThrowExternal(): React.ReactNode {
  throw redirect("https://example.com/x", { external: true });
}

function Boom(): React.ReactNode {
  throw new Error("render boom");
}

const patterns = urls(({ path, layout, errorBoundary }) => [
  layout(
    ({ children }: { children?: React.ReactNode }) => (
      <main>
        <nav>site-nav</nav>
        {children}
      </main>
    ),
    () => [
      errorBoundary(({ error }) => <p>declared-error:{error.message}</p>),
      path("/throw", () => <ThrowSync />, { name: "throw" }),
      path("/throw-async", () => <ThrowAsync />, { name: "throwAsync" }),
      path("/throw-paid", () => <ThrowPaid />, { name: "throwPaid" }),
      path("/throw-external", () => <ThrowExternal />, {
        name: "throwExternal",
      }),
      path("/boom", () => <Boom />, { name: "boom" }),
      path("/ok", async () => <p>fine</p>, { name: "ok" }),
    ],
  ),
]);

// A page that redirects only once the action it posts has run: the PE re-render
// and the JS action's revalidation both render it.
let redirectAfterAction = false;

async function setRedirect(_form: FormData): Promise<void> {
  redirectAfterAction = true;
}

async function setRedirectAndAnswer(): Promise<string> {
  redirectAfterAction = true;
  return "answered";
}

function MaybeRedirect(): React.ReactNode {
  if (redirectAfterAction) throw redirect("/target", 302);
  return <p>form page</p>;
}

const patternsAction = urls(({ path }) => [
  path("/form", () => <MaybeRedirect />, { name: "form" }),
  path("/target", () => <p>arrived</p>, { name: "target" }),
]);

// A `ppr` route: its shell is captured in the background after the response.
const patternsPpr = urls(({ path }) => [
  path("/shell-throw", () => <ThrowSync />, {
    name: "shellThrow",
    ppr: { ttl: 300 },
  }),
  path("/shell-ok", () => <p>fine</p>, {
    name: "shellOk",
    ppr: { ttl: 300 },
  }),
]);

const patternsNoBoundary = urls(({ path }) => [
  path("/throw", () => <ThrowSync />, { name: "throw" }),
  path("/ok", async () => <p>fine</p>, { name: "ok" }),
]);

function makeRouter(options: { basename?: string } = {}) {
  return createRouter({ onError: vi.fn(), ...options }).routes(patterns);
}

function serve(
  router: Parameters<typeof serveShellRequest>[0],
  path: string,
  options: Parameters<typeof serveShellRequest>[2] = {},
) {
  return serveShellRequest(router, path, {
    cacheStore: new MemorySegmentCacheStore(),
    ...options,
  });
}

beforeEach(() => {
  redirectAfterAction = false;
  resetShellTestState();
});

describe("a component that throws redirect()", () => {
  it("document: answers a 302 instead of the boundary page", async () => {
    const res = await serve(makeRouter(), "/throw");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("location")).toBe("/target");
    expect(res.body).toBe("");
  });

  it("document: an async component answers the same 302", async () => {
    const res = await serve(makeRouter(), "/throw-async");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("location")).toBe("/target");
  });

  it("document: with no declared boundary the client's own boundary is not what answers", async () => {
    const router = createRouter({ onError: vi.fn() }).routes(
      patternsNoBoundary,
    );
    const res = await serve(router, "/throw");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("location")).toBe("/target");
  });

  it("document: the redirect's status and state ride the one-shot cookie", async () => {
    const res = await serve(makeRouter(), "/throw-paid");
    expect(res.response.status).toBe(303);
    expect(res.response.headers.get("location")).toBe("/target");
    const cookies = res.response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(decodeURIComponent(cookies[0]!)).toContain(FLASH);
    expect(decodeURIComponent(cookies[0]!)).toContain("paid");
  });

  it("document: redirect(url, { external: true }) keeps its off-host target", async () => {
    const res = await serve(makeRouter(), "/throw-external");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("location")).toBe("https://example.com/x");
  });

  it("document: a basename is kept on the target", async () => {
    const res = await serve(makeRouter({ basename: "/app" }), "/app/throw");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("location")).toBe("/app/target");
  });

  it("document: an ordinary boundary error still answers its 200 page", async () => {
    const res = await serve(makeRouter(), "/boom");
    expect(res.response.status).toBe(200);
    expect(res.response.headers.get("location")).toBeNull();
    // The boundary renders from the error row; only React knows the fallback.
    expect(res.flight).toMatch(/^\d+:E\{/m);
  });

  it("navigation: answers the 204 + X-RSC-Redirect the client re-navigates with", async () => {
    const res = await serve(makeRouter(), "/throw", {
      partial: { from: "/ok" },
    });
    expect(res.response.status).toBe(204);
    expect(res.response.headers.get("x-rsc-redirect")).toBe(
      "http://localhost/target",
    );
  });

  it("navigation: a basename is kept on the redirect target", async () => {
    const res = await serve(makeRouter({ basename: "/app" }), "/app/throw", {
      partial: { from: "/app/ok" },
    });
    expect(res.response.status).toBe(204);
    expect(res.response.headers.get("x-rsc-redirect")).toBe(
      "http://localhost/app/target",
    );
  });

  it("navigation: a redirect with state rides the payload", async () => {
    const res = await serve(makeRouter(), "/throw-paid", {
      partial: { from: "/ok" },
    });
    expect(res.response.status).toBe(200);
    const payload = JSON.parse(res.flight!.split("\n")[0]!.slice(2));
    expect(payload.metadata.redirect.url).toBe("http://localhost/target");
    expect(payload.metadata.locationState[FLASH]).toEqual({ text: "paid" });
  });

  it("navigation: a prefetch answers the redirect too, so it is never kept", async () => {
    const res = await serve(makeRouter(), "/throw", {
      partial: { from: "/ok", prefetch: true },
    });
    expect(res.response.status).toBe(204);
    expect(res.response.headers.get("x-rsc-redirect")).toBe(
      "http://localhost/target",
    );
  });

  it("navigation: an ordinary boundary error still renders the boundary", async () => {
    const res = await serve(makeRouter(), "/boom", {
      partial: { from: "/ok" },
    });
    expect(res.response.status).toBe(200);
    // The boundary renders from the error row; only React knows the fallback.
    expect(res.flight).toMatch(/^\d+:E\{/m);
  });

  it("document: a form post whose re-render throws answers the 3xx", async () => {
    redirectAfterAction = false;
    const router = createRouter({ onError: vi.fn() }).routes(patternsAction);

    const res = await serveShellRequest(router, "/form", {
      cacheStore: new MemorySegmentCacheStore(),
      form: createActionForm(setRedirect, { id: "actions/form#set" }),
    });

    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("location")).toBe("/target");
  });

  it("action: a revalidation render that throws answers the Flight redirect", async () => {
    redirectAfterAction = false;
    const router = createRouter({ onError: vi.fn() }).routes(patternsAction);

    const res = await serveShellRequest(router, "/form", {
      cacheStore: new MemorySegmentCacheStore(),
      action: {
        ref: setRedirectAndAnswer,
        id: "actions/form#setAndAnswer",
        segments: ["L0", "L0R0"],
      },
    });

    // The page says where it goes: the call is answered with the redirect the
    // client follows, as a handler-thrown one is (the answer is superseded).
    expect(res.response.status).toBe(204);
    expect(res.response.headers.get("x-rsc-redirect")).toBe(
      "http://localhost/target",
    );
  });

  it("an explicit text/x-component document keeps the error row, reported", async () => {
    const onError = vi.fn();
    const router = createRouter({ onError }).routes(patterns);

    const res = await serveShellRequest(router, "/throw", {
      cacheStore: new MemorySegmentCacheStore(),
      headers: { accept: "text/x-component" },
    });

    expect(res.response.status).toBe(200);
    expect(res.response.headers.get("location")).toBeNull();
    expect(res.flight).toMatch(/^\d+:E\{/m);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("a redirect is never stored as a ppr route's shell", async () => {
    const router = createRouter({ onError: vi.fn() }).routes(patternsPpr);

    const res = await serve(router, "/shell-throw");

    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("location")).toBe("/target");
    // The capture refuses a render that reported anything (rsc/shell-capture.ts).
    expect(await res.readEntry()).toBeNull();
  });

  it("a healthy page renders unchanged", async () => {
    const res = await serve(makeRouter(), "/ok");
    expect(res.response.status).toBe(200);
    expect(res.flight).toContain("fine");
  });
});
