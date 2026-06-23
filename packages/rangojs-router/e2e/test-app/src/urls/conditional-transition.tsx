import { urls, createVar, type Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

/**
 * Conditional transition: transition({ when }) gates the startTransition hold
 * per request. The route handler sets a mark from the :hold param; the `when`
 * predicate — evaluated server-side AFTER the handler runs — reads it via
 * ctx.get. The hold is observable on a SAME-route param nav (:n a -> b), which
 * re-suspends the existing boundary: when the predicate holds, the previous
 * content is held (no loading() skeleton flash); otherwise the skeleton
 * re-streams. Exercises the post-handler ordering (the predicate sees ctx.set)
 * and is covered in both dev and production.
 */
export const TxHoldMark = createVar<boolean>();

// Async server component, param-dependent so a same-route :n change re-suspends.
// Slow enough that the loading() skeleton is observable when NOT held.
async function TxWhenContent({ hold, n }: { hold: string; n: string }) {
  await new Promise((resolve) => setTimeout(resolve, 800));
  return (
    <div data-testid="tx-when-content">
      <span data-testid="tx-when-n">{n}</span>
      {/* prefetch="none": a hover-prefetched target would arrive fully-resolved
          and suppress the skeleton regardless of the transition, making the
          re-stream assertion flaky. Force every nav cold. */}
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

export const conditionalTransitionPatterns = urls(
  ({ path, loading, transition }) => [
    path("/tx-when/:hold/:n", TxWhenHandler, { name: "txWhen" }, () => [
      transition({ when: (ctx) => ctx.get(TxHoldMark) === true }),
      loading(<div data-testid="tx-when-loading">tx-when-loading</div>),
    ]),
  ],
);
