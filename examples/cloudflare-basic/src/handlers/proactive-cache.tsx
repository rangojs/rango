import { map } from "@ivogt/rsc-router/server";
import { Link, Outlet } from "@ivogt/rsc-router/client";
import type { proactiveCacheRoutes } from "../routes.js";

/**
 * Proactive caching test routes.
 * Layout is INSIDE cache boundary, so navigating between items
 * will have null layout component (client has it), triggering proactive caching.
 */
export default map<typeof proactiveCacheRoutes>(({ route, layout, cache }) => [
  cache({ ttl: 600 }, () => [
    layout(
      () => (
        <div data-testid="proactive-cache-layout">
          <h2 data-testid="proactive-layout-title">Proactive Cache Layout</h2>
          <p data-testid="proactive-layout-rendered">
            Layout rendered at: {new Date().toISOString()}
          </p>
          <nav data-testid="proactive-nav">
            <Link to="/" data-testid="proactive-back-home">
              Home
            </Link>
            {" | "}
            <Link to="/proactive-cache" data-testid="proactive-nav-index">
              Index
            </Link>
            {" | "}
            <Link to="/proactive-cache/item-a" data-testid="proactive-nav-a">
              Item A
            </Link>
            {" | "}
            <Link to="/proactive-cache/item-b" data-testid="proactive-nav-b">
              Item B
            </Link>
          </nav>
          <Outlet />
        </div>
      ),
      () => [
        route("proactiveCache", () => (
          <div data-testid="proactive-index-page">
            <h3>Proactive Cache Index</h3>
            <p data-testid="proactive-index-rendered">
              Index rendered at: {new Date().toISOString()}
            </p>
          </div>
        )),

        route("proactiveCacheItemA", () => (
          <div data-testid="proactive-item-a-page">
            <h3>Item A</h3>
            <p data-testid="proactive-item-a-rendered">
              Item A rendered at: {new Date().toISOString()}
            </p>
          </div>
        )),

        route("proactiveCacheItemB", () => (
          <div data-testid="proactive-item-b-page">
            <h3>Item B</h3>
            <p data-testid="proactive-item-b-rendered">
              Item B rendered at: {new Date().toISOString()}
            </p>
          </div>
        )),
      ]
    ),
  ]),
]);
