import {
  urls,
  Prerender,
  Static,
} from "@rangojs/router";
import { Link } from "@rangojs/router/client";

export const TransformStatic = Static(() => (
  <div data-testid="cf-transform-static">
    cf-transform-static
    <Link
      to="/transform-cases/state"
      data-testid="cf-transform-state-link"
    >
      Go to state page
    </Link>
  </div>
));

export const TransformPrerender = Prerender(() => (
  <div data-testid="cf-transform-prerender-page">cf-transform-prerender</div>
));

export const transformCasesPatterns = urls(({ path }) => [
  path("/", TransformStatic, { name: "index" }),
  path(
    "/state",
    () => <div data-testid="cf-transform-state-page">cf-transform-state</div>,
    { name: "state" },
  ),
  path("/prerendered", TransformPrerender, { name: "prerendered" }),
]);
