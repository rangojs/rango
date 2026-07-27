"use client";
import type { ReactNode } from "react";
import { useEffect } from "react";
import type { NavigateOptionsInternal } from "./browser/types.js";
import { useRouter } from "./browser/react/use-router.js";
import { validateExternalRedirect } from "./browser/validate-redirect-origin.js";
import { resolveSameOriginRedirect } from "./redirect-origin.js";

/**
 * Executes a loader-thrown redirect() once mounted. The target was resolved
 * through the soft-redirect same-origin rules server-side
 * (wrapLoaderWithErrorHandling), so anything absolute AND cross-origin here is
 * an explicit `{ external: true }` opt-in — those leave via location.replace
 * (the SPA router cannot cross origins); everything else is a router
 * replace-navigation. Renders nothing while the navigation commits.
 *
 * Own module (not route-content-wrapper.tsx) because BOTH consumers need it
 * without a cycle: the StreamedLoaderErrorBoundary redirect branch (read-site
 * throw path) and decodeLoaderResults (aggregate forceAwait/action path, which
 * runs during the server tree build and cannot throw — it plants this element
 * in the errorFallback slot instead).
 */
export function LoaderRedirect({
  to,
  state,
}: {
  to: string;
  /**
   * Resolved `redirect(url, { state })` record off the loader-result marker.
   * Delivered as the redirect navigation's state (same application path as
   * the ServerRedirect lane in navigation-bridge.ts: buildHistoryState
   * spreads the `__rsc_ls_*` keys into the target entry). `_skipCache`
   * matches that lane — a cached segment commit must not skip the re-render
   * that lets useLocationState read the fresh entry.
   */
  state?: Record<string, unknown>;
}): ReactNode {
  const router = useRouter();
  useEffect(() => {
    const origin = window.location.origin;
    // Same-origin first: a target that resolves on-origin is a router
    // navigation. Only when it does NOT is this the `{ external: true }`
    // opt-in, which waives same-origin but NOT scheme safety — both branches
    // go through the shared resolvers in redirect-origin.ts so this channel
    // cannot drift from the fetch/action/document ones.
    // Pure resolver (not validateRedirectOrigin) for the probe: an off-origin
    // target here is the legitimate external opt-in, not a blocked redirect,
    // so it must not log a "blocked" error on its way to the branch below.
    const sameOrigin = resolveSameOriginRedirect(to, origin);
    if (sameOrigin) {
      const options: Omit<NavigateOptionsInternal, "replace"> | undefined =
        state ? { state, _skipCache: true } : undefined;
      void router.replace(sameOrigin, options);
      return;
    }
    const externalUrl = validateExternalRedirect(to, origin);
    if (externalUrl) {
      window.location.replace(externalUrl);
    }
    // Redirect targets are request-scoped constants; re-running on identity
    // change only (StrictMode double-invoke is idempotent — same target).
  }, [to, state, router]);
  return null;
}
