import { urls, createVar, type Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

/**
 * Cloudflare-basic mirror of the router e2e app's /tx-when/:hold/:n
 * (conditional-transition), per the repo's both-apps e2e mandate. Verifies
 * transition({ when }) end-to-end in cloudflare-basic, dev + production.
 *
 * The handler sets a mark from :hold; the post-handler `when` predicate reads it
 * via ctx.get. A same-route :n change (a -> b) re-suspends the existing boundary:
 * with the transition kept (hold=1) the previous content is held — no
 * tx-when-loading flash; with it dropped (hold=0) the skeleton re-streams.
 */
export const TxHoldMark = createVar<boolean>();

async function TxWhenContent({ hold, n }: { hold: string; n: string }) {
  // Slow enough that the loading() skeleton is observable when NOT held.
  await new Promise((resolve) => setTimeout(resolve, 800));
  return (
    <div data-testid="tx-when-content">
      <span data-testid="tx-when-n">{n}</span>
      <Link
        to={`/tx-when/${hold}/a`}
        data-testid="tx-when-to-a"
        prefetch="none"
      >
        a
      </Link>
      <Link
        to={`/tx-when/${hold}/b`}
        data-testid="tx-when-to-b"
        prefetch="none"
      >
        b
      </Link>
    </div>
  );
}

const TxWhenHandler: Handler<"/tx-when/:hold/:n"> = (ctx) => {
  ctx.set(TxHoldMark, ctx.params.hold === "1");
  return <TxWhenContent hold={ctx.params.hold} n={ctx.params.n} />;
};

/**
 * Source-based gate mirror: the `when` predicate reads `currentParams` (the
 * navigation source) instead of a handler-set mark — `currentParams?.n !== "b"`
 * holds the transition unless you arrive FROM n=b. The `!== "b"` shape returns
 * true on the initial full load (currentParams undefined) so the route mounts
 * inside a transition scope; otherwise the first render would drop the
 * transition and later navs would remount regardless of source. Pins the
 * revalidate-shaped nav metadata end-to-end in cloudflare-basic too (both-apps
 * mandate).
 */
async function TxSrcContent({ n }: { n: string }) {
  await new Promise((resolve) => setTimeout(resolve, 800));
  return (
    <div data-testid="tx-src-content">
      <span data-testid="tx-src-n">{n}</span>
      <Link to="/tx-src/a" data-testid="tx-src-to-a" prefetch="none">
        a
      </Link>
      <Link to="/tx-src/b" data-testid="tx-src-to-b" prefetch="none">
        b
      </Link>
    </div>
  );
}

const TxSrcHandler: Handler<"/tx-src/:n"> = (ctx) => (
  <TxSrcContent n={ctx.params.n} />
);

export const txWhenPatterns = urls(({ path, loading, transition }) => [
  path("/tx-when/:hold/:n", TxWhenHandler, { name: "txWhen" }, () => [
    transition({ when: (ctx) => ctx.get(TxHoldMark) === true }),
    loading(<div data-testid="tx-when-loading">tx-when-loading</div>),
  ]),
  path("/tx-src/:n", TxSrcHandler, { name: "txSrc" }, () => [
    transition({ when: ({ currentParams }) => currentParams?.n !== "b" }),
    loading(<div data-testid="tx-src-loading">tx-src-loading</div>),
  ]),
]);
