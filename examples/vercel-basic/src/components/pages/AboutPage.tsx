export function AboutPage() {
  return (
    <main data-testid="about">
      <h1>About</h1>
      <p>
        This example is built with the Rango node preset and deployed through
        the Vercel Build Output API. The server runs as a single Node Function
        that streams the RSC/HTML response; static client assets are served from
        the CDN. See the README for the deploy steps.
      </p>
    </main>
  );
}
