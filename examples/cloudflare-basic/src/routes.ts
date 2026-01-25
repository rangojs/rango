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
export const blogRoutes = route({
  index: "/",
  post: "/:slug",
});

// Proactive cache test routes: /proactive-cache/*
// Layout is INSIDE cache boundary to test proactive caching behavior
// Uses prefix registration, so paths are relative
export const proactiveCacheRoutes = route({
  index: "/",
  itemA: "/item-a",
  itemB: "/item-b",
});
