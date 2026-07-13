"use server";

import { updateTag } from "@rangojs/router";
import {
  bumpHoleCounter,
  bumpBanner,
  markPeSubmit,
  SHELL_ACTION_BANNER_TAG,
} from "../urls/shell-cache-action.defs.js";

// PPR action e2e (Deliverable 10). The mutable state lives in the directive-free
// defs module; these "use server" actions mutate it.

// 10(a): mutate HOLE data (loader-fed). No invalidation needed — loaders are the
// live lane under PPR, so the next GET's hole reflects the new value while the
// route stays HIT (only the frozen HTML shell came from cache).
export async function incrementHoleAction(): Promise<{ count: number }> {
  return { count: bumpHoleCounter() };
}

// 10(c) PE: a plain single-arg FormData action for a native (no-JS) form POST. On
// submit the shell-cache middleware bypasses (non-GET) and axis 1 re-renders. It
// marks a SHELL-visible value (markPeSubmit) so the re-render is observable without
// JS, and also bumps the hole counter (the live lane).
export async function incrementHolePeAction(
  _formData: FormData,
): Promise<void> {
  markPeSubmit();
  bumpHoleCounter();
}

// 10(b): mutate SHELL material + invalidate its tag. updateTag() (awaited, so the
// caller reads-its-own-write) drops the cached banner AND the shell that carries
// SHELL_ACTION_BANNER_TAG → the next GET MISSes and recaptures with the new banner
// frozen into the prelude.
export async function updateBannerAction(
  _prev: { banner: string } | null,
  _formData: FormData,
): Promise<{ banner: string }> {
  const banner = bumpBanner();
  await updateTag(SHELL_ACTION_BANNER_TAG);
  return { banner };
}

export interface PrerenderPprActionResult {
  streamed: Promise<string>;
}

export async function submitPrerenderPprAction(
  _previous: PrerenderPprActionResult | null,
  formData: FormData,
): Promise<PrerenderPprActionResult> {
  const value = String(formData.get("value"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  return {
    streamed: new Promise((resolve) =>
      setTimeout(() => resolve(`prerender-ppr-action:${value}`), 1_200),
    ),
  };
}
