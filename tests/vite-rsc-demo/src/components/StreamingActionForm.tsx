"use client";

import { use, useActionState, Suspense } from "react";
import { useAction } from "@rangojs/router/client";
import {
  addToCartSlowly,
  type StreamingCartResult,
} from "../actions/streaming.actions.js";

export const StreamingActionStatus = () => {
  // useAction needs the module reference directly; an action passed through
  // RSC as a prop intentionally does not retain the metadata this hook reads.
  const status = useAction(addToCartSlowly);
  console.log("StreamingActionStatus", status.state);
  return (
    <div data-testid="shop-streaming-status">
      StreamingAction status: {status.state}
    </div>
  );
};
const getOwnProps = (item: any) => {
  const reflect = Reflect.ownKeys(item);
  const ownProps: Record<string, any> = {};
  reflect.forEach((key) => {
    ownProps[key as string] = (item as any)[key as string];
  });
  return ownProps;
};
export const ActionStatus = ({
  fn,
}: {
  fn: ((...args: any[]) => any) | string;
}) => {
  const status = useAction(fn);
  const name = (fn as any).$$id;
  console.log({
    name: (fn as any).$$id,
    $$typeof: (fn as any).$$typeof,
    $$id: (fn as any).$$id,
    $$bound: (fn as any).$$bound,
  });
  console.log(`${name} Status`, status.state, fn, getOwnProps(fn));
  return (
    <div>
      {name} status: {status.state}
    </div>
  );
};
/**
 * Streaming Action Form - demonstrates Promise streaming with Suspense
 *
 * The action returns a Promise that streams to the client.
 * Suspense boundary waits for it to resolve.
 */
export function StreamingActionForm({
  productId,
  children,
}: {
  productId: string | number;
  children?: React.ReactNode;
}) {
  const [state, formAction, isPending] = useActionState(addToCartSlowly, null);

  return (
    <div>
      <form action={formAction}>
        <input type="hidden" name="productId" value={String(productId)} />
        <input type="hidden" name="quantity" value="1" />
        <button
          type="submit"
          disabled={isPending}
          data-testid="shop-streaming-submit"
          style={{
            background: isPending ? "#ccc" : "#ff6b6b",
            color: "white",
            border: "none",
            padding: "0.75rem 1.5rem",
            borderRadius: "4px",
            fontSize: "1rem",
            cursor: isPending ? "not-allowed" : "pointer",
            marginTop: "1rem",
          }}
        >
          {isPending ? "Processing..." : <>{children}</>}
        </button>
      </form>
      {state && (
        <div
          style={{
            marginTop: "1rem",
            padding: "1rem",
            background: "#fff3cd",
            border: "1px solid '#ffc107'",
            borderRadius: "4px",
          }}
        >
          <Suspense
            fallback={
              <div data-testid="shop-streaming-fallback">
                <h4 style={{ margin: "0 0 0.5rem 0" }}>⏳ Streaming...</h4>
                <p style={{ margin: 0, fontSize: "0.9rem" }}>
                  Waiting for the streamed server result...
                </p>
                <div
                  style={{
                    marginTop: "0.5rem",
                    width: "100%",
                    height: "4px",
                    background: "#e0e0e0",
                    borderRadius: "2px",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: "100%",
                      height: "100%",
                      background: "#ffc107",
                      animation: "slide 1.5s ease-in-out infinite",
                    }}
                  />
                </div>
              </div>
            }
          >
            <PromiseResolver promise={state.promise} />
          </Suspense>
        </div>
      )}
    </div>
  );
}

/**
 * Component that uses() a Promise - triggers Suspense
 */
function PromiseResolver({ promise }: { promise: Promise<React.ReactNode> }) {
  // use() hook suspends until Promise resolves
  const result = use(promise);

  console.log("[PromiseResolver] Promise resolved:", result);

  return <p data-testid="shop-streaming-result">{result}</p>;
}
