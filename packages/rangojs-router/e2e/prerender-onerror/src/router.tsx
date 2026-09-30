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

// A Prerender route whose handler returns normally but whose tree holds an async
// component that throws while the build encodes it (#914). Flight reports that
// through onError instead of rejecting, so only the encode sees the throw.
// Registered only when RANGO_TEST_PRERENDER_CHILD_ERROR is set.
async function ChildBoom(): Promise<never> {
  await Promise.resolve();
  throw new Error("async child build-time render failure (#914 fixture)");
}

export const PrerenderChildBoom = Prerender(async () => (
  <div data-testid="prerender-child-boom">
    <ChildBoom />
  </div>
));

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

// transition({ when }) is a browser predicate: a plain (server) function fails
// route discovery at dev startup and at build, naming the route. Registered
// only when RANGO_TEST_SERVER_WHEN is set, and unnamed so the static route-type
// parser leaves the committed gen file alone.
const serverWhen = (): boolean => true;

export const router = createRouter({}).routes(({ path, transition }) => [
  path("/", HomePage, { name: "home" }),
  ...(process.env.RANGO_TEST_SERVER_WHEN
    ? [
        path("/server-when/:id", HomePage, () => [
          transition({ when: serverWhen }),
        ]),
      ]
    : []),
  ...(process.env.RANGO_TEST_PRERENDER_ERROR
    ? [path("/prerender-boom", PrerenderBoom)]
    : []),
  ...(process.env.RANGO_TEST_PRERENDER_CHILD_ERROR
    ? [path("/prerender-child-boom", PrerenderChildBoom)]
    : []),
]);
