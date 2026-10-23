/**
 * Response output: the stub Response that middleware, handlers and the router
 * write headers, cookies and status to, and that the handler merges into the
 * response it sends (rsc/helpers.ts). createRequestContext builds the
 * request's sink. A render pass that must not write the response (the
 * background re-render of a stale route record, RENDER_PASS_FIELDS in
 * server/render-pass.ts) gets a discarding sink: the same writers and guards
 * over a response nothing sends.
 */
import type { CookieOptions } from "../router/middleware.js";
import {
  KEEP_CACHE_HEADER,
  getRawCookieValue,
  mintStateValue,
  serializeStateCookie,
} from "../browser/cookie-name.js";
import type { RouterVersions } from "../router-versions.js";
import type { Theme, ResolvedThemeConfig } from "../theme/types.js";
import {
  THEME_COOKIE,
  isValidTheme,
  warnInvalidTheme,
} from "../theme/constants.js";
import { assertNotInsideCacheExec } from "../cache/taint.js";
import { assertCachedHeaderWriteAllowed } from "./context.js";
import { requestHeaders } from "./request-headers.js";
import { defineSlot, slotAccessor } from "./slot-accessors.js";
import type { RequestContext } from "./request-context.js";

/** The request context's response writers, and what they write to. */
export interface ResponseSink extends Pick<
  RequestContext<any, any>,
  | "header"
  | "setCookie"
  | "deleteCookie"
  | "setStatus"
  | "_setStatus"
  | "setTheme"
  | "_rotateStateCookie"
  | "_setKeepCacheDirective"
  | "_setFreshReadsCookie"
> {
  /** The stub response the writers build: `ctx.res`. */
  readonly response: () => Response;
  /** Set-Cookie writes by name, null for a deletion: the effective cookie reads. */
  readonly cookieWrites: () => ReadonlyMap<string, string | null>;
}

/** The request's sink: createRequestContext. */
export interface RequestSinkInit {
  readonly discard?: undefined;
  /**
   * The context the writers act for: its "use cache" argument stamp guards
   * them, and its `_responseSent` gates the fresh-reads cookie.
   */
  readonly owner: () => RequestContext<any, any>;
  readonly request: Request;
  readonly url: URL;
  readonly cookieHeader: string | null;
  /** Seeds the stub's status and headers. */
  readonly initialResponse: Response | undefined;
  readonly themeConfig: ResolvedThemeConfig | null | undefined;
  readonly stateCookieName: string | undefined;
  readonly freshCookieName: string | undefined;
  readonly versions: RouterVersions | undefined;
}

/**
 * A sink for no request: no argument stamp to read, no state or fresh-reads
 * cookie to write. Its other writers and their guards are the request's.
 */
export interface DiscardingSinkInit {
  readonly discard: true;
  readonly themeConfig: ResolvedThemeConfig | null | undefined;
}

export type ResponseSinkInit = RequestSinkInit | DiscardingSinkInit;

const NODE_INSPECT = Symbol.for("nodejs.util.inspect.custom");

export function createResponseSink(init: ResponseSinkInit): ResponseSink {
  const live = init.discard ? undefined : init;
  const owner = live?.owner;
  const themeConfig = init.themeConfig;
  const stateCookieName = live?.stateCookieName;
  const freshCookie = live?.freshCookieName;
  const initialResponse = live?.initialResponse;
  let rangoStateRotated = false;
  let freshCookieMaxAge = 0;

  let stubResponse = initialResponse
    ? new Response(null, {
        status: initialResponse.status,
        statusText: initialResponse.statusText,
        headers: new Headers(initialResponse.headers),
      })
    : new Response(null, { status: 200 });

  // The #713 choke point: `rawStubHeaders` is the stub's REAL Headers; the
  // proxy below is the only view reachable from consumer code, and its
  // mutating methods consult the cached-scope guard first. shadowStubHeaders
  // shadows `headers` on the stub Response INSTANCE (a real Response, not a
  // facade — safe to hand to the platform), so every surface that ends in a
  // stub-header mutation — ctx.header/setCookie/deleteCookie, ctx.setTheme,
  // the handler ctx.headers proxy, and raw `ctx.res.headers.set(...)` — is
  // guarded at the mutation itself, not per enumerated wrapper. Guard-exempt
  // internal writers (_rotateStateCookie, _setKeepCacheDirective,
  // _setFreshReadsCookie — serve machinery, documented callable from
  // loaders/during capture) write to rawStubHeaders directly. The serve/commit path's stub reads and its
  // Set-Cookie drain (rsc/helpers.ts) run outside any latched funnel scope,
  // where assertCachedHeaderWriteAllowed is a no-op.
  let rawStubHeaders = stubResponse.headers;
  // Node's util.inspect unwraps this Proxy and calls undici's Headers hook
  // with the proxy as `this`. That reads `#headersList` and throws (#1000).
  // Inspect does not consult the get trap, so the hook is an own property of
  // the target and formats `rawStubHeaders`. Read on each call: setStatus
  // rebinds that let to a new Headers.
  const guardedStubHeaders: Headers = new Proxy(new Headers(), {
    get(_target, prop) {
      const raw = rawStubHeaders;
      const value = Reflect.get(raw, prop) as unknown;
      if (typeof value !== "function") return value;
      if (prop === "set" || prop === "append" || prop === "delete") {
        return (...args: unknown[]) => {
          assertCachedHeaderWriteAllowed("response headers", prop);
          return (value as (...a: unknown[]) => unknown).apply(raw, args);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(raw);
    },
  });
  Object.defineProperty(guardedStubHeaders, NODE_INSPECT, {
    value(...args: unknown[]): unknown {
      const hook = (rawStubHeaders as unknown as Record<symbol, unknown>)[
        NODE_INSPECT
      ];
      if (typeof hook === "function") return hook.apply(rawStubHeaders, args);
      // DOM Headers has forEach and not entries. Node always has the hook above.
      const listed: Record<string, string> = {};
      rawStubHeaders.forEach((value, key) => {
        listed[key] = value;
      });
      return listed;
    },
    configurable: true,
    writable: true,
  });
  const shadowStubHeaders = (res: Response): void => {
    Object.defineProperty(res, "headers", {
      value: guardedStubHeaders,
      enumerable: true,
      configurable: true,
    });
  };
  shadowStubHeaders(stubResponse);
  // Rebuild the stub with a new status, re-shadowing the fresh instance
  // (the Response constructor copies rawStubHeaders into new raw Headers).
  const replaceStubStatus = (status: number): void => {
    stubResponse = new Response(null, { status, headers: rawStubHeaders });
    rawStubHeaders = stubResponse.headers;
    shadowStubHeaders(stubResponse);
  };

  let responseCookieCache: Map<string, string | null> | null = null;
  const getResponseCookies = (): Map<string, string | null> => {
    if (!responseCookieCache) {
      responseCookieCache = parseResponseCookies(stubResponse);
    }
    return responseCookieCache;
  };
  const invalidateResponseCookieCache = () => {
    responseCookieCache = null;
  };

  return {
    setCookie(name: string, value: string, options?: CookieOptions): void {
      assertNotInsideCacheExec(owner?.(), "setCookie");
      stubResponse.headers.append(
        "Set-Cookie",
        serializeCookieValue(name, value, options),
      );
      invalidateResponseCookieCache();
    },

    deleteCookie(
      name: string,
      options?: Pick<CookieOptions, "domain" | "path">,
    ): void {
      assertNotInsideCacheExec(owner?.(), "deleteCookie");
      stubResponse.headers.append(
        "Set-Cookie",
        serializeCookieValue(name, "", { ...options, maxAge: 0 }),
      );
      invalidateResponseCookieCache();
    },

    header(name: string, value: string): void {
      assertNotInsideCacheExec(owner?.(), "header");
      stubResponse.headers.set(name, value);
    },

    // Rotate the rango state cookie for the responding client (the server seat
    // of invalidateClientCache). Writes ONE Set-Cookie per request with the
    // value {version}:{timestamp}; the `:` stays raw (the cookie-name.ts
    // serializer), not the URL-encoded form serializeCookieValue would produce.
    // The timestamp is strictly greater than the client's current one (inbound
    // X-Rango-State), so a same-millisecond server rotation still differs from
    // the client value and the divergence observer fires.
    _rotateStateCookie(): void {
      if (rangoStateRotated) return;
      rangoStateRotated = true;
      if (!live || !stateCookieName) return;
      // The client's current value, for the monotonic guard: prefer the
      // X-Rango-State header (router navigation/prefetch fetches send it), but
      // fall back to the request's rango state cookie — action POSTs / plain
      // app fetch()s carry no router header yet DO send the cookie. Without the
      // fallback, prevTs stays 0 and a same-ms mint can equal the client value,
      // leaving the divergence observer silent. `|| null` so an empty header
      // ('' from proxy normalization) falls through instead of short-circuiting.
      // getRawCookieValue reads the cookie undecoded (the wire value
      // decodeStateValue decodes exactly once) AND is the same parser the client
      // mirror uses, so both seats read the same jar entry.
      const prevRaw =
        (requestHeaders(live.request).get("x-rango-state") || null) ??
        getRawCookieValue(live.cookieHeader, stateCookieName);
      const value = mintStateValue(live.versions?.document ?? "0", prevRaw);
      // rawStubHeaders: guard-exempt internal writer — invalidateClientCache()
      // is documented callable from loaders and during shell capture.
      rawStubHeaders.append(
        "Set-Cookie",
        serializeStateCookie(
          stateCookieName,
          value,
          live.url.protocol === "https:",
        ),
      );
      invalidateResponseCookieCache();
    },

    // Set the keepClientCache() directive header. The action bridge reads it on
    // the response and suppresses its automatic invalidation. `.set` makes this
    // idempotent (one header regardless of call count). rawStubHeaders:
    // guard-exempt internal writer.
    _setKeepCacheDirective(): void {
      rawStubHeaders.set(KEEP_CACHE_HEADER, "1");
    },

    // The fresh-reads cookie (browser/cookie-name.ts): one Set-Cookie per
    // response, the longest Max-Age any invalidation asked for. HttpOnly (the
    // client never reads it), SameSite=Lax, Path=/. rawStubHeaders: an
    // internal writer, allowed wherever updateTag()/revalidateTag() are. A
    // shared cache never stores it (Set-Cookie is a per-client signal).
    _setFreshReadsCookie(maxAgeMs: number): void {
      if (!live || !freshCookie) return;
      const maxAge = Math.ceil(maxAgeMs / 1000);
      // Already set for at least this long (an earlier invalidation in this
      // request): nothing to add, sent or not.
      if (maxAge <= freshCookieMaxAge) return;
      if (live.owner()._responseSent) {
        // A streaming loader or render: the headers already left. The
        // invalidation itself still ran; only the mutating user's bypass of
        // the stores' isolate memos is lost.
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            `[rango] updateTag()/revalidateTag() ran after the response ` +
              `headers were sent (from a streaming loader or render), so the ` +
              `${freshCookie} cookie was not set: this user's next requests ` +
              `can be served from a store's isolate memo for a few seconds. ` +
              `Invalidate in a server action, a route handler, or middleware.`,
          );
        }
        return;
      }
      const serialized = (age: number) =>
        `${freshCookie}=1; Max-Age=${age}; Path=/; HttpOnly; SameSite=Lax` +
        (live.url.protocol === "https:" ? "; Secure" : "");
      if (freshCookieMaxAge > 0) {
        const prior = serialized(freshCookieMaxAge);
        const kept = rawStubHeaders
          .getSetCookie()
          .filter((cookie) => cookie !== prior);
        rawStubHeaders.delete("Set-Cookie");
        for (const cookie of kept) rawStubHeaders.append("Set-Cookie", cookie);
      }
      freshCookieMaxAge = maxAge;
      rawStubHeaders.append("Set-Cookie", serialized(maxAge));
      invalidateResponseCookieCache();
    },

    setStatus(status: number): void {
      assertNotInsideCacheExec(owner?.(), "setStatus");
      // Not a Headers mutation (it rebuilds the stub), so it cannot ride the
      // guarded-headers choke point above: same #713 guard, enumerated.
      assertCachedHeaderWriteAllowed("ctx", "setStatus");
      replaceStubStatus(status);
    },

    _setStatus(status: number): void {
      replaceStubStatus(status);
    },

    setTheme: themeConfig
      ? (theme: Theme): void => {
          assertNotInsideCacheExec(owner?.(), "setTheme");
          // Shared guard (isValidTheme): reject any value not in the configured
          // theme set, AND reject "system" when system detection is off — a
          // cookie of theme=system with enableSystem:false would re-apply a
          // bogus class="system" on the next SSR.
          if (!isValidTheme(theme, themeConfig)) {
            warnInvalidTheme(theme, themeConfig);
            return;
          }
          stubResponse.headers.append(
            "Set-Cookie",
            serializeCookieValue(themeConfig.storageKey, theme, {
              path: THEME_COOKIE.path,
              maxAge: THEME_COOKIE.maxAge,
              sameSite: THEME_COOKIE.sameSite,
            }),
          );
          invalidateResponseCookieCache();
        }
      : undefined,

    response: () => stubResponse,
    cookieWrites: getResponseCookies,
  };
}

// The request context's `res` accessor: shared descriptors (slot-accessors.ts).
const RES_SLOT: unique symbol = Symbol("rango.requestContext.res");

const RES_DESCRIPTOR: PropertyDescriptor = {
  ...slotAccessor(RES_SLOT, true),
  set(_: Response): void {
    throw new Error(
      "ctx.res is read-only. Use ctx.header() to set response headers, or cookies() for cookie mutations.",
    );
  },
};

/**
 * Define `ctx.res` as an own accessor that reads `get`. Assigning it throws
 * the read-only error. A context derived from another (Object.create) gets
 * its own response this way; copying the descriptor would read the
 * prototype's slot.
 */
export function bindRes(
  ctx: RequestContext<any, any>,
  get: () => Response,
): void {
  defineSlot(ctx, RES_SLOT, get);
  Object.defineProperty(ctx, "res", RES_DESCRIPTOR);
}

/**
 * Point a derived render pass's response writers and `res` at `sink`. Named
 * stores: a keyed copy can leave the pass in V8 dictionary mode (#1109).
 * `_setFreshReadsCookie` is not rebound: the pass's invalidations still set
 * the request's fresh-reads cookie.
 */
export function bindResponseSink(
  pass: RequestContext<any, any>,
  sink: ResponseSink,
): void {
  pass.header = sink.header;
  pass.setCookie = sink.setCookie;
  pass.deleteCookie = sink.deleteCookie;
  pass.setStatus = sink.setStatus;
  pass._setStatus = sink._setStatus;
  pass.setTheme = sink.setTheme;
  pass._rotateStateCookie = sink._rotateStateCookie;
  pass._setKeepCacheDirective = sink._setKeepCacheDirective;
  bindRes(pass, sink.response);
}

// Capture the Max-Age value so it can be parsed numerically. A leading zero
// (Max-Age=05) is a non-zero lifetime, not a deletion; only a value that parses
// to <= 0 marks a cookie for deletion. Pattern-matching a leading "0" misread
// zero-prefixed values like 05 / 010 as deletions.
const MAX_AGE_RE = /;\s*Max-Age\s*=\s*(-?\d+)/i;

function isCookieDeletion(header: string): boolean {
  const m = MAX_AGE_RE.exec(header);
  if (!m) return false;
  return Number(m[1]) <= 0;
}

function parseResponseCookies(response: Response): Map<string, string | null> {
  const result = new Map<string, string | null>();
  const setCookies = response.headers.getSetCookie();

  for (const header of setCookies) {
    const semiIdx = header.indexOf(";");
    const pair = semiIdx === -1 ? header : header.substring(0, semiIdx);
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) continue;

    let name: string;
    let value: string;
    try {
      name = decodeURIComponent(pair.substring(0, eqIdx).trim());
      value = decodeURIComponent(pair.substring(eqIdx + 1).trim());
    } catch {
      continue;
    }

    const isDeleted = isCookieDeletion(header);
    result.set(name, isDeleted ? null : value);
  }

  return result;
}

/** Reject CR/LF/;/,/whitespace/control so raw attribute interpolation cannot inject. */
function assertSafeCookieAttribute(
  value: string,
  label: "domain" | "path",
): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || value[i] === ";" || value[i] === ",") {
      throw new Error(
        label === "domain" ? "invalid cookie domain" : "invalid cookie path",
      );
    }
  }
}

export function serializeCookieValue(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;

  if (options.domain) {
    assertSafeCookieAttribute(options.domain, "domain");
    cookie += `; Domain=${options.domain}`;
  }
  if (options.path) {
    if (!options.path.startsWith("/")) {
      throw new Error("invalid cookie path");
    }
    assertSafeCookieAttribute(options.path, "path");
    cookie += `; Path=${options.path}`;
  }
  if (options.maxAge !== undefined) {
    // Safe integer: Number.isInteger(1e21) is true but stringifies as "1e+21",
    // which is invalid Max-Age wire syntax. Number.isSafeInteger rejects that.
    if (
      typeof options.maxAge !== "number" ||
      !Number.isSafeInteger(options.maxAge)
    ) {
      throw new Error("invalid cookie maxAge");
    }
    cookie += `; Max-Age=${options.maxAge}`;
  }
  if (options.expires) cookie += `; Expires=${options.expires.toUTCString()}`;
  if (options.httpOnly) cookie += "; HttpOnly";
  if (options.secure) cookie += "; Secure";
  if (options.sameSite) {
    if (
      options.sameSite !== "strict" &&
      options.sameSite !== "lax" &&
      options.sameSite !== "none"
    ) {
      throw new Error("invalid cookie sameSite");
    }
    cookie += `; SameSite=${options.sameSite}`;
  }

  return cookie;
}
