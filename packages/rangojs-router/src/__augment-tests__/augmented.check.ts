/**
 * Compile-only assertions for the AUGMENTED Rango namespace.
 *
 * Pins the type-safety contract a consumer gets after augmenting Env, Vars, and
 * GeneratedRouteMap. A regression in the fallback chains (global-namespace.ts)
 * turns these into tsc errors. Run via tsconfig.augment-check.json.
 */
import "./augment.js";
import type { Handler, RouteParams, RouteSearchParams } from "../index.js";
import type { DefaultRouteName } from "../types/global-namespace.js";
import { href } from "../href-client.js";
import type { Money, TestBindings } from "./augment.js";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// Env: ctx.env resolves to the augmented bindings, not `unknown`/`any`.
const envHandler: Handler<"home"> = (ctx) => {
  type _envIsBindings = Expect<Equal<typeof ctx.env, TestBindings>>;
  ctx.env.DB.query("select 1");
  // @ts-expect-error - unknown binding is rejected once Env is augmented
  ctx.env.MISSING();
  return null;
};
void envHandler;

// Vars: ctx.get is keyed by the augmented Vars.
const varsHandler: Handler<"home"> = (ctx) => {
  const user = ctx.get("user");
  type _userTyped = Expect<
    Equal<typeof user, { id: string; role: "admin" | "user" } | undefined>
  >;
  // @ts-expect-error - unknown var key is rejected once Vars is augmented
  ctx.get("nope");
  return null;
};
void varsHandler;

// routeName narrows to the generated route names.
type _routeName = Expect<
  Equal<DefaultRouteName, "home" | "blog.post" | "search">
>;

// RouteParams / RouteSearchParams resolve from the generated map with no
// explicit route map argument.
type _params = Expect<Equal<RouteParams<"blog.post">, { slug: string }>>;
type _search = Expect<
  Equal<RouteSearchParams<"search">, { q: string | undefined; page?: number }>
>;

// href / Rango.Path read GeneratedRouteMap even without a manual RegisteredRoutes
// augmentation — this is the core of the "rango generate alone enables typed
// href()" guarantee. The paths below come from the generated map in augment.ts.
href("/");
href("/blog/anything");
href("/search");
// @ts-expect-error - path is not in the generated route map
href("/not-a-route");

// Rango.Path is the ambient input type for wrapper functions around href().
// No import needed — it reads the same generated map href() does.
function wrappedHref(path: Rango.Path): string {
  return href(path);
}
const arrowHref = (path: Rango.Path): string => href(path);

wrappedHref("/blog/anything");
arrowHref("/search?q=hello");
// @ts-expect-error - wrapper preserves the same generated-map validation
wrappedHref("/not-a-route");

// Userland serialization augmentation: a consumer's custom class adjusts its JSON
// wire shape via toJSON(), and Rango.PathResponse reports the serialized payload
// (Money -> number, Date -> string) — both by pattern and by concrete path.
type _orderWireByPattern = Expect<
  Equal<
    Rango.PathResponse<"/orders/:id">,
    { id: string; total: number; placedAt: string }
  >
>;
type _orderWireByPath = Expect<
  Equal<
    Rango.PathResponse<"/orders/42">,
    { id: string; total: number; placedAt: string }
  >
>;

// Project serialization overrides: the consumer augments JsonSerializeOverride /
// FlightSerializeOverride (see augment.ts) with a full transform that delegates to
// the built-in, and the transforms honor it — winning over the built-in rules.
// bigint normally JSON-serializes to `never`; Money is a class React Flight would
// otherwise reject structurally. Delegation keeps every other type (incl. the
// /orders payload above) on the built-in behavior.
type _jsonOverride = Expect<Equal<Rango.JsonSerialize<bigint>, string>>;
type _jsonOverrideNested = Expect<
  Equal<
    Rango.JsonSerialize<{ id: bigint; name: string }>,
    { id: string; name: string }
  >
>;
type _flightOverride = Expect<Equal<Rango.FlightSerialize<Money>, number>>;

// Reference the top-level assertion aliases so they are unambiguously evaluated.
export type _Assertions = [
  _routeName,
  _params,
  _search,
  _orderWireByPattern,
  _orderWireByPath,
  _jsonOverride,
  _jsonOverrideNested,
  _flightOverride,
];
