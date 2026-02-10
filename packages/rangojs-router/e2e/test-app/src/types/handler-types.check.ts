/**
 * Type-level tests for Handler with route name resolution
 * These tests verify that Handler<"routeName"> works correctly
 * with the global GeneratedRouteMap from named-routes.*.gen.ts.
 *
 * This file is type-checked by tsc --noEmit.
 */

import type { Handler } from "@rangojs/router";

// -- Global GeneratedRouteMap (from named-routes.*.gen.ts) --

// Handler with global route name resolution
const globalBlogPost: Handler<"blog.post"> = (ctx) => {
  const _postId: string = ctx.params.postId;
  return null;
};

const globalProductDetail: Handler<"product.detail"> = (ctx) => {
  const _productId: string = ctx.params.productId;
  return null;
};

// Path pattern still works (not a route name, has :param)
const pathPattern: Handler<"/product/:id"> = (ctx) => {
  const _id: string = ctx.params.id;
  return null;
};

// Suppress unused variable warnings
void globalBlogPost;
void globalProductDetail;
void pathPattern;
