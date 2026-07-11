export function CachedTimePage() {
  const renderedAt = new Date().toISOString();
  return (
    <main data-testid="cached">
      <h1>Cached page</h1>
      <p>
        Rendered at:{" "}
        <time data-testid="rendered-at" dateTime={renderedAt}>
          {renderedAt}
        </time>
      </p>
      <p>
        This route is wrapped in{" "}
        <code>cache(&#123; ttl: 10, swr: 30, tags: ["time"] &#125;)</code>.
        Within the TTL the timestamp stays frozen (a cache hit); after it, the
        next request serves the stale value and revalidates in the background.
      </p>
    </main>
  );
}
