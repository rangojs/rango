import { route } from "@ivogt/rsc-router";

// Home route: /
export const homeRoutes = route({
  home: "/",
});

// About route: /about
export const aboutRoutes = route({
  about: "/about",
});

// Counter route: /counter (demonstrates server actions)
export const counterRoutes = route({
  counter: "/counter",
});

// Features route: /features/:slug (demonstrates location state)
export const featuresRoutes = route({
  featuresDetail: "/features/:slug",
});

// Blog routes: /blog and /blog/:slug (demonstrates CF cache with SWR)
// Uses prefix registration, so paths are relative
// Keys must be globally unique since they're not prefixed
export const blogRoutes = route({
  blog: "/",
  blogPost: "/:slug",
});

// Proactive cache test routes: /proactive-cache/*
// Layout is INSIDE cache boundary to test proactive caching behavior
// Uses prefix registration, so paths are relative
// Keys must be globally unique since they're not prefixed
export const proactiveCacheRoutes = route({
  proactiveCache: "/",
  proactiveCacheItemA: "/item-a",
  proactiveCacheItemB: "/item-b",
});

// Document cache test route: /document-cache
// Tests document-level caching based on Cache-Control headers
// First request: MISS (slow), subsequent requests: HIT (instant)
export const documentCacheRoutes = route({
  documentCache: "/document-cache",
});

// Slow cache test route: /slow-cache
// Tests caching with a slow async component (3 second delay)
// First request should take 3 seconds, subsequent requests should be instant
export const slowCacheRoutes = route({
  slowCache: "/slow-cache",
});

// Theme test route: /theme
// Demonstrates theme support with useTheme hook and ctx.theme
export const themeRoutes = route({
  theme: "/theme",
});

// Slow routes: /slow/1 and /slow/2
// Demonstrates NavigationProgress with delayed loading
export const slowRoutes = route({
  slow1: "/1",
  slow2: "/2",
});
