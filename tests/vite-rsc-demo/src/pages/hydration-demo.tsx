import { Suspense } from "react";
import { Link, Outlet } from "@rangojs/router/client";
import {
  ConstantReader,
  LateHandleContent,
  LateStateReader,
  LateStateWriter,
  NoteCountReader,
  OtherPageReaders,
  PageStateReader,
} from "../components/hydration-demo/readers.js";
import { HydrationDemoLocationState } from "../loaders/hydration-demo.js";

/**
 * Hydration from the stream. Open a page with the network throttled (or a long
 * `?delay=`) and watch the counters:
 *
 * - /hydration/late-handle: the route's loader pushes a note after an await,
 *   inside the route's loading() boundary. The note is not in the server HTML.
 *   Every reader hydrates with what the server rendered; once the document has
 *   streamed and every boundary has hydrated, the late note reaches them.
 *   "Notes" goes from 2 to 3 and re-renders once; the constant reader never
 *   re-renders.
 * - "Location state, sent with the link": the Link carries the state to
 *   /hydration/late-state. The page's reader shows it in the commit that shows
 *   the page, while the late boundary still loads; the boundary's reader shows
 *   it when the boundary resolves. Nothing waits for hydration on a
 *   navigation.
 * - Reloading /hydration/late-state: the server never sees history state, so
 *   the document renders "empty" and readers hydrate as "empty". The entry's
 *   stored state shows once every boundary has hydrated. write() stores a
 *   value on the entry without re-rendering readers; reload to see it.
 * - Navigating away from /hydration/late-handle while "Loading the late
 *   note" is on screen: the new page commits with no hydration error.
 */
export function HydrationLayout() {
  return (
    <div style={{ maxWidth: "900px", margin: "0 auto", padding: "2rem" }}>
      <h1>Hydration from the stream</h1>
      <nav style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
        <Link to="/hydration" data-testid="hyd-link-index">
          Overview
        </Link>
        <Link to="/hydration/late-handle" data-testid="hyd-link-late-handle">
          Late handle
        </Link>
        <Link to="/hydration/late-state" data-testid="hyd-link-late-state">
          Location state
        </Link>
        <Link
          to="/hydration/late-state?delay=2500"
          state={[HydrationDemoLocationState({ label: "sent with the link" })]}
          data-testid="hyd-link-state-with-link"
        >
          Location state, sent with the link
        </Link>
        <Link to="/hydration/other" data-testid="hyd-link-other">
          Other page
        </Link>
      </nav>
      <NoteCountReader />
      <ConstantReader />
      <Outlet />
    </div>
  );
}

export function HydrationIndexPage() {
  return (
    <section data-testid="hyd-index">
      <p>
        Each page here hydrates content that streams in after the root has
        hydrated. Readers render what the server rendered first, and the router
        store hands them its later values once every boundary has hydrated.
      </p>
      <ul>
        <li>
          <strong>Late handle</strong>: a loader pushes a note after an await.
          Try <code>/hydration/late-handle?delay=3000</code>.
        </li>
        <li>
          <strong>Location state, sent with the link</strong>: the page shows
          the state as soon as it commits, while its late boundary still loads.
        </li>
        <li>
          <strong>Location state on a reload</strong>: the server renders
          without history state, so readers hydrate as "empty" and show the
          stored state once every boundary has hydrated. Use the link above or
          "Write location state", then reload{" "}
          <code>/hydration/late-state?delay=3000</code>.
        </li>
        <li>
          <strong>Navigate mid-stream</strong>: open the late handle page with a
          long delay and click "Other page" while it is still loading.
        </li>
      </ul>
    </section>
  );
}

export function LateHandlePage() {
  return <LateHandleContent />;
}

async function DelayedStateReader({ delay }: { delay: number }) {
  await new Promise((resolve) => setTimeout(resolve, delay));
  return <LateStateReader />;
}

export function LateStatePage({ delay }: { delay: number }) {
  return (
    <section data-testid="hyd-late-state">
      <LateStateWriter />
      <PageStateReader />
      <Suspense
        fallback={
          <p data-testid="hyd-state-fallback">Waiting for the late boundary</p>
        }
      >
        <DelayedStateReader delay={delay} />
      </Suspense>
    </section>
  );
}

export function HydrationOtherPage() {
  return (
    <section>
      <p data-testid="hyd-other">Another page of the hydration demo.</p>
      <OtherPageReaders />
    </section>
  );
}
