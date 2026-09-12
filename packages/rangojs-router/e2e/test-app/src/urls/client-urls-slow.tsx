"use client";

import { Suspense } from "react";
import {
  clientUrls,
  Link,
  useLoader,
  useOutlet,
  useParams,
  usePathname,
} from "@rangojs/router/client";
import {
  ClientUrlsSlowLoader,
  ClientUrlsSlowRedirectLoader,
} from "./client-urls.loader.js";

// Group behind a 5s server middleware (urls.tsx); scenarios in
// docs/design/client-urls-optimistic-destination.md and client-urls-slow.test.ts.

/** Chrome OUTSIDE the group (rendered by the server parent layout): its route
 *  hooks keep the COMMITTED location during the optimistic window. */
export function SlowChrome() {
  return <p data-testid="cus-chrome-pathname">{usePathname()}</p>;
}

function SlowLayout() {
  const { content, pending } = useOutlet();
  return (
    <section data-testid="cus-layout" data-pending={String(pending)}>
      {content}
    </section>
  );
}

function SlowA() {
  return (
    <div data-testid="cus-a">
      <Link
        to="/client-urls-slow/b/first"
        prefetch="none"
        data-testid="cus-a-to-b"
      >
        To B
      </Link>
    </div>
  );
}

function SlowData({ testId }: { testId: string }) {
  const { data } = useLoader(ClientUrlsSlowLoader);
  return <p data-testid={testId}>{data}</p>;
}

// D's own loader: it redirects, so this read never settles — the skeleton
// stays until the redirect replaces the branch.
function SlowRedirectData() {
  useLoader(ClientUrlsSlowRedirectLoader);
  return <p data-testid="cus-d-loader">unreachable</p>;
}

// B renders its own chrome immediately; only the loader read waits, behind an
// inline boundary. Route hooks inside describe B (the optimistic branch).
function SlowB() {
  const { tag } = useParams<{ tag: string }>();
  return (
    <div data-testid="cus-b">
      <h2>Page B</h2>
      <p data-testid="cus-b-param">{tag}</p>
      <p data-testid="cus-b-pathname">{usePathname()}</p>
      <Suspense fallback={<p data-testid="cus-b-skeleton">loading data</p>}>
        <SlowData testId="cus-b-loader" />
      </Suspense>
      <Link to="/client-urls-slow/c" prefetch="hover" data-testid="cus-b-to-c">
        To C
      </Link>
    </div>
  );
}

function SlowC() {
  const { data } = useLoader(ClientUrlsSlowLoader);
  return (
    <div data-testid="cus-c">
      <p data-testid="cus-c-loader">{data}</p>
      <Link to="/client-urls-slow/d" prefetch="none" data-testid="cus-c-to-d">
        To D
      </Link>
      <Link to="/client-urls-slow/e" prefetch="none" data-testid="cus-c-to-e">
        To E
      </Link>
    </div>
  );
}

// D's loader redirects: D's chrome presents at once, the redirect lands after
// the middleware and replaces it.
function SlowD() {
  return (
    <div data-testid="cus-d">
      <Suspense fallback={<p data-testid="cus-d-skeleton">loading D</p>}>
        <SlowRedirectData />
      </Suspense>
    </div>
  );
}

// E reads its loader with NO boundary: the optimistic render suspends in the
// transition lane, so the current page stays until the canonical commit.
function SlowE() {
  const { data } = useLoader(ClientUrlsSlowLoader);
  return <div data-testid="cus-e">{data}</div>;
}

export default clientUrls(({ layout, path, loader }) => [
  layout(SlowLayout, () => [
    path("/", SlowA, { name: "a" }),
    path("/b/:tag", SlowB, { name: "b" }, () => [loader(ClientUrlsSlowLoader)]),
    path("/c", SlowC, { name: "c" }, () => [loader(ClientUrlsSlowLoader)]),
    path("/d", SlowD, { name: "d" }, () => [
      loader(ClientUrlsSlowRedirectLoader),
    ]),
    path("/e", SlowE, { name: "e" }, () => [loader(ClientUrlsSlowLoader)]),
  ]),
]);
