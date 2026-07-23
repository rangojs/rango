export function HomePage() {
  return (
    <main data-testid="home">
      <h1>Rango on Vercel</h1>
      <p>
        A minimal Rango app deployed to Vercel Functions, caching segment and
        function results in the Vercel Runtime Cache via{" "}
        <code>VercelCacheStore</code>.
      </p>
      <p>
        Visit <strong>/cached</strong> to see the Runtime Cache store in action.
      </p>
      <p>
        Open <strong>/cache-lab</strong> to inspect tagged function values, a
        PPR shell, streamed metadata, and tag invalidation together.
      </p>
    </main>
  );
}
