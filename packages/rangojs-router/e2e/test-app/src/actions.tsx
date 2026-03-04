"use server";

import { ReactNode } from "react";
import { cookies, getRequestContext, redirect } from "@rangojs/router";
import { FlashMessage } from "./location-states.js";

// Simulated delay helper
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Cart state keyed by cart ID (cookie-based isolation for parallel tests)
const carts: Map<string, Map<string, number>> = new Map();

function getCartId(): string {
  const jar = cookies();
  let cartId = jar.get("cart-id")?.value;
  if (!cartId) {
    cartId = Math.random().toString(36).slice(2);
    jar.set("cart-id", cartId, { path: "/" });
  }
  return cartId;
}

function getCart(cartId: string): Map<string, number> {
  let cart = carts.get(cartId);
  if (!cart) {
    cart = new Map();
    carts.set(cartId, cart);
  }
  return cart;
}

/**
 * Add item to cart - fire and forget pattern
 */
export async function addToCart(productId: string): Promise<void> {
  await delay(100);
  const cart = getCart(getCartId());
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
  const cart = getCart(getCartId());
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
  const cart = getCart(getCartId());
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
  const cart = getCart(getCartId());
  return cart.get(productId) || 0;
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
  const cartId = getCartId();
  carts.delete(cartId);
}

// Dummy action for prerender client component tests
export async function prerenderTestAction(): Promise<{ ok: true }> {
  return { ok: true };
}

/**
 * Simple action that triggers revalidation
 * Used to test that loaders registered with loader() are revalidated
 */
export async function triggerRevalidation(): Promise<{
  triggered: boolean;
  timestamp: string;
}> {
  await delay(100);
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

export async function resetLastSubmittedName(): Promise<void> {
  lastSubmittedName = null;
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
 * Action that redirects with a flash message.
 * Tests that server actions can use redirect() with location state.
 */
export async function saveAndRedirect(): Promise<void> {
  return redirect("/location-state", {
    state: [FlashMessage({ text: "Action saved successfully!" })],
  }) as any;
}

/**
 * Action that redirects without state (pure redirect from action).
 */
export async function actionSimpleRedirect(): Promise<void> {
  return redirect("/location-state/target") as any;
}

/**
 * Action that throws a redirect with flash state.
 * Tests that thrown redirect() from actions is handled correctly.
 */
export async function throwRedirectWithState(): Promise<void> {
  throw redirect("/location-state", {
    state: [FlashMessage({ text: "Thrown redirect flash!" })],
  });
}

/**
 * Action that throws a redirect without state.
 */
export async function throwSimpleRedirect(): Promise<void> {
  throw redirect("/location-state/target");
}

/**
 * Action that throws a regular error.
 * Used to verify onError receives phase="action".
 */
export async function throwActionError(): Promise<void> {
  throw new Error("Action error for onError test");
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
