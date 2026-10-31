import { describe, expect, it, vi, afterEach } from "vitest";
import {
  carryLocationStateAcrossRedirect,
  consumeDocumentLocationState,
  documentLocationStateCookieName,
  markDocumentResponsePrivate,
} from "../document-location-state.js";
import type { LocationStateEntry } from "../../browser/react/location-state-shared.js";
import { markExternalRedirect } from "../../redirect-origin.js";

const COOKIE = "rango-state_app";
const SLOT = "__rsc_ls_mod#Flash";
const entry = (value: unknown): LocationStateEntry => ({
  __rsc_ls_key: SLOT,
  __rsc_ls_value: value,
});

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}

function carriedCookie(response: Response): string | undefined {
  return response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${COOKIE}-ls=`));
}

function fakeCtx(locationState?: LocationStateEntry[]) {
  const set: Array<{ name: string; value: string; options: unknown }> = [];
  return {
    ctx: {
      _locationState: locationState,
      setCookie(name: string, value: string, options?: unknown) {
        set.push({ name, value, options });
      },
    },
    set,
  };
}

function requestWithCookie(
  url: string,
  value: unknown,
  init: RequestInit = {},
): Request {
  const encoded = encodeURIComponent(
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return new Request(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      cookie: `${COOKIE}-ls=${encoded}`,
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("documentLocationStateCookieName", () => {
  it("adds the __Host- prefix only on https", () => {
    expect(documentLocationStateCookieName(COOKIE, false)).toBe(`${COOKIE}-ls`);
    expect(documentLocationStateCookieName(COOKIE, true)).toBe(
      `__Host-${COOKIE}-ls`,
    );
  });
});

describe("carryLocationStateAcrossRedirect", () => {
  const url = new URL("http://app.test/callback");

  it("writes the target pathname and the resolved slots", () => {
    const response = carryLocationStateAcrossRedirect(
      redirectTo("/done?x=1"),
      { _locationState: [entry({ text: "a" }), entry({ text: "b" })] },
      new Request(url),
      url,
      COOKIE,
    );

    const cookie = carriedCookie(response)!;
    const value = JSON.parse(
      decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!),
    );
    // Same definition twice: the last write wins, as on the client.
    expect(value).toEqual({ p: "/done", s: { [SLOT]: { text: "b" } } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rebuilds a redirect whose headers are immutable", () => {
    const original = Response.redirect("http://app.test/done", 303);
    const response = carryLocationStateAcrossRedirect(
      original,
      { _locationState: [entry(1)] },
      new Request(url),
      url,
      COOKIE,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://app.test/done");
    expect(carriedCookie(response)).toBeDefined();
  });

  it.each([
    ["a partial request", "http://app.test/callback?_rsc_partial=true"],
    ["an action request", "http://app.test/callback?_rsc_action=a"],
    ["a loader request", "http://app.test/callback?_rsc_loader=l"],
    ["a Flight fetch", "http://app.test/callback?__rsc"],
  ])("leaves %s alone (its redirect is a Flight payload)", (_label, href) => {
    const response = carryLocationStateAcrossRedirect(
      redirectTo("/done"),
      { _locationState: [entry(1)] },
      new Request(href),
      new URL(href),
      COOKIE,
    );
    expect(carriedCookie(response)).toBeUndefined();
  });

  it("leaves a response without state, a 200, a cross-origin and an external redirect alone", () => {
    const external = redirectTo("https://pay.example.com/x");
    markExternalRedirect(external);
    const cases: Array<[Response, LocationStateEntry[] | undefined]> = [
      [redirectTo("/done"), undefined],
      [new Response("ok"), [entry(1)]],
      [redirectTo("https://other.test/done"), [entry(1)]],
      [external, [entry(1)]],
    ];
    for (const [response, state] of cases) {
      const result = carryLocationStateAcrossRedirect(
        response,
        { _locationState: state },
        new Request(url),
        url,
        COOKIE,
      );
      expect(carriedCookie(result)).toBeUndefined();
      expect(result.headers.get("cache-control")).toBeNull();
    }
  });

  it("drops state JSON cannot serialize, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = carryLocationStateAcrossRedirect(
      redirectTo("/done"),
      { _locationState: [entry(10n)] },
      new Request(url),
      url,
      COOKIE,
    );
    expect(carriedCookie(response)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cannot be serialized as JSON"),
    );
  });

  it("warns in development about a value JSON does not keep as it is", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = carryLocationStateAcrossRedirect(
      redirectTo("/done"),
      { _locationState: [entry({ at: new Date(0) })] },
      new Request(url),
      url,
      COOKIE,
    );
    expect(carriedCookie(response)).toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(SLOT));
  });
});

describe("consumeDocumentLocationState", () => {
  it("seeds the slots of a cookie for this pathname and clears it", () => {
    const { ctx, set } = fakeCtx();
    consumeDocumentLocationState(
      ctx,
      requestWithCookie("http://app.test/done", {
        p: "/done",
        s: { [SLOT]: { text: "hi" } },
      }),
      new URL("http://app.test/done"),
      COOKIE,
    );

    expect(ctx._locationState).toEqual([entry({ text: "hi" })]);
    expect(set).toEqual([
      {
        name: `${COOKIE}-ls`,
        value: "",
        options: {
          path: "/",
          httpOnly: true,
          secure: false,
          sameSite: "lax",
          maxAge: 0,
        },
      },
    ]);
  });

  it.each([
    ["another pathname", "http://app.test/elsewhere", "GET"],
    ["a navigation", "http://app.test/done?_rsc_partial=true", "GET"],
    ["a HEAD request", "http://app.test/done", "HEAD"],
    ["a form POST to the target", "http://app.test/done", "POST"],
    ["a Flight fetch", "http://app.test/done?__rsc", "GET"],
  ])("leaves the cookie to %s", (_label, href, method) => {
    const { ctx, set } = fakeCtx();
    consumeDocumentLocationState(
      ctx,
      requestWithCookie(
        href,
        { p: "/done", s: { [SLOT]: 1 } },
        {
          method,
        },
      ),
      new URL(href),
      COOKIE,
    );
    expect(ctx._locationState).toBeUndefined();
    expect(set).toEqual([]);
  });

  it.each([
    [
      "a <link rel=prefetch>",
      { "sec-fetch-dest": "empty", "sec-purpose": "prefetch", accept: "*/*" },
    ],
    ["a same-path fetch()", { "sec-fetch-dest": "empty", accept: "*/*" }],
    ["an image request", { "sec-fetch-dest": "image" }],
  ])(
    "leaves the cookie to %s (Sec-Fetch-Dest not a navigation)",
    (_label, headers) => {
      const { ctx, set } = fakeCtx();
      consumeDocumentLocationState(
        ctx,
        requestWithCookie(
          "http://app.test/done",
          { p: "/done", s: { [SLOT]: 1 } },
          { headers },
        ),
        new URL("http://app.test/done"),
        COOKIE,
      );
      expect(ctx._locationState).toBeUndefined();
      expect(set).toEqual([]);
    },
  );

  it.each(["document", "iframe", "frame"])(
    "consumes the cookie on a navigation with Sec-Fetch-Dest: %s",
    (dest) => {
      const { ctx, set } = fakeCtx();
      consumeDocumentLocationState(
        ctx,
        requestWithCookie(
          "http://app.test/done",
          { p: "/done", s: { [SLOT]: 1 } },
          { headers: { "sec-fetch-dest": dest } },
        ),
        new URL("http://app.test/done"),
        COOKIE,
      );
      expect(ctx._locationState).toEqual([entry(1)]);
      expect(set).toHaveLength(1);
    },
  );

  it("lets a prefetch pass and the navigation after it consume the cookie", () => {
    const cookie = { p: "/done", s: { [SLOT]: { text: "hi" } } };
    const prefetch = fakeCtx();
    consumeDocumentLocationState(
      prefetch.ctx,
      requestWithCookie("http://app.test/done", cookie, {
        headers: { "sec-fetch-dest": "empty", "sec-purpose": "prefetch" },
      }),
      new URL("http://app.test/done"),
      COOKIE,
    );
    expect(prefetch.ctx._locationState).toBeUndefined();
    expect(prefetch.set).toEqual([]);

    const navigation = fakeCtx();
    consumeDocumentLocationState(
      navigation.ctx,
      requestWithCookie("http://app.test/done", cookie, {
        headers: { "sec-fetch-dest": "document" },
      }),
      new URL("http://app.test/done"),
      COOKIE,
    );
    expect(navigation.ctx._locationState).toEqual([entry({ text: "hi" })]);
    expect(navigation.set).toHaveLength(1);
  });

  it("clears a malformed cookie and seeds nothing", () => {
    for (const value of ["not json", { p: 1, s: {} }, { p: "/done" }]) {
      const { ctx, set } = fakeCtx();
      consumeDocumentLocationState(
        ctx,
        requestWithCookie("http://app.test/done", value),
        new URL("http://app.test/done"),
        COOKIE,
      );
      expect(ctx._locationState).toBeUndefined();
      expect(set).toHaveLength(1);
    }
  });

  it("reads the __Host- cookie on https", () => {
    const { ctx } = fakeCtx();
    const value = encodeURIComponent(
      JSON.stringify({ p: "/done", s: { [SLOT]: 1 } }),
    );
    consumeDocumentLocationState(
      ctx,
      new Request("https://app.test/done", {
        headers: {
          cookie: `${COOKIE}-ls=${value}; __Host-${COOKIE}-ls=${value}`,
        },
      }),
      new URL("https://app.test/done"),
      COOKIE,
    );
    expect(ctx._locationState).toEqual([entry(1)]);
  });
});

describe("carryLocationStateAcrossRedirect: an empty state list", () => {
  it("sets no cookie", () => {
    const url = new URL("http://app.test/callback");
    const response = carryLocationStateAcrossRedirect(
      redirectTo("/done"),
      { _locationState: [] },
      new Request(url),
      url,
      COOKIE,
    );
    expect(carriedCookie(response)).toBeUndefined();
  });
});

describe("carryLocationStateAcrossRedirect: a throwing lazy entry", () => {
  it("lets the redirect leave without state, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const url = new URL("http://app.test/callback");
    const response = carryLocationStateAcrossRedirect(
      redirectTo("/done"),
      {
        _locationState: [
          {
            __rsc_ls_key: SLOT,
            __rsc_ls_value: () => {
              throw new Error("getter failed");
            },
            __rsc_ls_lazy: true,
          },
        ],
      },
      new Request(url),
      url,
      COOKIE,
    );
    expect(response.status).toBe(302);
    expect(carriedCookie(response)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("getter failed"));
  });
});

describe("markDocumentResponsePrivate", () => {
  it("sets private, no-store only on a document that carries location state", () => {
    const marked = markDocumentResponsePrivate(
      new Response("doc", { headers: { "Cache-Control": "s-maxage=60" } }),
      { _documentLocationState: true },
    );
    expect(marked.headers.get("cache-control")).toBe("private, no-store");

    const plain = markDocumentResponsePrivate(
      new Response("doc", { headers: { "Cache-Control": "s-maxage=60" } }),
      {},
    );
    expect(plain.headers.get("cache-control")).toBe("s-maxage=60");
  });
});
