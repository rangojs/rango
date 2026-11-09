/**
 * A redirect() an async server component throws, after its handler returned,
 * reaches the visitor as a redirect, not the error page: its Flight error row
 * carries the redirect (render-redirect.ts), which the SSR shell error answer
 * turns into a 3xx and the router's client boundaries into a replace
 * navigation (redirectSignalOf). Served through serveShellRequest, the
 * production handler; each payload is decoded as the browser decodes it and
 * every error it holds is read with redirectSignalOf, as the boundaries read
 * it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { Suspense } from "react";

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
import {
  createLocationState,
  createLoader,
  createRouter,
  redirect,
  urls,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { redirectSignalOf } from "../../decode-loader-results.js";
import { serveEveryShape } from "./helpers/response-shapes.js";
import { gate, getCachedGate } from "./fixtures/component-redirect-data.js";

const LOGIN = { to: "http://localhost/login", status: 302 };

const LAZY = Symbol.for("react.lazy");
const ELEMENT = Symbol.for("react.transitional.element");

/**
 * Every error a decoded payload holds, in the order a render meets it: the
 * rejected lazies and promises Flight decoded from error rows.
 */
async function decodedErrors(flight: string | undefined): Promise<unknown[]> {
  if (!flight) return [];
  const errors: unknown[] = [];
  const seen = new Set<unknown>();
  const walk = async (node: unknown): Promise<void> => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) await walk(child);
      return;
    }
    const record = node as Record<string | symbol, any>;
    if (record.$$typeof === LAZY) {
      try {
        await walk(await record._payload);
      } catch (error) {
        errors.push(error);
      }
      return;
    }
    if (record.$$typeof === ELEMENT) {
      await walk(record.props);
      return;
    }
    if (typeof record.then === "function") {
      try {
        await walk(await record);
      } catch (error) {
        errors.push(error);
      }
      return;
    }
    for (const key of Object.keys(record)) await walk(record[key]);
  };
  await walk(await deserializeResult(flight));
  return errors;
}

/** What the router's boundaries make of each error in a payload. */
async function redirectsIn(flight: string | undefined): Promise<unknown[]> {
  return (await decodedErrors(flight)).map(
    (error) => redirectSignalOf(error) ?? "not a redirect",
  );
}

const PageLoader = createLoader(async () => "loaded");
const Flash = createLocationState<{ text: string }>({ flash: true });

async function GateWithState(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("/login", { state: Flash({ text: "sign in first" }) });
}

async function GateTemporary(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("/login", 307);
}

async function GateExternal(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("https://accounts.example.com/sign-in", { external: true });
}

async function GateOffOrigin(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw redirect("https://evil.example.com/");
}

async function Broken(): Promise<React.ReactNode> {
  await Promise.resolve();
  throw new Error("not a redirect");
}

const Gate = gate.Component;

async function signOut(): Promise<void> {
  gate.signedIn = false;
}

function AccountPage(): React.ReactNode {
  return (
    <main>
      <h1>Account</h1>
      <Gate />
    </main>
  );
}

function makeRouter(options: { basename?: string } = {}) {
  return createRouter(options).routes(
    urls(({ path, layout, parallel, intercept, loading, loader, cache }) => [
      path("/", () => <p>home</p>, { name: "home" }),
      path("/login", () => <p>login</p>, { name: "login" }),
      path("/account", AccountPage, { name: "account" }),
      layout(
        () => (
          <section>
            <Gate />
          </section>
        ),
        () => [path("/in-layout", () => <p>child</p>, { name: "inLayout" })],
      ),
      layout(
        () => <section>shell</section>,
        () => [
          parallel({ "@side": () => <Gate /> }),
          path("/in-slot", () => <p>child</p>, { name: "inSlot" }),
        ],
      ),
      path(
        "/own-slot",
        () => <p>own</p>,
        { name: "ownSlot" },
        () => [parallel({ "@side": () => <Gate /> })],
      ),
      path(
        "/streamed",
        async () => <Gate />,
        { name: "streamed" },
        () => [loading(<p>loading</p>)],
      ),
      path(
        "/suspense",
        () => (
          <Suspense fallback={<p>pending</p>}>
            <Gate />
          </Suspense>
        ),
        { name: "suspense" },
      ),
      path(
        "/with-loader",
        () => <Gate />,
        { name: "withLoader" },
        () => [loader(PageLoader)],
      ),
      cache({ ttl: 300 }, () => [
        path("/cached", AccountPage, { name: "cached" }),
      ]),
      path("/ppr", AccountPage, { name: "ppr", ppr: true }),
      path("/use-cache", async () => <main>{await getCachedGate()}</main>, {
        name: "useCache",
      }),
      layout(
        () => <section>list</section>,
        () => [
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path("/item/:id", () => <article>item</article>, { name: "item" }),
          path("/other/:id", () => <article>other</article>, {
            name: "other",
          }),
          intercept("@modal", ".item", () => <Gate />),
          intercept("@modal", ".other", () => <Gate />),
        ],
      ),
      path("/state", () => <GateWithState />, { name: "state" }),
      path("/temporary", () => <GateTemporary />, { name: "temporary" }),
      path("/external", () => <GateExternal />, { name: "external" }),
      path("/off-origin", () => <GateOffOrigin />, { name: "offOrigin" }),
      path("/broken", () => <Broken />, { name: "broken" }),
    ]),
  );
}

beforeEach(async () => {
  gate.signedIn = false;
  gate.runs = 0;
  await resetShellTestState();
});

describe("a server component's redirect() reaches the visitor as a redirect", () => {
  it("the reported page: its document and a client navigation to it both carry the redirect", async () => {
    const router = makeRouter();

    const document = await serveShellRequest(router, "/account");
    const navigation = await serveShellRequest(router, "/account", {
      partial: { from: "/" },
    });

    expect(await redirectsIn(document.flight)).toEqual([LOGIN]);
    expect(await redirectsIn(navigation.flight)).toEqual([LOGIN]);
  });

  it("a signed-in visitor sees the page", async () => {
    gate.signedIn = true;
    const result = await serveShellRequest(makeRouter(), "/account");

    expect(await decodedErrors(result.flight)).toEqual([]);
    expect(result.flight).toContain("summary");
  });

  const kinds: Array<[string, string, string, { next: string }?]> = [
    ["a route handler's tree", "/", "/account"],
    ["a layout's tree", "/", "/in-layout"],
    ["a parallel slot under a layout", "/", "/in-slot"],
    ["a route's own parallel slot", "/", "/own-slot"],
    ["a handler streamed behind loading()", "/", "/streamed"],
    ["a component inside <Suspense>", "/", "/suspense"],
    ["a route with a loader", "/", "/with-loader"],
    ["a route under cache()", "/", "/cached"],
    ["a ppr route", "/", "/ppr"],
    ['a "use cache" tree', "/", "/use-cache"],
    ["an intercept", "/list", "/item/1", { next: "/other/2" }],
  ];

  for (const [kind, from, to, intercept] of kinds) {
    it(`${kind}: every shape it is served in, stored or not, carries it`, async () => {
      const shapes = await serveEveryShape(makeRouter(), {
        from,
        to,
        ...(intercept && { intercept }),
      });

      const served: Record<string, unknown[]> = {};
      for (const { name, result } of shapes) {
        if (name.startsWith("document from")) continue;
        // An intercept's own document is the plain route: no gate there.
        if (intercept && name.startsWith("document to")) continue;
        served[name] = await redirectsIn(result.flight);
      }
      expect(Object.keys(served).length).toBeGreaterThan(0);
      for (const name of Object.keys(served)) {
        expect([name, served[name]]).toEqual([name, [LOGIN]]);
      }
    });
  }

  it("keeps the redirect's state and status", async () => {
    const router = makeRouter();

    const state = await serveShellRequest(router, "/state");
    const temporary = await serveShellRequest(router, "/temporary");

    expect(await redirectsIn(state.flight)).toEqual([
      {
        ...LOGIN,
        state: { [Flash.__rsc_ls_key]: { text: "sign in first" } },
      },
    ]);
    expect(await redirectsIn(temporary.flight)).toEqual([
      { ...LOGIN, status: 307 },
    ]);
  });

  it("keeps the basename", async () => {
    const router = makeRouter({ basename: "/app" });

    const result = await serveShellRequest(router, "/app/account", {
      partial: { from: "/app" },
    });

    expect(await redirectsIn(result.flight)).toEqual([
      { to: "http://localhost/app/login", status: 302 },
    ]);
  });

  it("goes off-origin only on the external opt-in, as every other redirect", async () => {
    const router = makeRouter();

    const external = await serveShellRequest(router, "/external");
    const offOrigin = await serveShellRequest(router, "/off-origin");

    expect(await redirectsIn(external.flight)).toEqual([
      { to: "https://accounts.example.com/sign-in", status: 302 },
    ]);
    expect(await redirectsIn(offOrigin.flight)).toEqual([
      { to: "/", status: 302 },
    ]);
  });

  it("the page an action re-renders, JS and no-JS, carries it too", async () => {
    gate.signedIn = true;
    const router = makeRouter();
    const page = await serveShellRequest(router, "/account", {
      partial: { from: "/" },
    });
    const matched = (
      (await deserializeResult(page.flight!)) as {
        metadata: { matched: string[] };
      }
    ).metadata.matched;

    const action = await serveShellRequest(router, "/account", {
      action: {
        ref: signOut,
        id: "actions/session#signOut",
        segments: matched,
      },
    });
    gate.signedIn = true;
    const form = await serveShellRequest(router, "/account", {
      form: createActionForm(signOut, {
        id: "actions/session#signOutForm",
        useActionState: false,
      }),
    });

    expect(await redirectsIn(action.flight)).toEqual([LOGIN]);
    expect(await redirectsIn(form.flight)).toEqual([LOGIN]);
  });

  it("an error that is not a redirect stays an error", async () => {
    const result = await serveShellRequest(makeRouter(), "/broken");

    expect(await redirectsIn(result.flight)).toEqual(["not a redirect"]);
  });
});

describe("a component's redirect() is never stored", () => {
  for (const [label, url] of [
    ["cache()", "/cached"],
    ["ppr", "/ppr"],
    ['"use cache"', "/use-cache"],
  ] as const) {
    for (const partial of [undefined, { from: "/" }]) {
      it(`${label}, ${partial ? "client navigation" : "document"}: the next signed-in visitor gets the page`, async () => {
        const router = makeRouter();
        const options = {
          cacheStore: new MemorySegmentCacheStore(),
          partial,
          cacheProfiles: { default: { ttl: 300 } },
        };

        const signedOut = await serveShellRequest(router, url, options);
        await new Promise((resolve) => setTimeout(resolve, 20));
        gate.signedIn = true;
        const signedIn = await serveShellRequest(router, url, options);

        expect(await redirectsIn(signedOut.flight)).toEqual([LOGIN]);
        expect(await decodedErrors(signedIn.flight)).toEqual([]);
        expect(signedIn.flight).toContain("summary");
      });
    }
  }
});

describe("a component's redirect() is control flow", () => {
  it("is neither reported to onError nor printed", async () => {
    const onError = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const router = createRouter({ onError }).routes(
        urls(({ path }) => [path("/account", AccountPage, { name: "a" })]),
      );

      await serveShellRequest(router, "/account");
      await serveShellRequest(router, "/account", { partial: true });

      expect(onError).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
