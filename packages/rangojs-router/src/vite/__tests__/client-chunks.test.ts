import { describe, it, expect } from "vitest";
import {
  directoryClientChunks,
  resolveClientChunks,
} from "../utils/client-chunks.js";
import { hashRefKey } from "../plugins/client-ref-hashing.js";
import type { ClientChunkMeta } from "../plugin-types.js";

function meta(id: string, normalizedId = id): ClientChunkMeta {
  return { id, normalizedId, serverChunk: "facade:index" };
}

describe("directoryClientChunks (built-in strategy)", () => {
  it("groups a route-colocated component by its route id (segment after the marker)", () => {
    expect(
      directoryClientChunks(
        meta(
          "/proj/src/routes/products/Cart.tsx",
          "src/routes/products/Cart.tsx",
        ),
      ),
    ).toBe("app-products");
  });

  it("keys on route identity, not the immediate parent — same-named subdirs do NOT collide", () => {
    // The reviewer's case: two routes each with a components/Button.tsx must land
    // in their own route chunk, not a shared app-components.
    expect(
      directoryClientChunks(
        meta(
          "/proj/src/routes/foo/components/Button.tsx",
          "src/routes/foo/components/Button.tsx",
        ),
      ),
    ).toBe("app-foo");
    expect(
      directoryClientChunks(
        meta(
          "/proj/src/routes/bar/components/Button.tsx",
          "src/routes/bar/components/Button.tsx",
        ),
      ),
    ).toBe("app-bar");
  });

  it("keeps a whole route's nested components together regardless of depth", () => {
    expect(
      directoryClientChunks(
        meta(
          "/proj/src/routes/foo/components/Card.tsx",
          "src/routes/foo/components/Card.tsx",
        ),
      ),
    ).toBe("app-foo");
    expect(
      directoryClientChunks(
        meta(
          "/proj/src/routes/foo/components/ui/Deep.tsx",
          "src/routes/foo/components/ui/Deep.tsx",
        ),
      ),
    ).toBe("app-foo");
  });

  it("recognizes other route-root markers (app/, features/, handlers/)", () => {
    expect(
      directoryClientChunks(
        meta(
          "/proj/src/app/dashboard/widgets/Chart.tsx",
          "src/app/dashboard/widgets/Chart.tsx",
        ),
      ),
    ).toBe("app-dashboard");
    expect(
      directoryClientChunks(
        meta(
          "/proj/src/features/auth/LoginForm.tsx",
          "src/features/auth/LoginForm.tsx",
        ),
      ),
    ).toBe("app-auth");
    expect(
      directoryClientChunks(
        meta(
          "/proj/src/handlers/kanban/components/Board.tsx",
          "src/handlers/kanban/components/Board.tsx",
        ),
      ),
    ).toBe("app-kanban");
  });

  it("keeps React / node_modules on the shared grouping (undefined)", () => {
    expect(
      directoryClientChunks(
        meta("/proj/node_modules/react-aria/dist/Button.js"),
      ),
    ).toBeUndefined();
  });

  it("keeps the installed Rango runtime shared (node_modules/@rangojs/router)", () => {
    expect(
      directoryClientChunks(
        meta("/proj/node_modules/@rangojs/router/dist/browser/react/Link.js"),
      ),
    ).toBeUndefined();
  });

  it("keeps the workspace Rango runtime shared even when normalizedId is project-root-relative", () => {
    // plugin-rsc derives a root-relative normalizedId for the in-repo runtime;
    // only the absolute `id` carries the package path. Both must classify shared.
    expect(
      directoryClientChunks(
        meta(
          "/repo/packages/rangojs-router/src/browser/react/Link.tsx",
          "../../src/browser/react/Link.tsx",
        ),
      ),
    ).toBeUndefined();
  });

  it("inherits the default grouping (undefined) when there is no route-root marker", () => {
    // Flat layout: no route structure to key on, so it falls through to the
    // default serverChunk grouping (one shared app chunk) — NOT a forced app-<dir>
    // chunk. This is what makes the default safe: a flat app is unchanged, and host
    // sub-apps split by dynamic import() keep their per-app serverChunk grouping.
    expect(
      directoryClientChunks(
        meta("/proj/src/components/Button.tsx", "src/components/Button.tsx"),
      ),
    ).toBeUndefined();
  });

  it("does not treat a marker as a route root when it directly contains the file", () => {
    // src/app/App.tsx: the segment after `app` is the file, not a route dir, so
    // there is no route id -> inherit the default grouping.
    expect(
      directoryClientChunks(meta("/proj/src/app/App.tsx", "src/app/App.tsx")),
    ).toBeUndefined();
  });

  it("does NOT misclassify a consumer's own src/browser code as Rango runtime", () => {
    // Regression guard: a bare "/src/browser/" must NOT be treated as the shared
    // router runtime. Outside a route it inherits the default app grouping
    // (undefined, NOT forced into the router chunk); under a route it splits.
    expect(
      directoryClientChunks(
        meta("/proj/src/browser/Foo.tsx", "src/browser/Foo.tsx"),
      ),
    ).toBeUndefined();
    expect(
      directoryClientChunks(
        meta(
          "/proj/src/routes/dash/browser/Widget.tsx",
          "src/routes/dash/browser/Widget.tsx",
        ),
      ),
    ).toBe("app-dash");
  });

  it("does NOT match a consumer app merely nested under a packages/rangojs-router ancestor", () => {
    // The in-repo e2e apps live at packages/rangojs-router/e2e/<app>/src/...;
    // their route components must split, not merge into the runtime.
    expect(
      directoryClientChunks(
        meta(
          "/repo/packages/rangojs-router/e2e/mini/src/routes/widgets/WidgetA.tsx",
          "src/routes/widgets/WidgetA.tsx",
        ),
      ),
    ).toBe("app-widgets");
  });

  it("sanitizes the route id into a safe chunk fragment", () => {
    expect(
      directoryClientChunks(
        meta(
          "/proj/src/routes/my widgets!/X.tsx",
          "src/routes/my widgets!/X.tsx",
        ),
      ),
    ).toBe("app-my_widgets");
  });
});

describe("resolveClientChunks", () => {
  it("returns undefined for false / undefined (no override)", () => {
    expect(resolveClientChunks(false)).toBeUndefined();
    expect(resolveClientChunks(undefined)).toBeUndefined();
  });

  it("returns the built-in directory strategy for true (behaviorally)", () => {
    const fn = resolveClientChunks(true);
    expect(fn).toBeTypeOf("function");
    // Bound to directoryClientChunks (no context): same decisions.
    expect(
      fn!(
        meta("/p/src/routes/products/Cart.tsx", "src/routes/products/Cart.tsx"),
      ),
    ).toBe("app-products");
    expect(
      fn!(meta("/p/src/components/Button.tsx", "src/components/Button.tsx")),
    ).toBeUndefined();
  });

  it("returns a user function verbatim (no fallback refinement)", () => {
    const fn = (m: ClientChunkMeta) => `custom-${m.serverChunk}`;
    expect(resolveClientChunks(fn)).toBe(fn);
    // Even with a context present, a custom function owns grouping.
    expect(resolveClientChunks(fn, { fallbackRefs: new Set(["x"]) })).toBe(fn);
  });
});

describe("directoryClientChunks (registered fallbacks)", () => {
  it("routes a registered fallback module into app-fallback", () => {
    // The strategy hashes meta.normalizedId; the context holds that same hash.
    const m = meta("/p/src/ErrorFallback.tsx", "src/ErrorFallback.tsx");
    const ctx = { fallbackRefs: new Set([hashRefKey(m.normalizedId)]) };
    expect(directoryClientChunks(m, ctx)).toBe("app-fallback");
  });

  it("fallback grouping wins over a route-root marker", () => {
    const m = meta(
      "/p/src/routes/shop/Boundary.tsx",
      "src/routes/shop/Boundary.tsx",
    );
    const ctx = { fallbackRefs: new Set([hashRefKey(m.normalizedId)]) };
    expect(directoryClientChunks(m, ctx)).toBe("app-fallback");
  });

  it("a non-fallback module is unaffected by the fallback set", () => {
    const m = meta("/p/src/components/Button.tsx", "src/components/Button.tsx");
    const ctx = { fallbackRefs: new Set(["someotherhash"]) };
    expect(directoryClientChunks(m, ctx)).toBeUndefined();
  });

  it("no context -> behaves exactly like the bare strategy", () => {
    expect(
      directoryClientChunks(
        meta("/p/src/routes/a/X.tsx", "src/routes/a/X.tsx"),
      ),
    ).toBe("app-a");
  });
});
