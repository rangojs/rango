/**
 * Type-level tests for route/response map extraction across every path() call
 * form, with a focus on the name-less 3-arg children-fn overload.
 *
 * Regression guard for #642: `path(pattern, component, () => [...])` (name-less,
 * children-fn) let TName infer to the bare `string` constraint instead of the
 * UnnamedRoute sentinel — the children-fn argument structurally satisfies the
 * all-optional PathOptions<TName> union member, so TS resolved TName to its
 * constraint. That produced `{ [K in string]: TPattern }`, an index signature
 * that collapsed the ENTIRE sibling route map (Rango.Path -> never), not just
 * the offending route. The fix is a widened-name guard in ExtractRoutesFromItem
 * / ExtractResponsesFromItem (src/urls/type-extraction.ts): an unresolved
 * (`string extends TName`) name is treated as unnamed and contributes `{}`.
 *
 * These assertions exercise the PUBLIC urls() surface a consumer writes, so the
 * guarantee is verified through the same primitives a consumer touches — not a
 * white-box test of the extraction type in isolation. expectTypeOf probes are
 * compile-time only; the bodies never run.
 */

import { describe, it, expectTypeOf } from "vitest";
import { urls } from "../urls.js";
import { createLoader } from "../loader.js";

const StreamLoader = createLoader(() => ({ items: [] as string[] }));

// Bare function components — a name-less route's handler is just a component.
const StreamPage = () => null;
const AboutPage = () => null;
const HomePage = () => null;

// The map is built via UnionToIntersection, so multiple named siblings surface
// as `A & B` intersections. Flatten (homomorphic, preserves readonly/optional)
// so equality assertions compare the merged object shape a consumer sees.
type Simplify<T> = { [K in keyof T]: T[K] };
type RoutesOf<T> = Simplify<
  NonNullable<T extends { readonly _routes?: infer R } ? R : never>
>;
type ResponsesOf<T> = Simplify<
  NonNullable<T extends { readonly _responses?: infer R } ? R : never>
>;

describe("name-less children-fn path() does not collapse the route map (#642)", () => {
  it("name-less children-fn route contributes {} and preserves named siblings", () => {
    const patterns = urls(({ path, loading }) => [
      path("/section/stream", StreamPage, () => [loading(() => null)]),
      path("/about", AboutPage, { name: "about" }),
    ]);
    // Before the fix this was `{ [x: string]: "/section/stream" } & { about: "/about" }`.
    expectTypeOf<RoutesOf<typeof patterns>>().toEqualTypeOf<{
      about: "/about";
    }>();
  });

  it("empty children-fn (no child items) still contributes {}", () => {
    const patterns = urls(({ path }) => [
      path("/section/stream", StreamPage, () => []),
      path("/about", AboutPage, { name: "about" }),
    ]);
    expectTypeOf<RoutesOf<typeof patterns>>().toEqualTypeOf<{
      about: "/about";
    }>();
  });

  it("a whole realistic app map survives one name-less children-fn route", () => {
    // Mirrors the exact repro from #642: a loader() + loading() children-fn.
    const patterns = urls(({ path, loader, loading }) => [
      path("/", HomePage, { name: "home" }),
      path("/section/stream", StreamPage, () => [
        loader(StreamLoader),
        loading(() => null),
      ]),
      path("/about", AboutPage, { name: "about" }),
    ]);
    expectTypeOf<RoutesOf<typeof patterns>>().toEqualTypeOf<{
      home: "/";
      about: "/about";
    }>();
  });

  it("multiple name-less children-fn routes all collapse to {} (map stays empty, not never)", () => {
    const patterns = urls(({ path }) => [
      path("/a", StreamPage, () => []),
      path("/b", StreamPage, () => []),
    ]);
    expectTypeOf<RoutesOf<typeof patterns>>().toEqualTypeOf<{}>();
  });
});

describe("path() call-form matrix keeps working (no regression)", () => {
  it("2-arg name-less form contributes {}", () => {
    const patterns = urls(({ path }) => [
      path("/section/stream", StreamPage),
      path("/about", AboutPage, { name: "about" }),
    ]);
    expectTypeOf<RoutesOf<typeof patterns>>().toEqualTypeOf<{
      about: "/about";
    }>();
  });

  it("named children-fn form (4-arg) extracts the name", () => {
    const patterns = urls(({ path, loading }) => [
      path("/section/stream", StreamPage, { name: "stream" }, () => [
        loading(() => null),
      ]),
    ]);
    expectTypeOf<RoutesOf<typeof patterns>>().toEqualTypeOf<{
      stream: "/section/stream";
    }>();
  });

  it("named options form (3-arg) extracts the name", () => {
    const patterns = urls(({ path }) => [
      path("/about", AboutPage, { name: "about" }),
    ]);
    expectTypeOf<RoutesOf<typeof patterns>>().toEqualTypeOf<{
      about: "/about";
    }>();
  });
});

describe("name-less children-fn path.json() does not collapse the response map (#642)", () => {
  it("name-less children-fn response route contributes {} and preserves named siblings", () => {
    const patterns = urls(({ path }) => [
      path.json(
        "/api/stream",
        () => ({ ok: true }),
        () => [],
      ),
      path.json("/api/health", () => ({ status: "ok" }), { name: "health" }),
    ]);
    // Before the fix: `{ [x: string]: { ok: boolean } } & { health: {...} }`.
    expectTypeOf<ResponsesOf<typeof patterns>>().toEqualTypeOf<{
      health: { status: string };
    }>();
  });

  it("name-less children-fn path.text() response route contributes {}", () => {
    const patterns = urls(({ path }) => [
      path.text(
        "/api/stream",
        () => "hi",
        () => [],
      ),
      path.json("/api/health", () => ({ status: "ok" }), { name: "health" }),
    ]);
    expectTypeOf<ResponsesOf<typeof patterns>>().toEqualTypeOf<{
      health: { status: string };
    }>();
  });

  it("name-less children-fn path.stream() (ResponsePathFn) response route contributes {}", () => {
    // path.stream/image/any all share ResponsePathFn — same optionsOrUse union,
    // same name widening. Its response TData is unknown, so a named sibling's
    // payload must be the only response entry.
    const patterns = urls(({ path }) => [
      path.stream(
        "/api/live",
        () => new Response("x"),
        () => [],
      ),
      path.json("/api/health", () => ({ status: "ok" }), { name: "health" }),
    ]);
    expectTypeOf<ResponsesOf<typeof patterns>>().toEqualTypeOf<{
      health: { status: string };
    }>();
  });
});

describe("name-less children-fn nested in a subtree, and blast-radius guard (#642)", () => {
  it("name-less children-fn nested in cache() preserves the named sibling", () => {
    // The real-world shape from the issue: the offending route is not top-level
    // but inside a wrapper. cache() carries ExtractRoutes<TChildren> as a phantom,
    // so a poisoned child map (pre-fix) would propagate up and collapse the top map.
    const patterns = urls(({ path, cache, loading }) => [
      cache(() => [
        path("/x", StreamPage, () => [loading(() => null)]),
        path("/y", AboutPage, { name: "y" }),
      ]),
    ]);
    expectTypeOf<RoutesOf<typeof patterns>>().toEqualTypeOf<{ y: "/y" }>();
  });

  it("name-less children-fn nested in layout() preserves the named sibling", () => {
    const patterns = urls(({ path, layout, loading }) => [
      layout(HomePage, () => [
        path("/x", StreamPage, () => [loading(() => null)]),
        path("/about", AboutPage, { name: "about" }),
      ]),
    ]);
    expectTypeOf<RoutesOf<typeof patterns>>().toEqualTypeOf<{
      about: "/about";
    }>();
  });

  it("empty urls(() => []) yields {} (blast-radius guard), not never", () => {
    const patterns = urls(() => []);
    expectTypeOf<RoutesOf<typeof patterns>>().toEqualTypeOf<{}>();
    expectTypeOf<ResponsesOf<typeof patterns>>().toEqualTypeOf<{}>();
  });
});
