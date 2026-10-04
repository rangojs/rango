/**
 * "use cache" keys for arguments Flight cannot serialize (issue #924).
 *
 * Given a temporary-reference set, encodeReply does not throw on a function,
 * a class instance (a Request), a local symbol or a React element: it writes
 * the temporary-reference token "$T". Every such argument keyed the same, so
 * two different Requests shared one entry. Runs the real vendored
 * react-server-dom encoder and codec; the other key tests stub encodeReply
 * with JSON.stringify, which never emits "$T".
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";

vi.mock("@vitejs/plugin-rsc/rsc/server", async () => {
  const RSD =
    await import("@vitejs/plugin-rsc/vendor/react-server-dom/server.edge");
  return {
    createTemporaryReferenceSet: () => new WeakMap(),
    renderToReadableStream: (value: unknown, options?: object) =>
      RSD.renderToReadableStream(value, {}, options),
  };
});
vi.mock("@vitejs/plugin-rsc/rsc/client", async () => {
  await import("../../testing/internal/flight-client-globals.js");
  // The vendored browser client. Its reply encoder matches the client.edge
  // build the runtime uses except for error-message formatting. The ambient
  // declaration (src/testing/flight-runtime.d.ts) types only the decoder.
  const Client =
    (await import("@vitejs/plugin-rsc/react/browser")) as unknown as {
      createFromReadableStream: (
        stream: ReadableStream<Uint8Array>,
      ) => Promise<unknown>;
      encodeReply: typeof import("../../deps/rsc-client.js").encodeReply;
      createTemporaryReferenceSet: typeof import("../../deps/rsc-client.js").createClientTemporaryReferenceSet;
    };
  return {
    createFromReadableStream: (stream: ReadableStream<Uint8Array>) =>
      Client.createFromReadableStream(stream),
    encodeReply: Client.encodeReply,
    createClientTemporaryReferenceSet: Client.createTemporaryReferenceSet,
  };
});

import { createElement } from "react";
import { registerClientReference } from "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge";
import {
  encodeReply,
  createClientTemporaryReferenceSet,
} from "../../deps/rsc-client.js";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { registerCachedFunction } from "../cache-runtime.js";
import { NOCACHE_SYMBOL } from "../taint.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";

class Binding {
  constructor(readonly name: string) {}
}

const env = { API_URL: "https://api.example", DB: new Binding("db") };

let store: MemorySegmentCacheStore;
let consoleWarn: MockInstance<typeof console.warn>;

beforeEach(() => {
  store = new MemorySegmentCacheStore();
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  consoleWarn.mockRestore();
});

/** Run `fn` in a request for `url`, its deferred cache writes flushed. */
async function inRequest<T>(
  fn: (reqCtx: RequestContext<any>) => Promise<T>,
  url = "https://example.com/",
): Promise<T> {
  const request = new Request(url);
  const reqCtx = createRequestContext({
    env,
    request,
    url: new URL(url),
    variables: {},
  } as any) as RequestContext<any>;
  (reqCtx as any)._cacheStore = store;
  (reqCtx as any)._cacheProfiles = { default: { ttl: 60, swr: 60 } };
  return runWithRequestContext(reqCtx, async () => {
    const result = await fn(reqCtx);
    const tasks = reqCtx._pendingBackgroundTasks ?? [];
    for (let i = 0; i < tasks.length; i++) await tasks[i];
    return result;
  });
}

/** A cached function returning its call count, so a hit repeats a count. */
function counted(id: string) {
  let calls = 0;
  const cached = registerCachedFunction(
    async (..._args: unknown[]) => ++calls,
    id,
    "default",
  );
  return { cached, calls: () => calls };
}

async function encodeKeyArgs(args: unknown[]): Promise<string | FormData> {
  return encodeReply(args, {
    temporaryReferences: createClientTemporaryReferenceSet(),
  });
}

describe("encodeReply with a temporary-reference set (real Flight)", () => {
  it('encodes an argument it cannot serialize as "$T" instead of throwing', async () => {
    expect(await encodeKeyArgs([new Request("https://a.example/"), "/"])).toBe(
      '["$T","/"]',
    );
    expect(await encodeKeyArgs([new Request("https://b.example/"), "/"])).toBe(
      '["$T","/"]',
    );
    expect(await encodeKeyArgs([() => 1, "/"])).toBe('["$T","/"]');
    expect(await encodeKeyArgs([{ nested: new Binding("x") }])).toBe(
      '[{"nested":"$T"}]',
    );
  });

  it('escapes a user string "$T" as "$$T"', async () => {
    expect(await encodeKeyArgs(["$T", "/"])).toBe('["$$T","/"]');
  });
});

describe('"use cache": a Request argument keys by its URL', () => {
  it("two different Requests do not share an entry", async () => {
    const getPage = registerCachedFunction(
      async (request: Request, path: string) =>
        `${new URL(request.url).host}${path}`,
      "test#getPage",
      "default",
    );
    const a = await inRequest(() =>
      getPage(new Request("https://a.example/"), "/"),
    );
    const b = await inRequest(() =>
      getPage(new Request("https://b.example/"), "/"),
    );
    expect([a, b]).toEqual(["a.example/", "b.example/"]);
  });

  it("the same URL hits; path and user search params split the key", async () => {
    const { cached, calls } = counted("test#requestUrl");
    const call = (url: string) => inRequest((ctx) => cached(ctx.request), url);

    expect(await call("https://a.example/p?x=1&y=2")).toBe(1);
    // Same URL, search reordered, internal _rsc* param added: a hit.
    expect(await call("https://a.example/p?y=2&x=1&_rsc_partial=1")).toBe(1);
    expect(await call("https://a.example/q?x=1&y=2")).toBe(2);
    expect(await call("https://a.example/p?x=2&y=2")).toBe(3);
    expect(calls()).toBe(3);
  });
});

describe('"use cache": env is left out of the key', () => {
  it("the request's env, bindings included, keys as if absent", async () => {
    const { cached, calls } = counted("test#envArg");
    expect(await inRequest((ctx) => cached(ctx.env, "k"))).toBe(1);
    expect(await inRequest((ctx) => cached(ctx.env, "k"))).toBe(1);
    expect(await inRequest((ctx) => cached(ctx.env, "other"))).toBe(2);
    expect(calls()).toBe(2);
  });
});

describe('"use cache": an argument Flight cannot serialize runs uncached', () => {
  const unkeyable: Array<[string, () => unknown]> = [
    ["a function", () => () => 1],
    ["a class instance", () => new Binding("x")],
    ["a local symbol", () => Symbol("s")],
    ["a nested function", () => ({ cb: () => 1 })],
    ["a nested class instance", () => ({ items: [new Binding("x")] })],
    ["a function inside a Map", () => new Map([["cb", () => 1]])],
    [
      "a function next to an element",
      () => ({ slot: createElement("b"), cb: () => 1 }),
    ],
  ];

  for (const [label, make] of unkeyable) {
    it(`${label}: every call runs the function`, async () => {
      const { cached, calls } = counted(`test#unkeyable:${label}`);
      expect(await inRequest(() => cached(make(), "/"))).toBe(1);
      expect(await inRequest(() => cached(make(), "/"))).toBe(2);
      expect(calls()).toBe(2);
    });
  }

  it("warns once per function in dev, naming it", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const { cached } = counted("test#warnsInDev");
      await inRequest(() => cached(() => 1));
      await inRequest(() => cached(() => 2));
    } finally {
      process.env.NODE_ENV = prev;
    }
    const warnings = consoleWarn.mock.calls
      .map((args) => String(args[0]))
      .filter((m) => m.includes("test#warnsInDev"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ran uncached");
  });

  it("does not warn in production", async () => {
    const { cached } = counted("test#silentInProd");
    await inRequest(() => cached(() => 1));
    expect(
      consoleWarn.mock.calls.some((args) =>
        String(args[0]).includes("test#silentInProd"),
      ),
    ).toBe(false);
  });
});

describe('"use cache": React elements and client/server references are slots', () => {
  // Left out of the key as temporary references, as before #924: the first
  // call's rendered slot is part of the cached output (the interleave route in
  // e2e/use-cache-streaming.test.ts).
  const clientRef = registerClientReference(() => null, "src/Icon.tsx", "Icon");
  const serverRef = Object.assign(async () => null, {
    $$typeof: Symbol.for("react.server.reference"),
  });

  it("a top-level element: a different element hits the same entry", async () => {
    const { cached, calls } = counted("test#elementSlot");
    const slot = (text: string) => createElement("h2", null, text);
    expect(await inRequest(() => cached(slot("a"), "p1"))).toBe(1);
    expect(await inRequest(() => cached(slot("b"), "p1"))).toBe(1);
    expect(await inRequest(() => cached(slot("a"), "p2"))).toBe(2);
    expect(calls()).toBe(2);
  });

  it("elements nested in an object (header/children slots)", async () => {
    const { cached, calls } = counted("test#nestedSlots");
    const props = () => ({
      header: createElement("h2", null, String(Math.random())),
      children: [createElement("span", { key: "k" }, "c")],
    });
    expect(await inRequest(() => cached(props()))).toBe(1);
    expect(await inRequest(() => cached(props()))).toBe(1);
    expect(calls()).toBe(1);
  });

  it("a client reference and a server reference", async () => {
    const { cached, calls } = counted("test#referenceSlots");
    expect(await inRequest(() => cached({ as: clientRef, serverRef }))).toBe(1);
    expect(await inRequest(() => cached({ as: clientRef, serverRef }))).toBe(1);
    expect(calls()).toBe(1);
  });

  it("does not warn", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const { cached } = counted("test#slotNoWarn");
      await inRequest(() => cached(createElement("b")));
    } finally {
      process.env.NODE_ENV = prev;
    }
    expect(
      consoleWarn.mock.calls.some((args) =>
        String(args[0]).includes("test#slotNoWarn"),
      ),
    ).toBe(false);
  });
});

describe('"use cache": serializable arguments on the encodeReply path still cache', () => {
  // A Date is not JSON-safe, so each call below skips the fast path.
  const at = new Date(0);

  it('a string "$T"', async () => {
    const { cached, calls } = counted("test#dollarT");
    expect(await inRequest(() => cached("$T", at))).toBe(1);
    expect(await inRequest(() => cached("$T", at))).toBe(1);
    expect(await inRequest(() => cached("$U", at))).toBe(2);
    expect(calls()).toBe(2);
  });

  it('a string containing a quoted "$T"', async () => {
    const { cached, calls } = counted("test#quotedDollarT");
    expect(await inRequest(() => cached('a"$T', at))).toBe(1);
    expect(await inRequest(() => cached('a"$T', at))).toBe(1);
    expect(calls()).toBe(1);
  });

  it('an object key "$T"', async () => {
    const { cached, calls } = counted("test#keyDollarT");
    expect(await inRequest(() => cached({ $T: 1, at }))).toBe(1);
    expect(await inRequest(() => cached({ $T: 1, at }))).toBe(1);
    expect(await inRequest(() => cached({ $T: 2, at }))).toBe(2);
    expect(calls()).toBe(2);
  });

  it("a Map of plain values (FormData reply)", async () => {
    const { cached, calls } = counted("test#mapArg");
    expect(await inRequest(() => cached(new Map([["k", 1]])))).toBe(1);
    expect(await inRequest(() => cached(new Map([["k", 1]])))).toBe(1);
    expect(await inRequest(() => cached(new Map([["k", 2]])))).toBe(2);
    expect(calls()).toBe(2);
  });
});

describe('"use cache": a ctx argument is unchanged', () => {
  function fakeCtx(pathname: string) {
    const url = new URL(`https://example.com${pathname}`);
    return {
      [NOCACHE_SYMBOL]: true,
      url,
      pathname,
      params: { id: pathname.slice(1) },
      searchParams: url.searchParams,
    };
  }

  it("keys by the route fields it carries, on the encodeReply path too", async () => {
    const { cached, calls } = counted("test#ctxArg");
    const at = new Date(0);
    expect(await inRequest(() => cached(fakeCtx("/1"), at))).toBe(1);
    expect(await inRequest(() => cached(fakeCtx("/1"), at))).toBe(1);
    expect(await inRequest(() => cached(fakeCtx("/2"), at))).toBe(2);
    expect(calls()).toBe(2);
  });
});
