import { cookies } from "@rangojs/router";
import type { CachedInlineActionState } from "./components/CachedInlineActionForm.js";

// Plain (NON-cached) async helper shared by the inline-"use server"-action
// fixtures (cached, static, and prerendered). It lives at module scope, so an
// inline action references it as a normal binding (not a render-scope capture,
// so not a bound arg): it runs LIVE on every invocation and returns a fresh
// value each call -- the counterpart to a frozen captured value.
export async function fetchRandomAsyncValue(): Promise<string> {
  await new Promise((r) => setTimeout(r, 5));
  return `async-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e6,
  ).toString(36)}`;
}

// Shared body for the inline "use server" actions across the fixtures. It is a
// module-level binding (not a "use server" itself), so each action calls it at
// invocation: cookies() reads the live request and fetchRandomAsyncValue() is
// fresh. Only `capturedToken` -- the per-closure render-scope value passed in --
// is frozen with the cached/prerendered entry.
export async function buildInlineActionState(
  capturedToken: string,
): Promise<CachedInlineActionState> {
  const asyncValue = await fetchRandomAsyncValue();
  const sessionCookie = cookies().get("cai-session")?.value ?? "none";
  return { capturedToken, asyncValue, sessionCookie };
}
