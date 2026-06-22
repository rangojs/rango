import { urls, type Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";
import { Suspense } from "react";

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

export const suspenseStreamPatterns = urls(({ path }) => [
  path("/suspense-stream", SuspenseStreamHandler, { name: "suspenseStream" }),
  path("/suspense-stream/:id", SuspenseStreamByIdHandler, {
    name: "suspenseStreamById",
  }),
]);
