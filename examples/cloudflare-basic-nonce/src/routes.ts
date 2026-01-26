import { route } from "@ivogt/rsc-router";

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
