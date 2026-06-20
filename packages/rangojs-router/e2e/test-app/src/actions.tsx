"use server";

import { ReactNode } from "react";
import {
  cookies,
  getRequestContext,
  invalidateClientCache,
  keepClientCache,
  redirect,
  updateTag,
} from "@rangojs/router";
import {
  ActionInfoA,
  ActionInfoB,
  FlashMessage,
  NonSerializableState,
} from "./location-states.js";
import {
  getCurrentCart,
  getCartQuantitySync,
  resetCurrentCart,
} from "./cart-store.js";

// Simulated delay helper
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Add item to cart - fire and forget pattern
 */
export async function addToCart(productId: string): Promise<void> {
  await delay(100);
  const cart = getCurrentCart();
  const current = cart.get(productId) || 0;
  cart.set(productId, current + 1);
}

/**
 * Add item to cart with result - returns confirmation
 */
export async function addToCartWithResult(
  productId: string,
): Promise<{ success: boolean; quantity: number; message: string }> {
  await delay(100);
  const cart = getCurrentCart();
  const current = cart.get(productId) || 0;
  const newQuantity = current + 1;
  cart.set(productId, newQuantity);
  return {
    success: true,
    quantity: newQuantity,
    message: `Added ${productId} to cart`,
  };
}

/**
 * Update cart quantity
 */
export async function updateQuantity(
  productId: string,
  delta: number,
): Promise<{ quantity: number }> {
  await delay(50);
  const cart = getCurrentCart();
  const current = cart.get(productId) || 0;
  const newQuantity = Math.max(0, current + delta);
  if (newQuantity === 0) {
    cart.delete(productId);
  } else {
    cart.set(productId, newQuantity);
  }
  return { quantity: newQuantity };
}

/**
 * Get cart quantity for a product
 */
export async function getCartQuantity(productId: string): Promise<number> {
  return getCartQuantitySync(productId);
}

/**
 * Streaming action - takes 3 seconds to complete
 */
export async function streamingAction(
  productId: string,
): Promise<{ success: boolean; timestamp: string }> {
  await delay(3000);
  return {
    success: true,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Reset cart - for test cleanup
 */
export async function resetCart(): Promise<void> {
  resetCurrentCart();
}

// Dummy action for prerender client component tests
export async function prerenderTestAction(): Promise<{ ok: true }> {
  return { ok: true };
}

/**
 * Simple action that triggers revalidation.
 * Mutating a cookie makes the current route re-render so loader-based tests can
 * verify that registered loaders are re-executed after the action completes.
 */
export async function triggerRevalidation(): Promise<{
  triggered: boolean;
  timestamp: string;
}> {
  await delay(100);
  cookies().set("test-revalidation", new Date().toISOString(), {
    path: "/",
    maxAge: 60,
  });
  return {
    triggered: true,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Server action for form tests.
 * Compatible with useActionState: (prevState, formData) => newState
 */
export async function formTestAction(
  _prevState: { id: string; message: string; timestamp: string } | null,
  formData: FormData,
): Promise<{ id: string; message: string; timestamp: string }> {
  const id = (formData.get("id") as string) ?? "default";
  await delay(500);
  return {
    id,
    message: "Submitted via server action",
    timestamp: new Date().toISOString(),
  };
}

/**
 * Simple form action for testing progressive enhancement (no-JS)
 * Returns the submitted name to verify the form was processed
 */
let lastSubmittedName: string | null = null;

export async function submitNameAction(formData: FormData): Promise<void> {
  await delay(100);
  const name = formData.get("name") as string;
  lastSubmittedName = name;
}

export async function getLastSubmittedName(): Promise<string | null> {
  return lastSubmittedName;
}

/**
 * Session-scoped counter action for the consumer e2e harness submit-parity
 * exercise. Reads the current `parity-count` cookie, increments it by the
 * submitted `amount`, and writes it back. Because the count lives in a cookie,
 * each browser context observes only its own increments — this is what lets the
 * harness run the intent twice (JS context, then a fresh no-JS context) against
 * the one shared server and still see identical state on both transports.
 */
export async function parityCounterAction(formData: FormData): Promise<void> {
  await delay(50);
  const amount = parseInt((formData.get("amount") as string) || "1", 10);
  const current = parseInt(cookies().get("parity-count")?.value ?? "0", 10);
  cookies().set("parity-count", String(current + amount), {
    path: "/",
    maxAge: 60,
  });
}

export async function resetLastSubmittedName(): Promise<void> {
  lastSubmittedName = null;
}

/**
 * Progressive-enhancement header-preservation action. The action sets a
 * request-scoped marker cookie so the GET re-render can prove it ran, but the
 * load-bearing assertion lives in PeHeaderProbeLoader, which reads the original
 * POST request's `pe-probe` cookie during the re-render. Before the PE fix the
 * GET re-render request carried only `accept: text/html`, so the loader saw no
 * cookie under a no-JS submission. The fix copies the POST headers (minus
 * content-type/content-length) onto the GET re-render, so the loader observes
 * the request cookie under PE exactly as it does on the JS action path. State
 * lives entirely in cookies, so parallel browser contexts never interfere.
 */
export async function peHeaderSubmitAction(formData: FormData): Promise<void> {
  await delay(50);
  // Touch the form data so the action has an observable input; the real
  // assertion is the request cookie the loader reads during the re-render.
  void formData.get("note");
  cookies().set("pe-header-submitted", "yes", { path: "/", maxAge: 60 });
}

/**
 * Streaming action with React node result
 * Total time: 1s initial + 2s streaming = 3s (matches test expectations)
 */
export const StreamingAction = async (_data: FormData) => {
  await new Promise((resolve) => setTimeout(resolve, 1000)); // 1s initial delay
  return {
    promise: new Promise<ReactNode>((resolve) => {
      setTimeout(() => {
        resolve(
          <>
            <div
              style={{
                background: "#d4edda",
                padding: "1rem",
                borderRadius: "4px",
              }}
            >
              <h4 style={{ margin: "0 0 0.5rem 0" }}>Completed!</h4>
            </div>
          </>,
        );
      }, 2000); // 2s streaming delay
    }),
  };
};

/**
 * Non-redirect action that sets a distinct location-state slot after a
 * configurable delay. Dispatched concurrently in the action-ls e2e fixture so
 * the first-initiated action can resolve last: that forces one response through
 * the consolidation-needed terminal and the other through concurrent-skip — the
 * two paths that historically dropped action-set location state. The asymmetric
 * delays also let the same-key case prove last-initiated-wins independent of
 * settle order. The default action revalidation re-renders this route, so each
 * response carries a non-empty diff (the concurrent terminals require it).
 */
export async function setLocationStateSlot(
  slot: "A" | "B",
  value: string,
  delayMs: number,
): Promise<void> {
  await delay(delayMs);
  const def = slot === "A" ? ActionInfoA : ActionInfoB;
  getRequestContext().setLocationState(def({ value }));
}

/**
 * Sets the contested slot A plus a distinct marker in slot B after a delay.
 * Used by the cross-entry arbitration e2e: the marker (slot B) is uncontested,
 * so it always lands and serves as a remount-surviving "this action settled"
 * signal (history.state outlives the React component across back/forward),
 * while slot A is the value whose cohort scoping is under test.
 */
export async function setSlotWithMarker(
  value: string,
  marker: string,
  delayMs: number,
): Promise<void> {
  await delay(delayMs);
  const ctx = getRequestContext();
  ctx.setLocationState(ActionInfoA({ value }));
  ctx.setLocationState(ActionInfoB({ value: marker }));
}

/**
 * Action that redirects with a flash message.
 * Tests that server actions can use redirect() with location state.
 */
export async function saveAndRedirect(): Promise<void> {
  throw redirect("/location-state", {
    state: FlashMessage({ text: "Action saved successfully!" }),
  });
}

/**
 * Action that redirects without state (pure redirect from action).
 */
export async function actionSimpleRedirect(): Promise<void> {
  throw redirect("/location-state/target");
}

/**
 * Action that throws a redirect with flash state.
 * Tests that thrown redirect() from actions is handled correctly.
 */
export async function throwRedirectWithState(): Promise<void> {
  throw redirect("/location-state", {
    state: FlashMessage({ text: "Thrown redirect flash!" }),
  });
}

/**
 * Action that throws a redirect without state.
 */
export async function throwSimpleRedirect(): Promise<void> {
  throw redirect("/location-state/target");
}

/**
 * Action that throws a redirect carrying location state React Flight cannot
 * serialize (a function). The redirect itself is valid, so the handler returns
 * a 200 Flight redirect payload — but createRedirectFlightResponse's
 * renderToReadableStream fails serializing the function during real async
 * serialization. The fix wires that failure to onError("rendering"); without it
 * the consumer's telemetry never sees the broken stream.
 *
 * The function is stored past the typed `bad: unknown` slot; a real consumer
 * could just as easily leak a non-serializable value here by accident.
 */
export async function actionRedirectNonSerializableState(): Promise<void> {
  throw redirect("/location-state", {
    // The compile-time ValidateLocationState guard rejects functions/symbols by
    // design; the `as any` is the point of this test — it reproduces a consumer
    // who casts past that guard and leaks a non-serializable value at runtime.
    state: NonSerializableState({
      text: "redirect with non-serializable state",
      bad: () => "not serializable",
    } as any),
  });
}

/**
 * Action that throws a regular error.
 * Used to verify onError receives phase="action".
 */
export async function throwActionError(): Promise<void> {
  throw new Error("Action error for onError test");
}

/**
 * useActionState-compatible action that throws.
 * Used to prove PE form actions report phase="action" but do not currently
 * surface a stable actionId through the router boundary.
 */
export async function throwFormActionError(
  _prevState: unknown,
  _formData: FormData,
): Promise<never> {
  throw new Error("Form action error for onError test");
}

/**
 * Test action for "use cache" interleaving.
 * Returns the input and a timestamp so tests can verify
 * the action was actually invoked (different ts each call).
 */
export async function interleaveTestAction(
  input: string,
): Promise<{ result: string; ts: number }> {
  return { result: `action-result:${input}`, ts: Date.now() };
}

/**
 * Test action that uses getRequestContext().reverse() to generate URLs.
 * Verifies that RequestContext has the reverse() method available in server actions.
 */
export async function testRequestContextReverse(): Promise<{
  blogIndex: string;
  blogPost: string;
  hrefIndex: string;
}> {
  const ctx = getRequestContext();
  const blogIndex = ctx.reverse("blog.index");
  const blogPost = ctx.reverse("blog.post", { postId: "from-action" });
  const hrefIndex = ctx.reverse("href.index");
  return { blogIndex, blogPost, hrefIndex };
}

/**
 * Login action for testing action redirect revalidation.
 * Sets an auth cookie and throws redirect to the target page.
 * The redirect should cause the target route's loaders to revalidate
 * so the page shows authenticated content.
 */
export async function actionRedirectLogin(
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const email = (formData.get("email") as string)?.trim();
  if (!email) {
    return { error: "Email is required" };
  }

  cookies().set("test-auth-session", email, {
    path: "/",
    maxAge: 86400,
  });

  throw redirect("/action-redirect-revalidation");
}

/**
 * Action that sets a cookie without redirecting.
 * Used to test same-request read-after-write during revalidation:
 * the action mutates a cookie, then the subsequent render pass lets
 * route middleware and loaders observe the updated value.
 */
export async function actionSetSessionCookie(): Promise<void> {
  cookies().set("mw-session", "action-set-value", {
    path: "/",
    maxAge: 86400,
  });
}

/**
 * Action that explicitly suppresses the bridge's automatic cache invalidation
 * via keepClientCache(). Used to verify the rango state value is NOT rotated.
 */
export async function actionKeepCache(): Promise<void> {
  keepClientCache();
}

/**
 * Action that explicitly forces invalidation via invalidateClientCache() in
 * addition to keepClientCache(): invalidation must still win (the explicit
 * Set-Cookie lands regardless of the suppressed automatic path).
 */
export async function actionKeepThenInvalidate(): Promise<void> {
  keepClientCache();
  invalidateClientCache();
}

/**
 * Action for the revalidation-contract fixture.
 * It mutates a cookie so the child route has a visible signal that the action
 * follow-up render happened, without repopulating upstream ctx.set() state.
 */
export async function revalidationContractAction(): Promise<void> {
  cookies().set("revalidation-contract-action", "set", {
    path: "/",
    maxAge: 86400,
  });
}

/**
 * No-op action used by the loader handler.use e2e fixture to trigger the
 * router's default "revalidate on action" flow. If the loader's
 * handler.use-attached revalidate rule is honored, the loader must not rerun.
 */
export async function handlerUseLoaderAction(): Promise<void> {
  cookies().set("handler-use-loader-action", "fired", {
    path: "/",
    maxAge: 86400,
  });
}

/**
 * Middleware chain test action.
 * Sets a cookie, a context variable, and a response header.
 * Exercises action writes across all three channels so the
 * subsequent route middleware and loaders can verify propagation.
 */
export async function mwChainAction(): Promise<void> {
  const ctx = getRequestContext();
  cookies().set("chain-action", "av", { path: "/", maxAge: 86400 });
  ctx.set("chainAction", "from-action");
  ctx.header("X-Chain-Action", "applied");
}

/**
 * Form-based variant of mwChainAction for progressive enhancement testing.
 * Works with native HTML form POST (no-JS) and with React enhancement.
 */
/**
 * PE redirect actions for testing progressive enhancement redirect handling.
 * These are form-compatible (accept FormData) so they work with native HTML forms.
 */
export async function peReturnRedirect(_formData: FormData): Promise<void> {
  // Bound to a <form action> whose type is (formData) => void | Promise<void>.
  // This action deliberately RETURNS a redirect to exercise the runtime path
  // that follows a returned Response in PE mode; React's form-action type can't
  // express a Response return, so the cast is intrinsic here. Consumers should
  // prefer `throw redirect(...)` (see peThrowRedirect), which keeps a void return.
  return redirect("/progressive-enhancement") as any;
}

export async function peThrowRedirect(_formData: FormData): Promise<void> {
  throw redirect("/progressive-enhancement");
}

export async function peExternalRedirectBlocked(
  _formData: FormData,
): Promise<void> {
  // A cross-origin redirect with NO external opt-in. On the no-JS PE path the
  // browser would natively follow the Location header, so the server-side
  // open-redirect guard must neutralize it: the no-JS user lands on the app
  // root, never on the off-host target.
  return redirect("https://evil.example/phish") as any;
}

export async function peExternalRedirectAllowed(
  _formData: FormData,
): Promise<void> {
  // A cross-origin redirect WITH the explicit opt-in. The guard must let it
  // through on the no-JS PE path too (the marker has to survive PE's
  // extractRedirectResponse rebuild to reach the guard).
  return redirect("https://accounts.example.com/oauth", {
    external: true,
  }) as any;
}

export async function mwChainFormAction(_formData: FormData): Promise<void> {
  const ctx = getRequestContext();
  cookies().set("chain-action", "av", { path: "/", maxAge: 86400 });
  ctx.set("chainAction", "from-action");
  ctx.header("X-Chain-Action", "applied");
}

/**
 * ALS scope test action. Reads the scope chain from request context to prove
 * that route middleware does NOT wrap action execution (scope should only
 * contain "global", not "route"). Also reads custom AsyncLocalStorage instances
 * to prove user-owned ALS propagation follows the same scope rules.
 */
export async function alsScopeAction(): Promise<void> {
  const ctx = getRequestContext();
  const {
    AlsGlobalMark,
    AlsRouteMark,
    AlsInterceptMark,
    customGlobalAls,
    customRouteAls,
  } = await import("./urls/als-scope.js");
  // Build scope snapshot from action's perspective
  const parts: string[] = [];
  if (ctx.get(AlsGlobalMark)) parts.push("global");
  if (ctx.get(AlsRouteMark)) parts.push("route");
  if (ctx.get(AlsInterceptMark)) parts.push("intercept");
  ctx.set("alsActionProbe", parts.length > 0 ? parts.join(",") : "none");
  // Build custom ALS snapshot — action should see top-mw but NOT dsl-mw
  const customParts: string[] = [];
  if (customGlobalAls.getStore()) customParts.push("top-mw");
  if (customRouteAls.getStore()) customParts.push("dsl-mw");
  ctx.set(
    "alsActionCustomProbe",
    customParts.length > 0 ? customParts.join(",") : "none",
  );
}

/**
 * Action that sets context variables via both string key (AppVariables)
 * and typed createVar token. Tests that both approaches survive the
 * action → revalidation boundary.
 */
export async function actionSetCtxVar(): Promise<void> {
  const ctx = getRequestContext();
  const { ActionCtxTypedVar } = await import("./urls/action-ctx-set.js");
  ctx.set("actionCtxValue", "set-by-action");
  ctx.set(ActionCtxTypedVar, "typed-by-action");
}

/**
 * Form-based variant for progressive enhancement testing.
 * Works with native HTML form POST (no-JS).
 */
export async function actionSetCtxVarForm(_formData: FormData): Promise<void> {
  const ctx = getRequestContext();
  const { ActionCtxTypedVar } = await import("./urls/action-ctx-set.js");
  ctx.set("actionCtxValue", "set-by-action");
  ctx.set(ActionCtxTypedVar, "typed-by-action");
}

/**
 * No-op action used to verify useParams survives the action → revalidation
 * boundary. It intentionally touches no state; the client asserts that the
 * params store is still populated after the server round-trip.
 */
export async function paramsAfterActionNoop(): Promise<void> {
  await delay(50);
}

/**
 * Form-compatible variant for progressive enhancement testing.
 */
export async function paramsAfterActionNoopForm(
  _formData: FormData,
): Promise<void> {
  await delay(50);
}

/**
 * Action that throws, used to exercise the action → error-boundary render
 * path. Verifies that useParams remains populated when the server sends
 * the partial error response (isError: true) for both JS and PE paths.
 */
export async function paramsAfterActionThrow(): Promise<void> {
  await delay(50);
  throw new Error("params-after-action boom");
}

export async function paramsAfterActionThrowForm(
  _formData: FormData,
): Promise<void> {
  await delay(50);
  throw new Error("params-after-action boom");
}

/**
 * Auth boundary test action. Mutates state (sets a cookie) to prove the action
 * executed. Route middleware does NOT guard this — only global middleware does.
 */
export async function authBoundaryAction(): Promise<void> {
  cookies().set("auth-boundary-action-ran", "true", { path: "/", maxAge: 60 });
}

/**
 * Form-based variant for progressive enhancement testing.
 */
export async function authBoundaryFormAction(
  _formData: FormData,
): Promise<void> {
  cookies().set("auth-boundary-action-ran", "true", { path: "/", maxAge: 60 });
}

/**
 * isAction() e2e: two distinct module-level "use server" actions. The probe
 * loader's revalidate predicate matches the target by reference via
 * ctx.isAction(), so the target re-runs the loader and the decoy does not —
 * proving rename-safe action matching end to end in dev and production.
 */
export async function isActionTargetAction(): Promise<void> {}
export async function isActionDecoyAction(): Promise<void> {}

/**
 * Action error-boundary + route-middleware fixture (C3). One action succeeds
 * (mutates a cookie so revalidation has a visible signal) and one throws so the
 * route error boundary renders. The route's middleware sets X-Action-Route-Mw on
 * the response; the test asserts that header appears on BOTH the success and the
 * error-boundary action responses — proving route middleware wraps the
 * error-boundary render the same way it wraps a successful revalidation.
 */
export async function actionRouteMwSuccess(): Promise<void> {
  await delay(50);
  cookies().set("action-route-mw-ran", "yes", { path: "/", maxAge: 60 });
}

export async function actionRouteMwThrow(): Promise<void> {
  await delay(50);
  throw new Error("action-route-mw boom");
}

/**
 * shouldRevalidate({ formData }) e2e probe action (C2). A no-op form action: the
 * RevalFormDataLoader's revalidate predicate reads the submitted `reload` field
 * from formData to decide whether to re-run. Accepts FormData so it works on the
 * no-JS PE transport (native form POST) and the JS transport (form enhancement)
 * alike.
 */
export async function revalFormDataAction(_formData: FormData): Promise<void> {
  await delay(50);
}

/**
 * Server action that invalidates a cache tag (read-your-own-writes).
 * Awaits updateTag so cached entries are gone before the action returns,
 * making the subsequent render fresh. Used by InvalidateTagButton.
 */
export async function invalidateTagAction(
  _prev: { tag: string } | null,
  formData: FormData,
): Promise<{ tag: string }> {
  "use server";
  const tag = String(formData.get("tag") ?? "");
  await updateTag(tag);
  return { tag };
}
