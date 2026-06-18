import { Meta } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";

// C3: a document-cached route whose response carries an UNqualified
// `Cache-Control: no-cache` (alongside `s-maxage`). RFC 7234 §5.2.2.2 forbids a
// shared cache from serving a stored no-cache response without origin
// validation, and this store's hit path has no validation step, so the
// document cache must REFUSE to store it. The rendered timestamp lets an e2e
// prove the handler re-executes on every request (never a frozen HIT).
export function DocumentCacheNoCachePage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Document Cache no-cache Test - RSC Router" });
  // Unqualified no-cache: must veto storage even with s-maxage present.
  ctx.headers.set("Cache-Control", "no-cache, s-maxage=60");

  return (
    <main data-testid="document-cache-no-cache-page">
      <h1>Document Cache no-cache Test</h1>
      <p data-testid="dc-no-cache-ts">
        Rendered at: {new Date().toISOString()}
      </p>
    </main>
  );
}
