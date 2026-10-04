"use client";

import { Suspense, useEffect } from "react";
import {
  clientUrls,
  Link,
  useLoader,
  useLocationState,
  useOutlet,
  useParams,
  usePathname,
} from "@rangojs/router/client";
import {
  ClientUrlsSlowLoader,
  ClientUrlsSlowRedirectLoader,
} from "./loader.js";
import { SlowNote } from "../location-states.js";

// Group behind a 5s server middleware (urls.tsx) — optimistic destination
// contract, see e2e/client-urls-slow.test.ts.

/**
 * #1029 probe: a SlowNote reader next to the identity of the tree it sits in
 * (a pathname or a param). Each (identity, note) pair it commits is appended
 * to `window.__cusStateCommits` as `<where>|<identity>|<note>`, so the e2e
 * sees a pair that was on screen for one frame too.
 */
function SlowState({ where, identity }: { where: string; identity: string }) {
  const note = useLocationState(SlowNote)?.value ?? "none";
  const commit = `${where}|${identity}|${note}`;
  useEffect(() => {
    ((window as { __cusStateCommits?: string[] }).__cusStateCommits ??=
      []).push(commit);
  }, [commit]);
  return <p data-testid={`cus-${where}-note`}>{note}</p>;
}

/** Chrome OUTSIDE the group (rendered by the server parent layout): its route
 *  hooks keep the COMMITTED location during the optimistic window. */
export function SlowChrome() {
  const pathname = usePathname();
  return (
    <>
      <p data-testid="cus-chrome-pathname">{pathname}</p>
      <SlowState where="chrome" identity={pathname} />
    </>
  );
}

function SlowLayout() {
  const { content, pending } = useOutlet();
  return (
    <section data-testid="cus-layout" data-pending={String(pending)}>
      <SlowState where="layout" identity={usePathname()} />
      {content}
    </section>
  );
}

function SlowA() {
  return (
    <div data-testid="cus-a">
      <SlowState where="a" identity="a" />
      <Link
        to="/client-urls-slow/b/first"
        prefetch="none"
        data-testid="cus-a-to-b"
      >
        To B
      </Link>
      <Link
        to="/client-urls-slow/b/first"
        state={[SlowNote({ value: "for-first" })]}
        prefetch="none"
        data-testid="cus-a-to-b-note"
      >
        To B with a note
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
      <SlowState where="b" identity={tag} />
      {/* Local state typed during the optimistic window must survive the
          canonical commit (group-keyed segment keeps this instance). */}
      <input data-testid="cus-b-input" defaultValue="" />
      <Suspense fallback={<p data-testid="cus-b-skeleton">loading data</p>}>
        <SlowData testId="cus-b-loader" />
      </Suspense>
      <Link to="/client-urls-slow/c" prefetch="hover" data-testid="cus-b-to-c">
        To C
      </Link>
      {/* Same route record, another param: the content is held. */}
      <Link
        to="/client-urls-slow/b/second"
        state={[SlowNote({ value: "for-second" })]}
        prefetch="none"
        data-testid="cus-b-to-b-note"
      >
        To B second with a note
      </Link>
      {/* E suspends with no boundary: B stays until E commits. */}
      <Link
        to="/client-urls-slow/e"
        state={[SlowNote({ value: "for-e" })]}
        prefetch="none"
        data-testid="cus-b-to-e-note"
      >
        To E with a note
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
  return (
    <>
      <div data-testid="cus-e">{data}</div>
      <SlowState where="e" identity="e" />
    </>
  );
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
