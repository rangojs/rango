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
