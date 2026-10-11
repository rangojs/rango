/**
 * Type-level guard: a transition() item among a layout's (or include's)
 * children must not turn the inferred route map into a string-indexed record.
 * `Record<string, any> & { a: "/a" }` switches route-name checking off for the
 * whole app (reverse()/href() accept any name), it does not narrow it.
 *
 * The same holds for any phantom-less item that matches TypedLayoutItem /
 * TypedCacheItem / TypedTransitionItem in ExtractRoutesFromItem: the globally
 * imported transition/cache/layout and factories typed as a use item.
 */

import { describe, it, expectTypeOf } from "vitest";
import {
  urls,
  cache as globalCache,
  layout as globalLayout,
  transition as globalTransition,
  type LayoutUseItem,
  type ReverseFunction,
  type UrlPatterns,
} from "@rangojs/router";

const L = () => null;
const A = () => null;
const B = () => null;

type Simplify<T> = { [K in keyof T]: T[K] };
type RoutesOf<T> = Simplify<
  NonNullable<T extends { readonly _routes?: infer R } ? R : never>
>;
type ResponsesOf<T> = Simplify<
  NonNullable<T extends { readonly _responses?: infer R } ? R : never>
>;
type AB = { a: "/a"; b: "/b" };

// True when the map has a string index signature (name checking is off).
type IsOpen<T> = string extends keyof T ? true : false;

// Bodies passed here are only type-checked, never run.
function typeOnly(_check: () => void): void {}
function reverseOf<P>(_p: P): ReverseFunction<RoutesOf<P>> {
  return null as never;
}

describe("transition() among layout children keeps the route map", () => {
  it("first child", () => {
    const p = urls(({ layout, path, transition }) => [
      layout(L, () => [
        transition({}),
        path("/a", A, { name: "a" }),
        path("/b", B, { name: "b" }),
      ]),
    ]);
    expectTypeOf<IsOpen<RoutesOf<typeof p>>>().toEqualTypeOf<false>();
    expectTypeOf<RoutesOf<typeof p>>().toEqualTypeOf<AB>();
    const rev = reverseOf(p);
    typeOnly(() => {
      rev("a");
      // @ts-expect-error unknown route name must be rejected
      rev("zzz-not-a-route");
    });
  });

  it("middle child", () => {
    const p = urls(({ layout, path, transition }) => [
      layout(L, () => [
        path("/a", A, { name: "a" }),
        transition({ enter: "fade-in" }),
        path("/b", B, { name: "b" }),
      ]),
    ]);
    expectTypeOf<IsOpen<RoutesOf<typeof p>>>().toEqualTypeOf<false>();
    expectTypeOf<RoutesOf<typeof p>>().toEqualTypeOf<AB>();
    const rev = reverseOf(p);
    typeOnly(() => {
      rev("b");
      // @ts-expect-error unknown route name must be rejected
      rev("zzz-not-a-route");
    });
  });

  it("last child, bare transition()", () => {
    const p = urls(({ layout, path, transition }) => [
      layout(L, () => [
        path("/a", A, { name: "a" }),
        path("/b", B, { name: "b" }),
        transition(),
      ]),
    ]);
    expectTypeOf<IsOpen<RoutesOf<typeof p>>>().toEqualTypeOf<false>();
    expectTypeOf<RoutesOf<typeof p>>().toEqualTypeOf<AB>();
    const rev = reverseOf(p);
    typeOnly(() => {
      rev("a");
      // @ts-expect-error unknown route name must be rejected
      rev("zzz-not-a-route");
    });
  });

  it("nested layouts", () => {
    const p = urls(({ layout, path, transition }) => [
      layout(L, () => [
        transition({ viewTransition: false }),
        layout(L, () => [transition({}), path("/a", A, { name: "a" })]),
        path("/b", B, { name: "b" }),
      ]),
    ]);
    expectTypeOf<IsOpen<RoutesOf<typeof p>>>().toEqualTypeOf<false>();
    expectTypeOf<RoutesOf<typeof p>>().toEqualTypeOf<AB>();
    const rev = reverseOf(p);
    typeOnly(() => {
      rev("a");
      // @ts-expect-error unknown route name must be rejected
      rev("zzz-not-a-route");
    });
  });

  it("wrapper form beside a sibling path", () => {
    const p = urls(({ layout, path, transition }) => [
      layout(L, () => [
        transition({}, () => [path("/a", A, { name: "a" })]),
        path("/b", B, { name: "b" }),
      ]),
    ]);
    expectTypeOf<RoutesOf<typeof p>>().toEqualTypeOf<AB>();
    const rev = reverseOf(p);
    typeOnly(() => {
      rev("a");
      // @ts-expect-error unknown route name must be rejected
      rev("zzz-not-a-route");
    });
  });

  it("with a when predicate and top-level", () => {
    const p = urls(({ layout, path, transition }) => [
      transition({ when: () => true }),
      layout(L, () => [
        transition({ when: ({ from }) => from.url.pathname === "/a" }),
        path("/a", A, { name: "a" }),
        path("/b", B, { name: "b" }),
      ]),
    ]);
    expectTypeOf<IsOpen<RoutesOf<typeof p>>>().toEqualTypeOf<false>();
    expectTypeOf<RoutesOf<typeof p>>().toEqualTypeOf<AB>();
    const rev = reverseOf(p);
    typeOnly(() => {
      rev("b");
      // @ts-expect-error unknown route name must be rejected
      rev("zzz-not-a-route");
    });
  });

  // Positive control: passes without the fix too, because PrefixRoutes drops
  // string keys. Kept to pin include() composition.
  it("inside include()", () => {
    const inner = urls(({ layout, path, transition }) => [
      layout(L, () => [
        transition({}),
        path("/a", A, { name: "a" }),
        path("/b", B, { name: "b" }),
      ]),
    ]);
    const outer = urls(({ include }) => [include("/x", inner, { name: "x" })]);
    expectTypeOf<RoutesOf<typeof outer>>().toEqualTypeOf<{
      "x.a": "/x/a";
      "x.b": "/x/b";
    }>();
  });
});

describe("phantom-less items as layout children keep the route map", () => {
  it("globally imported transition()", () => {
    const p = urls(({ layout, path }) => [
      layout(L, () => [
        globalTransition({}),
        path("/a", A, { name: "a" }),
        path("/b", B, { name: "b" }),
      ]),
    ]);
    expectTypeOf<IsOpen<RoutesOf<typeof p>>>().toEqualTypeOf<false>();
    expectTypeOf<RoutesOf<typeof p>>().toEqualTypeOf<AB>();
    const rev = reverseOf(p);
    typeOnly(() => {
      rev("a");
      // @ts-expect-error unknown route name must be rejected
      rev("zzz-not-a-route");
    });
  });

  it("globally imported cache()", () => {
    const p = urls(({ layout, path }) => [
      layout(L, () => [
        globalCache(),
        path("/a", A, { name: "a" }),
        path("/b", B, { name: "b" }),
      ]),
    ]);
    expectTypeOf<IsOpen<RoutesOf<typeof p>>>().toEqualTypeOf<false>();
    expectTypeOf<RoutesOf<typeof p>>().toEqualTypeOf<AB>();
    const rev = reverseOf(p);
    typeOnly(() => {
      rev("a");
      // @ts-expect-error unknown route name must be rejected
      rev("zzz-not-a-route");
    });
  });

  it("globally imported layout()", () => {
    const p = urls(({ layout, path }) => [
      layout(L, () => [
        globalLayout(L),
        path("/a", A, { name: "a" }),
        path("/b", B, { name: "b" }),
      ]),
    ]);
    expectTypeOf<IsOpen<RoutesOf<typeof p>>>().toEqualTypeOf<false>();
    expectTypeOf<RoutesOf<typeof p>>().toEqualTypeOf<AB>();
    const rev = reverseOf(p);
    typeOnly(() => {
      rev("a");
      // @ts-expect-error unknown route name must be rejected
      rev("zzz-not-a-route");
    });
  });

  it("factory typed (): LayoutUseItem", () => {
    const makeItem = (): LayoutUseItem => globalTransition({});
    const p = urls(({ layout, path }) => [
      layout(L, () => [
        makeItem(),
        path("/a", A, { name: "a" }),
        path("/b", B, { name: "b" }),
      ]),
    ]);
    expectTypeOf<IsOpen<RoutesOf<typeof p>>>().toEqualTypeOf<false>();
    expectTypeOf<RoutesOf<typeof p>>().toEqualTypeOf<AB>();
    const rev = reverseOf(p);
    typeOnly(() => {
      rev("a");
      // @ts-expect-error unknown route name must be rejected
      rev("zzz-not-a-route");
    });
  });

  it("response map stays closed and keeps its names", () => {
    const p = urls(({ layout, path }) => [
      layout(L, () => [
        globalTransition({}),
        globalCache(),
        path.json("/api/health", () => ({ status: "ok" }), { name: "health" }),
        path("/a", A, { name: "a" }),
      ]),
    ]);
    expectTypeOf<IsOpen<ResponsesOf<typeof p>>>().toEqualTypeOf<false>();
    expectTypeOf<ResponsesOf<typeof p>>().toEqualTypeOf<{
      health: { status: string };
      a: unknown;
    }>();
    expectTypeOf<RoutesOf<typeof p>>().toEqualTypeOf<{
      health: "/api/health";
      a: "/a";
    }>();
  });
});

describe("loosely typed include() beside named siblings keeps the names", () => {
  // Routes default to Record<string, string>; flattened (name: "") the include
  // contributes a string index that must not erase its named siblings.
  const loose = null as unknown as UrlPatterns;

  it("routes", () => {
    const p = urls(({ layout, path, include }) => [
      layout(L, () => [
        include("/shop", loose, { name: "" }),
        path("/a", A, { name: "a" }),
      ]),
    ]);
    expectTypeOf<RoutesOf<typeof p>>().toEqualTypeOf<{ a: "/a" }>();
    const rev = reverseOf(p);
    typeOnly(() => {
      rev("a");
      // @ts-expect-error unknown route name must be rejected
      rev("zzz-not-a-route");
    });
  });

  it("responses", () => {
    const p = urls(({ layout, path, include }) => [
      layout(L, () => [
        include("/shop", loose, { name: "" }),
        path.json("/api/j", () => ({ ok: true }), { name: "j" }),
      ]),
    ]);
    expectTypeOf<IsOpen<ResponsesOf<typeof p>>>().toEqualTypeOf<false>();
    expectTypeOf<ResponsesOf<typeof p>>().toEqualTypeOf<{
      j: { ok: true };
    }>();
    const rev = reverseOf(p);
    typeOnly(() => {
      rev("j");
      // @ts-expect-error unknown route name must be rejected
      rev("zzz-not-a-route");
    });
  });
});
