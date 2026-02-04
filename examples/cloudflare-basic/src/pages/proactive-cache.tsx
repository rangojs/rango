import { Link, Outlet } from "@rangojs/router/client";
import { href } from "../router.js";

export function ProactiveCacheLayout() {
  return (
    <div data-testid="proactive-cache-layout">
      <h2 data-testid="proactive-layout-title">Proactive Cache Layout</h2>
      <p data-testid="proactive-layout-rendered">Layout rendered at: {new Date().toISOString()}</p>
      <nav data-testid="proactive-nav">
        <Link to={href("home")} data-testid="proactive-back-home">Home</Link>
        {" | "}
        <Link to={href("proactiveCache")} data-testid="proactive-nav-index">Index</Link>
        {" | "}
        <Link to={href("proactiveCacheItemA")} data-testid="proactive-nav-a">Item A</Link>
        {" | "}
        <Link to={href("proactiveCacheItemB")} data-testid="proactive-nav-b">Item B</Link>
      </nav>
      <Outlet />
    </div>
  );
}

export function ProactiveCacheIndexPage() {
  return (
    <div data-testid="proactive-index-page">
      <h3>Proactive Cache Index</h3>
      <p data-testid="proactive-index-rendered">Index rendered at: {new Date().toISOString()}</p>
    </div>
  );
}

export function ProactiveCacheItemAPage() {
  return (
    <div data-testid="proactive-item-a-page">
      <h3>Item A</h3>
      <p data-testid="proactive-item-a-rendered">Item A rendered at: {new Date().toISOString()}</p>
    </div>
  );
}

export function ProactiveCacheItemBPage() {
  return (
    <div data-testid="proactive-item-b-page">
      <h3>Item B</h3>
      <p data-testid="proactive-item-b-rendered">Item B rendered at: {new Date().toISOString()}</p>
    </div>
  );
}
