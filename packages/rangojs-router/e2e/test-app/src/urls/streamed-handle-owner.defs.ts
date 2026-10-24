import { Breadcrumbs, createLoader } from "@rangojs/router";

// e2e streamed-handle-owner.test.ts. Each push in this fixture follows one of
// two short awaits, by the route's :wait param.
export const SHO_WAITS = ["microtasks", "timer"] as const;

/**
 * `microtasks`: eight `await Promise.resolve()`, enough for the walker to
 * pin the next segment before the push (one is not); `timer`: a
 * setTimeout(0).
 */
export async function shoPause(wait: string): Promise<void> {
  if (wait === "timer") {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return;
  }
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Pushes "Inner"; ShoOuterLoader's body starts it after its pause. */
export const ShoInnerLoader = createLoader(async (ctx) => {
  ctx.use(Breadcrumbs)({
    label: "Inner",
    href: `/streamed-handle-owner/${ctx.params.wait}/loader#inner`,
  });
  return null;
});

/** A route's loader() that starts ShoInnerLoader after its pause. */
export const ShoOuterLoader = createLoader(async (ctx) => {
  await shoPause(ctx.params.wait ?? "");
  await ctx.use(ShoInnerLoader);
  return null;
});
