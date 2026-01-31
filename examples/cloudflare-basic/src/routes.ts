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

// Slow cache test route: /slow-cache
// Tests caching with a slow async component (3 second delay)
// First request should take 3 seconds, subsequent requests should be instant
export const slowCacheRoutes = route({
  slowCache: "/slow-cache",
});
