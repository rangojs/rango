import { Link } from "@rangojs/router/client";

/**
 * Test page for prefetch strategies.
 * Contains links with different prefetch modes and a tall spacer
 * so viewport-based prefetching can be tested with scroll behavior.
 */
export function PrefetchTestPage() {
  return (
    <div>
      <h1>Prefetch Test</h1>

      <section data-testid="viewport-visible">
        <h2>Viewport Links (visible on load)</h2>
        <Link to="/blog" prefetch="viewport">
          Blog (viewport)
        </Link>
      </section>

      <section data-testid="render-links">
        <h2>Render Links</h2>
        <Link to="/about" prefetch="render">
          About (render)
        </Link>
      </section>

      <section data-testid="adaptive-links">
        <h2>Adaptive Links</h2>
        <Link to="/magazine" prefetch="adaptive">
          Magazine (adaptive)
        </Link>
      </section>

      {/* Tall spacer to push below-fold links out of viewport */}
      <div style={{ height: "3000px" }} data-testid="spacer" />

      <section data-testid="viewport-below-fold">
        <h2>Below Fold Viewport Links</h2>
        <Link to="/shop" prefetch="viewport">
          Shop (viewport, below fold)
        </Link>
      </section>
    </div>
  );
}
