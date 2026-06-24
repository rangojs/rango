import { Meta, getRequestContext } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";
import { triggerSwrRevalidation } from "../actions/swr-revalidate.js";

// Regression repro: a "use cache" function that reads the ambient request
// context via the standalone getRequestContext() (the AsyncLocalStorage seat),
// mirroring the real consumer pattern `getRequestContext().env.ApiKey` used to
// read a binding (an API key, a KV namespace) inside cached CMS data fetching.
//
// On a stale hit the function re-executes in a background waitUntil task. On
// workerd that task runs detached from the request's I/O context, so unless the
// background path re-establishes the request-context ALS, getRequestContext()
// throws "called outside of a request context", the revalidation fails, and the
// cached value is frozen forever (it never refreshes from the stale value).
//
// Short TTL (2s) via the swr-ctx profile so the stale window opens fast; wide
// SWR window (120s) so the entry stays in the stale-serve range for the test.
async function getSwrCtxData(): Promise<{
  ts: number;
  rand: number;
  hasEnv: boolean;
}> {
  "use cache: swr-ctx";
  const ctx = getRequestContext();
  // Touch an env binding the way a real CMS fetch would (getRequestContext().env
  // .ApiKey). The getRequestContext() call itself is what throws when the
  // background revalidation runs outside the request context.
  const hasEnv = typeof ctx.env === "object" && ctx.env !== null;
  return { ts: Date.now(), rand: Math.random(), hasEnv };
}

export async function SwrCtxPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "SWR + getRequestContext Cache Test - RSC Router" });

  const data = await getSwrCtxData();
  const serverNow = Date.now();
  return (
    <main data-testid="swr-ctx-page">
      <h1>SWR + getRequestContext</h1>
      <p data-testid="swr-ctx-ts">{data.ts}</p>
      <p data-testid="swr-ctx-rand">{data.rand}</p>
      <p data-testid="swr-ctx-has-env">{String(data.hasEnv)}</p>
      <p data-testid="swr-ctx-server-ts">{serverNow}</p>
    </main>
  );
}

// Opt-in foreground-on-action variant: the "use cache: swr-action" profile sets
// foregroundOnAction:true. A plain navigation keeps SWR, but a server action's
// revalidation render re-executes a stale entry in the foreground so the action
// response reflects a fresh value.
async function getSwrActionData(): Promise<{
  ts: number;
  rand: number;
  hasEnv: boolean;
}> {
  "use cache: swr-action";
  const ctx = getRequestContext();
  const hasEnv = typeof ctx.env === "object" && ctx.env !== null;
  return { ts: Date.now(), rand: Math.random(), hasEnv };
}

export async function SwrActionPage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "SWR foregroundOnAction Cache Test - RSC Router" });

  const data = await getSwrActionData();
  return (
    <main data-testid="swr-action-page">
      <h1>SWR foregroundOnAction</h1>
      <p data-testid="swr-action-ts">{data.ts}</p>
      <p data-testid="swr-action-rand">{data.rand}</p>
      <p data-testid="swr-action-has-env">{String(data.hasEnv)}</p>
      {/* DIRECT server action form so it works under BOTH JS and no-JS
          progressive enhancement (the PE re-render must foreground too). */}
      <form action={triggerSwrRevalidation}>
        <button type="submit" data-testid="swr-action-btn">
          Trigger Action Revalidation
        </button>
      </form>
    </main>
  );
}
