/**
 * Tests for redirect() — response construction, status codes, state propagation,
 * and dev warnings.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
  getLocationState,
} from "../../server/request-context.js";
import { redirect } from "../redirect.js";
import {
  EXTERNAL_REDIRECT_MARKER,
  isExternalRedirect,
} from "../../redirect-origin.js";
import type { LocationStateEntry } from "../../browser/react/location-state-shared.js";

/** Minimal location state entry for testing. */
function fakeEntry(key: string, value: unknown): LocationStateEntry {
  return { __rsc_ls_key: key, __rsc_ls_value: value };
}

/** Run `fn` inside a RequestContext built from `opts`, return the context. */
function withContext(
  opts: { url?: string; headers?: Record<string, string> },
  fn: () => void,
) {
  const url = new URL(opts.url ?? "https://example.com");
  const ctx = createRequestContext({
    env: {},
    request: new Request(url, { headers: opts.headers }),
    url,
    variables: {},
  });
  runWithRequestContext(ctx, fn);
  return ctx;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redirect()", () => {
  it("returns a 302 Response by default", () => {
    const res = redirect("/target");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/target");
    expect(res.headers.get("X-RSC-Redirect")).toBe("soft");
  });

  it("accepts a numeric status override", () => {
    expect(redirect("/target", 301).status).toBe(301);
    expect(redirect("/target", 303).status).toBe(303);
  });

  it("accepts an options object with status", () => {
    const res = redirect("/target", { status: 307 });
    expect(res.status).toBe(307);
  });

  describe("external opt-in", () => {
    // The opt-in is an out-of-band brand on the Response object (a WeakSet
    // membership), NOT a wire header -- a header would be forgeable by an
    // attacker-controlled upstream response. No external wire header is ever set.
    it("does NOT brand or set any external wire header by default", () => {
      const relative = redirect("/target");
      expect(isExternalRedirect(relative)).toBe(false);
      expect(relative.headers.get(EXTERNAL_REDIRECT_MARKER)).toBeNull();

      const absolute = redirect("https://accounts.example.com/oauth");
      expect(isExternalRedirect(absolute)).toBe(false);
      expect(absolute.headers.get(EXTERNAL_REDIRECT_MARKER)).toBeNull();
    });

    it("brands the Response when external: true (no wire header)", () => {
      const res = redirect("https://accounts.example.com/oauth", {
        external: true,
      });
      expect(isExternalRedirect(res)).toBe(true);
      // The opt-in never rides a wire header.
      expect(res.headers.get(EXTERNAL_REDIRECT_MARKER)).toBeNull();
      expect(res.headers.get("Location")).toBe(
        "https://accounts.example.com/oauth",
      );
    });

    it("does not brand when external is false", () => {
      const res = redirect("/target", { external: false });
      expect(isExternalRedirect(res)).toBe(false);
      expect(res.headers.get(EXTERNAL_REDIRECT_MARKER)).toBeNull();
    });
  });

  describe("state", () => {
    it("sets location state on the request context", () => {
      const ctx = withContext({}, () => {
        redirect("/target", {
          state: [fakeEntry("flash", { text: "saved" })],
        });
      });

      expect(ctx._locationState).toHaveLength(1);
      expect(ctx._locationState![0].__rsc_ls_key).toBe("flash");
      expect(ctx._locationState![0].__rsc_ls_value).toEqual({ text: "saved" });
    });

    it("accumulates multiple state entries", () => {
      const ctx = withContext({}, () => {
        redirect("/target", {
          state: [fakeEntry("flash", "msg1"), fakeEntry("info", "msg2")],
        });
      });

      expect(ctx._locationState).toHaveLength(2);
      expect(ctx._locationState![0].__rsc_ls_key).toBe("flash");
      expect(ctx._locationState![1].__rsc_ls_key).toBe("info");
    });

    it("state is readable via getLocationState() inside context", () => {
      withContext({}, () => {
        redirect("/target", {
          state: [fakeEntry("flash", { text: "saved" })],
        });

        const state = getLocationState();
        expect(state).toHaveLength(1);
        expect(state![0].__rsc_ls_value).toEqual({ text: "saved" });
      });
    });

    it("does NOT set location state when no state option is provided", () => {
      const ctx = withContext({}, () => {
        redirect("/target");
      });

      expect(ctx._locationState).toBeUndefined();
    });
  });

  describe("dev warning", () => {
    it("warns on full-page SSR request (no _rsc_partial, no action headers)", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const ctx = withContext({ url: "https://example.com/" }, () => {
        redirect("/target", {
          state: [fakeEntry("flash", { text: "saved" })],
        });
      });

      // State is still set even though the warning fires
      expect(ctx._locationState).toHaveLength(1);
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0]).toContain("full-page (SSR) request");
    });

    it("does NOT warn on SPA partial request (_rsc_partial)", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const ctx = withContext(
        { url: "https://example.com/?_rsc_partial" },
        () => {
          redirect("/target", {
            state: [fakeEntry("flash", { text: "saved" })],
          });
        },
      );

      expect(ctx._locationState).toHaveLength(1);
      expect(spy).not.toHaveBeenCalled();
    });

    it("does NOT warn on server action request (rsc-action header)", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const ctx = withContext(
        {
          url: "https://example.com/",
          headers: { "rsc-action": "abc123" },
        },
        () => {
          redirect("/target", {
            state: [fakeEntry("flash", { text: "saved" })],
          });
        },
      );

      expect(ctx._locationState).toHaveLength(1);
      expect(spy).not.toHaveBeenCalled();
    });

    it("does NOT warn on server action request (_rsc_action param)", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const ctx = withContext(
        { url: "https://example.com/?_rsc_action=abc123" },
        () => {
          redirect("/target", {
            state: [fakeEntry("flash", { text: "saved" })],
          });
        },
      );

      expect(ctx._locationState).toHaveLength(1);
      expect(spy).not.toHaveBeenCalled();
    });

    it("does NOT warn when no state is provided", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

      redirect("/target");
      redirect("/target", 302);

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("basename auto-prefix", () => {
    /** Run redirect() under a configured basename and return the Location header. */
    function locationUnderBasename(
      basename: string,
      url: string,
    ): string | null {
      const reqUrl = new URL("https://example.com" + url);
      const ctx = createRequestContext({
        env: {},
        request: new Request(reqUrl),
        url: reqUrl,
        variables: {},
      });
      ctx._basename = basename;
      return runWithRequestContext(ctx, () =>
        redirect(url).headers.get("Location"),
      );
    }

    it("prefixes a bare app-local path", () => {
      expect(locationUnderBasename("/admin", "/users")).toBe("/admin/users");
    });

    it("does not double-prefix an already-prefixed path", () => {
      expect(locationUnderBasename("/admin", "/admin/users")).toBe(
        "/admin/users",
      );
    });

    it("does not double-prefix the basename followed directly by a query", () => {
      expect(locationUnderBasename("/admin", "/admin?tab=x")).toBe(
        "/admin?tab=x",
      );
    });

    it("does not double-prefix the basename followed directly by a fragment", () => {
      expect(locationUnderBasename("/admin", "/admin#frag")).toBe(
        "/admin#frag",
      );
    });

    it("maps the basename itself unchanged", () => {
      expect(locationUnderBasename("/admin", "/admin")).toBe("/admin");
    });
  });
});
