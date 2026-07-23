import { createRouter, Prerender, Static } from "@rangojs/router";

function HomePage() {
  return <h1 data-testid="home">prerender-onerror fixture</h1>;
}

// A Prerender route whose render reads ctx.env, unavailable at build (no buildEnv),
// so it throws during the build-time render (issue #587). Registered only when
// RANGO_TEST_PRERENDER_ERROR is set, so the prerender phase is clean otherwise.
export const PrerenderBoom = Prerender(async (ctx) => {
  const region = (ctx as unknown as { env: { REGION: string } }).env.REGION;
  return <div data-testid="prerender-boom">{region}</div>;
});

// A Static handler exercising the SAME prerender.onError policy via the
// renderStaticHandlers loop. Static handlers are discovered by export (not route
// registration), so it throws ONLY when RANGO_TEST_STATIC_ERROR is set and renders
// harmlessly otherwise.
export const StaticBoom = Static(() => {
  if (process.env.RANGO_TEST_STATIC_ERROR) {
    throw new Error("static build-time render failure (#587 fixture)");
  }
  return <div data-testid="static-boom-ok" />;
});

type AppRoutes = typeof router.routeMap;

declare global {
  namespace Rango {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

export const router = createRouter({}).routes(({ path }) => [
  path("/", HomePage, { name: "home" }),
  ...(process.env.RANGO_TEST_PRERENDER_ERROR
    ? [path("/prerender-boom", PrerenderBoom)]
    : []),
]);
