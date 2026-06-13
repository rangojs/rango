import { Meta, cacheTag } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";

// A "use cache" function tagged at runtime. Its tag is recorded into the
// request-scoped tag set during render, so the document cache entry for this
// full page is tagged "doc-page" and can be invalidated by updateTag("doc-page").
// This exercises the document-level tag invalidation path end to end.
async function getTaggedDocTs(): Promise<number> {
  "use cache";
  cacheTag("doc-page");
  return Date.now();
}

export async function TaggedDocumentPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Tagged Document Cache Test - RSC Router" });
  // Make the full-page response document-cacheable.
  ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

  const ts = await getTaggedDocTs();
  return (
    <main data-testid="tagged-document-page">
      <h1>Tagged Document Cache</h1>
      <p data-doc-ts={ts}>Rendered ts: {ts}</p>
    </main>
  );
}
