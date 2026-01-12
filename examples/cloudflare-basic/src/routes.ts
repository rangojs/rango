import { route } from "rsc-router";

// Home route: /
export const homeRoutes = route({
  index: "/",
});

// About route: /about
export const aboutRoutes = route({
  index: "/about",
});

// Counter route: /counter (demonstrates server actions)
export const counterRoutes = route({
  index: "/counter",
});

// Features route: /features/:slug (demonstrates location state)
export const featuresRoutes = route({
  detail: "/features/:slug",
});

// Blog routes: /blog and /blog/:slug (demonstrates CF cache with SWR)
export const blogRoutes = route({
  index: "/blog",
  post: "/blog/:slug",
});

// Proactive cache test routes: /proactive-cache/*
// Layout is INSIDE cache boundary to test proactive caching behavior
export const proactiveCacheRoutes = route({
  index: "/proactive-cache",
  itemA: "/proactive-cache/item-a",
  itemB: "/proactive-cache/item-b",
});
