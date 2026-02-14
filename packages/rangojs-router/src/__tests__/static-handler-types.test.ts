/**
 * Type-level tests for createStaticHandler and createPrerenderHandler DSL constraints
 *
 * Verifies that static/prerender handlers can only be used in supported DSL positions.
 * Uses compile-time type assertions (AssertTrue/AssertEqual) and expectTypeOf.
 */

import { describe, it, expect, expectTypeOf, vi } from "vitest";
import type { ReactNode } from "react";
import type { StaticHandlerDefinition } from "../static-handler.js";
import type { PrerenderHandlerDefinition } from "../prerender.js";
import type { PathHelpers } from "../urls.js";
import type { Handler, DefaultEnv } from "../types.js";

// Compile-time helpers
type AssertTrue<T extends true> = T;
type IsAssignable<T, U> = T extends U ? true : false;
type IsNotAssignable<T, U> = T extends U ? false : true;

// Shorthand types
type SH = StaticHandlerDefinition;
type PH = PrerenderHandlerDefinition;
type H = Handler<any, any, DefaultEnv>;
type Helpers = PathHelpers<DefaultEnv>;

// Extract parameter types from DSL functions
type LayoutHandler = Parameters<Helpers["layout"]>[0];
type InterceptHandler = Parameters<Helpers["intercept"]>[2];
type LoadingComponent = Parameters<Helpers["loading"]>[0];
type ErrorBoundaryFallback = Parameters<Helpers["errorBoundary"]>[0];
type NotFoundBoundaryFallback = Parameters<Helpers["notFoundBoundary"]>[0];

// ============================================================================
// createStaticHandler — allowed positions (compile-time assertions)
// ============================================================================

// StaticHandlerDefinition IS assignable to layout() handler param
type _SH_Layout = AssertTrue<IsAssignable<SH, LayoutHandler>>;

// StaticHandlerDefinition IS assignable to path() handler param
// (verified via PathFn accepting StaticHandlerDefinition<TParams> in union)

// ============================================================================
// createStaticHandler — disallowed positions (compile-time assertions)
// ============================================================================

// StaticHandlerDefinition is NOT assignable to loading() component param
type _SH_NotLoading = AssertTrue<IsNotAssignable<SH, LoadingComponent>>;

// StaticHandlerDefinition is NOT assignable to intercept() handler param
type _SH_NotIntercept = AssertTrue<IsNotAssignable<SH, InterceptHandler>>;

// StaticHandlerDefinition is NOT assignable to errorBoundary() fallback param
type _SH_NotErrorBoundary = AssertTrue<IsNotAssignable<SH, ErrorBoundaryFallback>>;

// StaticHandlerDefinition is NOT assignable to notFoundBoundary() fallback param
type _SH_NotNotFound = AssertTrue<IsNotAssignable<SH, NotFoundBoundaryFallback>>;

// ============================================================================
// createPrerenderHandler — disallowed positions (compile-time assertions)
// ============================================================================

// PrerenderHandlerDefinition is NOT assignable to layout() handler param
type _PH_NotLayout = AssertTrue<IsNotAssignable<PH, LayoutHandler>>;

// PrerenderHandlerDefinition is NOT assignable to loading() component param
type _PH_NotLoading = AssertTrue<IsNotAssignable<PH, LoadingComponent>>;

// PrerenderHandlerDefinition is NOT assignable to intercept() handler param
type _PH_NotIntercept = AssertTrue<IsNotAssignable<PH, InterceptHandler>>;

// PrerenderHandlerDefinition is NOT assignable to errorBoundary() fallback param
type _PH_NotErrorBoundary = AssertTrue<IsNotAssignable<PH, ErrorBoundaryFallback>>;

// PrerenderHandlerDefinition is NOT assignable to notFoundBoundary() fallback param
type _PH_NotNotFound = AssertTrue<IsNotAssignable<PH, NotFoundBoundaryFallback>>;

// ============================================================================
// Runtime tests using expectTypeOf
// ============================================================================

describe("createStaticHandler type constraints", () => {
  it("is assignable to layout() handler", () => {
    expectTypeOf<SH>().toMatchTypeOf<LayoutHandler>();
  });

  it("is not assignable to loading() component", () => {
    expectTypeOf<SH>().not.toMatchTypeOf<LoadingComponent>();
  });

  it("is not assignable to intercept() handler", () => {
    expectTypeOf<SH>().not.toMatchTypeOf<InterceptHandler>();
  });

  it("is not assignable to errorBoundary() fallback", () => {
    expectTypeOf<SH>().not.toMatchTypeOf<ErrorBoundaryFallback>();
  });

  it("is not assignable to notFoundBoundary() fallback", () => {
    expectTypeOf<SH>().not.toMatchTypeOf<NotFoundBoundaryFallback>();
  });
});

describe("createPrerenderHandler type constraints", () => {
  it("is not assignable to layout() handler", () => {
    expectTypeOf<PH>().not.toMatchTypeOf<LayoutHandler>();
  });

  it("is not assignable to loading() component", () => {
    expectTypeOf<PH>().not.toMatchTypeOf<LoadingComponent>();
  });

  it("is not assignable to intercept() handler", () => {
    expectTypeOf<PH>().not.toMatchTypeOf<InterceptHandler>();
  });

  it("is not assignable to errorBoundary() fallback", () => {
    expectTypeOf<PH>().not.toMatchTypeOf<ErrorBoundaryFallback>();
  });

  it("is not assignable to notFoundBoundary() fallback", () => {
    expectTypeOf<PH>().not.toMatchTypeOf<NotFoundBoundaryFallback>();
  });
});

// ============================================================================
// Runtime: inline usage allowed (Vite plugin handles ID injection)
// ============================================================================

describe("createStaticHandler runtime constraints", () => {
  it("does not throw in dev when $$id is missing (inline usage supported)", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    try {
      const { createStaticHandler } = await import("../static-handler.js");
      const result = createStaticHandler(() => null as any);
      expect(result.__brand).toBe("staticHandler");
      expect(result.$$id).toBe("");
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
