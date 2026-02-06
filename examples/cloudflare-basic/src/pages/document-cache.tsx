import { Meta } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";

export function DocumentCachePage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Document Cache Test - RSC Router" });
  ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

  return (
    <main data-testid="document-cache-page">
      <h1>Document Cache Test</h1>
      <p>Rendered at: {new Date().toISOString()}</p>
      <p>Check response headers for <code>x-document-cache-status</code></p>
    </main>
  );
}
