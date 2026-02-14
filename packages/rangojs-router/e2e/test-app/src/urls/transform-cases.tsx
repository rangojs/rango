import {
  urls,
  createPrerenderHandler,
  createStaticHandler,
} from "@rangojs/router";
import { Link } from "@rangojs/router/client";

export const TransformStatic = createStaticHandler(() => (
  <div data-testid="transform-cases-static">
    transform-cases-static
    <Link
      data-testid="transform-cases-state-link"
      to="/transform-cases/state"
    >
      Go to state page
    </Link>
  </div>
));

export const TransformPrerender = createPrerenderHandler(() => (
  <div data-testid="transform-cases-prerender-page">transform-cases-prerender</div>
));

export const transformCasesPatterns = urls(({ path }) => [
  path("/", TransformStatic, { name: "index" }),
  path(
    "/state",
    () => <div data-testid="transform-cases-state-page">transform-cases-state</div>,
    { name: "state" },
  ),
  path("/prerendered", TransformPrerender, { name: "prerendered" }),
]);
