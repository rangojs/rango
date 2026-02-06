import { Outlet, Link } from "@rangojs/router/client";

/**
 * Proactive caching test layout - inside cache boundary
 */
export function ProactiveCacheLayout() {
  return (
    <div data-testid="proactive-cache-layout">
      <h2 data-testid="proactive-layout-title">Proactive Cache Layout</h2>
      <p data-testid="proactive-layout-rendered">
        Layout rendered at: {new Date().toISOString()}
      </p>
      <nav data-testid="proactive-nav">
        <Link to="/" data-testid="proactive-back-home">← Home</Link>
        {" | "}
        <Link to="/proactive-cache" data-testid="proactive-nav-index">Index</Link>
        {" | "}
        <Link to="/proactive-cache/item-a" data-testid="proactive-nav-a">Item A</Link>
        {" | "}
        <Link to="/proactive-cache/item-b" data-testid="proactive-nav-b">Item B</Link>
      </nav>
      <Outlet />
    </div>
  );
}
