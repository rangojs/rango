/**
 * Type-level tests for Handler with per-module route map resolution
 * These tests verify that Handler<"routeName", routes> works correctly
 * with per-module .gen.ts sibling files.
 *
 * This file is type-checked by tsc --noEmit.
 */

import type { Handler } from "@rangojs/router";

// -- Per-module route map (names chosen to NOT collide with global GeneratedRouteMap) --
type LocalRoutes = {
  list: "/";
  detail: "/:itemId";
  filtered: { path: "/:itemId"; search: { q: "string"; page: "number?" } };
};

// Dot-prefixed local names — should be VALID
const localList: Handler<".list", LocalRoutes> = (ctx) => null;

const localDetail: Handler<".detail", LocalRoutes> = (ctx) => {
  const _itemId: string = ctx.params.itemId;
  return null;
};

// Path pattern still works (not a route name, has :param)
const pathPattern: Handler<"/product/:id"> = (ctx) => {
  const _id: string = ctx.params.id;
  return null;
};

// Bare local names (without dot-prefix) must be rejected — use ".name" for local routes
// @ts-expect-error — "list" exists in LocalRoutes but must use ".list"
const bareList: Handler<"list", LocalRoutes> = (ctx) => null;
// @ts-expect-error — "detail" exists in LocalRoutes but must use ".detail"
const bareDetail: Handler<"detail", LocalRoutes> = (ctx) => null;
// @ts-expect-error — "unknown" is neither global nor local
const bareUnknown: Handler<"unknown", LocalRoutes> = (ctx) => null;

// Dot-prefixed local with search schema — params AND search should be typed
const localFiltered: Handler<".filtered", LocalRoutes> = (ctx) => {
  const _itemId: string = ctx.params.itemId;
  const _q: string | undefined = ctx.search.q;
  const _page: number | undefined = ctx.search.page;
  return null;
};

// Dot-prefixed names that don't exist in routes must be rejected
// @ts-expect-error — "nonexistent" is not in LocalRoutes
const dotNonexistent: Handler<".nonexistent", LocalRoutes> = (ctx) => null;

// Suppress unused variable warnings
void localList;
void localDetail;
void pathPattern;
void bareList;
void bareDetail;
void bareUnknown;
void localFiltered;
void dotNonexistent;
