/**
 * Type-level tests for Handler with per-module route map resolution
 * These tests verify that Handler<"routeName", routes> works correctly
 * with per-module .gen.ts sibling files.
 *
 * This file is type-checked by tsc --noEmit.
 */

import type { Handler } from "@rangojs/router";

// -- Per-module route map (from blog.gen.ts) --
type BlogRoutes = {
  index: "/";
  post: "/:postId";
};

// Handler with per-module route name resolution
const blogPost: Handler<"post", BlogRoutes> = (ctx) => {
  const _postId: string = ctx.params.postId;
  return null;
};

const blogIndex: Handler<"index", BlogRoutes> = (ctx) => {
  // Index route has no params
  return null;
};

// Path pattern still works (not a route name, has :param)
const pathPattern: Handler<"/product/:id"> = (ctx) => {
  const _id: string = ctx.params.id;
  return null;
};

// Suppress unused variable warnings
void blogPost;
void blogIndex;
void pathPattern;
