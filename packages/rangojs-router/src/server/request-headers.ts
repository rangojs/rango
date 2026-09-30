/**
 * The guarded `ctx.request.headers` (#976) and the router's raw reads.
 *
 * The Request the router hands to user code (handler, middleware and loader
 * `ctx.request`, `getRequestContext().request`) carries an own `headers`
 * getter that shadows the prototype's and runs the identity guard
 * (cookie-store.ts guardRequestHeaders). A Proxy around the Request is not an
 * option: `fetch(request)`, `new Request(request)` and `request.clone()` read
 * the platform's internal slots, which a Proxy does not have. The own getter
 * keeps the object a real Request, and those operations never call it.
 */

/** The Headers each shadowed request's getter returns. */
const RAW_HEADERS = new WeakMap<Request, Headers>();

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * Set while the platform or a request facade reads a shadowed request's
 * headers for itself, not for user code (runUnguarded).
 */
let unguarded = false;

function runUnguarded<T>(fn: () => T): T {
  const outer = unguarded;
  unguarded = true;
  try {
    return fn();
  } finally {
    unguarded = outer;
  }
}

/**
 * A request's headers, past the guard. The rule: router code never reads a
 * request's headers through the getter, only through this, so the guard sees
 * user reads alone. Several router reads run inside the scopes the guard
 * refuses (the state cookie rotation at a ppr capture, match's HMR marker,
 * a store's cf-ray inside a "use cache" body, telemetry inside a loader
 * fill); the rest follow the rule so a new call site cannot drift into one.
 */
export function requestHeaders(request: Request): Headers {
  return RAW_HEADERS.get(request) ?? request.headers;
}

/**
 * Shadow `request.headers` with an own, non-enumerable getter that calls
 * `beforeRead` and returns the request's own Headers (stable per request, so
 * a header set through it stays visible to every reader). Idempotent. Leaves
 * the request as is when `headers` is a non-configurable own property (a
 * runtime that defines it per instance). Three inherited members are
 * shadowed with it:
 *
 * - `clone()` returns a clone shadowed the same way. A plain clone was a
 *   Request without the getter, so `ctx.request.clone().headers` read the
 *   visitor's headers past the guard. (`new Request(ctx.request)` still
 *   returns a plain Request: the constructor cannot be intercepted.)
 * - `_request`, on a lazy srvx NodeRequest (what @vitejs/plugin-rsc's Node
 *   dev and preview servers and the vercel-output launcher hand the
 *   router), runs unguarded: it builds the platform Request on first use
 *   from `this.headers`, for clone() and the body readers. Through the
 *   getter, a clone() inside a cache() boundary threw as a user read. It
 *   stays lazy, so a request whose body srvx reads from its buffered
 *   `rawBody` never builds one.
 * - Node's util.inspect hook runs unguarded: undici's inspect reads
 *   `this.headers`, so `console.log(ctx.request)` inside a "use cache" body
 *   threw. A log is not a read into a shared entry.
 */
export function shadowRequestHeaders(
  request: Request,
  beforeRead: () => void,
): Request {
  if (RAW_HEADERS.has(request)) return request;
  const own = Object.getOwnPropertyDescriptor(request, "headers");
  if (own && !own.configurable) return request;
  const lazy = inheritedGetter(request, "_request");
  if (lazy) {
    Object.defineProperty(request, "_request", {
      get(this: Request): unknown {
        return runUnguarded(() => lazy.call(this));
      },
      configurable: true,
    });
  }
  const raw = request.headers;
  RAW_HEADERS.set(request, raw);
  Object.defineProperty(request, "headers", {
    get(): Headers {
      if (!unguarded) beforeRead();
      return raw;
    },
    enumerable: false,
    configurable: true,
  });
  const clone = request.clone;
  defineMethod(request, "clone", function (this: Request): Request {
    return shadowRequestHeaders(clone.call(this), beforeRead);
  });
  const inspect = (request as unknown as Record<symbol, unknown>)[INSPECT];
  if (typeof inspect === "function") {
    defineMethod(
      request,
      INSPECT,
      function (this: Request, ...args: unknown[]) {
        return runUnguarded(() => inspect.apply(this, args));
      },
    );
  }
  return request;
}

function defineMethod(
  target: object,
  key: PropertyKey,
  value: (...args: never[]) => unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    configurable: true,
    writable: true,
  });
}

/** The getter `key` resolves to on `target`'s prototype chain, if any. */
function inheritedGetter(
  target: object,
  key: string,
): (() => unknown) | undefined {
  for (let o = Object.getPrototypeOf(target); o; o = Object.getPrototypeOf(o)) {
    const found = Object.getOwnPropertyDescriptor(o, key);
    if (found) return found.get;
  }
  return undefined;
}
