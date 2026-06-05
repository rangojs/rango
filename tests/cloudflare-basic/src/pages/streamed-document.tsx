import { Suspense } from "react";
import { Meta, cacheTag } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";

// "use cache" function tagged at runtime, awaited INSIDE a Suspense boundary
// (not in the handler) so getStreamedTs resolves DURING the RSC/HTML stream,
// AFTER handler settlement. This pins that the document-cache tag snapshot uses
// the stream-drain barrier (render complete), not the earlier handler-settlement
// barrier: under the old barrier "streamed-doc" would be missed and updateTag
// could not invalidate the cached full page.
async function getStreamedTs(): Promise<number> {
  "use cache";
  cacheTag("streamed-doc");
  return Date.now();
}

async function StreamedTs() {
  const ts = await getStreamedTs();
  return <p data-doc-ts={ts}>ts: {ts}</p>;
}

export function StreamedDocumentPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Streamed Tagged Document - RSC Router" });
  ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

  return (
    <main data-testid="streamed-document-page">
      <h1>Streamed Tagged Document</h1>
      <Suspense fallback={<p>loading</p>}>
        <StreamedTs />
      </Suspense>
    </main>
  );
}
