import { cookies } from "@rangojs/router";
import type { InlineActionState } from "./components/InlineLikeButton.js";

// Plain (NON-cached) async helper: lives at module scope so an inline action
// references it as a normal binding (not a render-scope capture, so not a bound
// arg) and it runs LIVE on every invocation, returning a fresh value each call.
export async function fetchRandomAsyncValue(): Promise<string> {
  await new Promise((r) => setTimeout(r, 5));
  return `like-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e6,
  ).toString(36)}`;
}

// Shared body for the inline "use server" like actions on articles (prerender)
// and blog posts (runtime cache). Module-level (not a "use server" itself), so
// each action calls it at INVOCATION: fetchRandomAsyncValue() is fresh and
// cookies() reads the live request. Only capturedId -- the per-item slug passed
// in -- is frozen with the cache/prerender entry.
export async function buildInlineActionState(
  capturedId: string,
): Promise<InlineActionState> {
  const asyncValue = await fetchRandomAsyncValue();
  const user = cookies().get("cb-like-user")?.value ?? "anon";
  return { capturedId, asyncValue, user };
}
