import { Meta } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";

// A full page that is BOTH document-cached (Cache-Control: s-maxage) AND wrapped
// in a route-level cache({ tags: ["dsl-doc-page"] }) in urls.tsx. Unlike
// /tagged-document (which tags via a runtime cacheTag() inside "use cache",
// recorded during the render), the tag here comes from the segment-DSL cache()
// config. That tag is recorded into the request tag union by the cache-store
// middleware, which schedules the segment write via waitUntil -- so the document
// cache entry must still carry "dsl-doc-page" from the FIRST write (before that
// deferred write runs) to be invalidatable by updateTag("dsl-doc-page").
export async function DslTaggedDocumentPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "DSL-Tagged Document Cache Test - RSC Router" });
  // Cache-Control (document-cacheability) is set by a middleware inside the
  // route-level cache() scope in urls.tsx (the blog-route pattern). A cache()-
  // wrapped component's own ctx.headers.set() does not propagate to the document
  // response, so the header must come from middleware in the scope.

  const ts = Date.now();
  return (
    <main data-testid="dsl-tagged-document-page">
      <h1>DSL-Tagged Document Cache</h1>
      <p data-doc-ts={ts}>Rendered ts: {ts}</p>
    </main>
  );
}
