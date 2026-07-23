import { urls, Meta, type Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { Suspense } from "react";
import { UsePromiseContent } from "../components/UsePromiseContent.js";

/**
 * Repro + proof for "a raw <Suspense> fallback inside a streaming handler render
 * streams during client (SPA) navigation" — for BOTH cross-route and same-route
 * (param change) navigation.
 *
 * Unlike the /slow-streaming route (which uses the loading() DSL, a router-level
 * fallback), the fallback here comes from a plain <Suspense> placed in the
 * handler's render, wrapping an async server component that suspends for
 * SUSPENSE_STREAM_DELAY ms. There is deliberately NO loader and NO loading() —
 * the only fallback is the in-render <Suspense>.
 *
 * Routes:
 * - /suspense-stream        cross-route target (no param)
 * - /suspense-stream/:id    same-route param target; the streamed content is
 *                           param-dependent, so /a -> /b is a same-route nav whose
 *                           new content must re-stream (fallback, then resolved:b).
 *
 * The async child is NOT keyed: this exercises the natural behavior (a non-
 * transition update that suspends must reveal the nearest <Suspense> fallback),
 * which is the stringent case a consumer hits without extra plumbing.
 */

// Long enough that the fallback is observable across a navigation commit.
const SUSPENSE_STREAM_DELAY = 2000;

async function SlowSuspended({ id }: { id?: string }) {
  await new Promise((resolve) => setTimeout(resolve, SUSPENSE_STREAM_DELAY));
  return (
    <div data-testid="suspense-stream-content">
      resolved{id !== undefined ? `:${id}` : ""}
    </div>
  );
}

function SuspenseStreamShell({
  id,
  heading,
}: {
  id?: string;
  heading: string;
}) {
  return (
    <div data-testid="suspense-stream-page">
      <Link to="/" data-testid="suspense-stream-back">
        Back to Home
      </Link>
      <Link to="/suspense-stream/a" data-testid="suspense-stream-link-a">
        id a
      </Link>
      <Link to="/suspense-stream/b" data-testid="suspense-stream-link-b">
        id b
      </Link>
      <h1>{heading}</h1>
      <Suspense
        fallback={
          <div data-testid="suspense-stream-fallback">streaming-fallback</div>
        }
      >
        <SlowSuspended id={id} />
      </Suspense>
    </div>
  );
}

const SuspenseStreamHandler: Handler = () => (
  <SuspenseStreamShell heading="Raw Suspense streaming (no loading())" />
);

const SuspenseStreamByIdHandler: Handler<"/suspense-stream/:id"> = (ctx) => (
  <SuspenseStreamShell
    id={ctx.params.id}
    heading={`Raw Suspense streaming by id (no loading()) — ${ctx.params.id}`}
  />
);

// Identical to SuspenseStreamHandler, but ALSO pushes Meta from a slow promise.
// A/B against /suspense-stream (which streams its fallback) to isolate whether a
// promise-valued handle push blocks the navigation commit / the fallback.
const SuspenseStreamMetaHandler: Handler = (ctx) => {
  const titleP = new Promise<string>((resolve) =>
    setTimeout(() => resolve("Streamed Title"), SUSPENSE_STREAM_DELAY),
  );
  ctx.use(Meta)(titleP.then((t) => ({ title: t })));
  return <SuspenseStreamShell heading="Raw Suspense + Meta-from-promise" />;
};

// Exact consumer pattern: a promise is created in the handler, passed to a client
// component that use()s it under a raw <Suspense> (NOT an RSC async component), and
// the deferred Meta is derived from the SAME promise. The fallback must stream and
// the content/title must resolve — the deferred meta must not hold the content.
const PlpMetaHandler: Handler = (ctx) => {
  const dataPromise = new Promise<{ title: string }>((resolve) =>
    setTimeout(() => resolve({ title: "PLP Meta Title" }), 2000),
  );
  ctx.use(Meta)(dataPromise.then((d) => ({ title: d.title })));
  return (
    <Suspense fallback={<div data-testid="plp-meta-loading">loading</div>}>
      <UsePromiseContent promise={dataPromise} />
    </Suspense>
  );
};

// transition() forces the startTransition commit path (the same path SWR /
// stale-revalidation uses on a revisit). Content (use(promise)) resolves at 2s;
// the deferred Meta is a SEPARATE, SLOWER promise (4s) — mirrors the reported case
// where the SEO meta resolves later than the page data. Without the store
// resolution, the transition waits for the suspending MetaTags too -> held to 4s.
const PlpMetaTxHandler: Handler = (ctx) => {
  const contentPromise = new Promise<{ title: string }>((resolve) =>
    setTimeout(() => resolve({ title: "TX Content" }), 2000),
  );
  const metaPromise = new Promise<string>((resolve) =>
    setTimeout(() => resolve("TX Meta Title (slow)"), 5000),
  );
  ctx.use(Meta)(metaPromise.then((t) => ({ title: t })));
  return (
    <Suspense fallback={<div data-testid="plp-tx-loading">loading</div>}>
      <UsePromiseContent promise={contentPromise} />
    </Suspense>
  );
};

export const suspenseStreamPatterns = urls(({ path, transition }) => [
  path("/suspense-stream", SuspenseStreamHandler, { name: "suspenseStream" }),
  path("/plp-meta", PlpMetaHandler, { name: "plpMeta" }),
  transition(() => [
    path("/plp-meta-tx", PlpMetaTxHandler, { name: "plpMetaTx" }),
  ]),
  path("/suspense-stream/:id", SuspenseStreamByIdHandler, {
    name: "suspenseStreamById",
  }),
  path("/suspense-stream-meta", SuspenseStreamMetaHandler, {
    name: "suspenseStreamMeta",
  }),
]);
