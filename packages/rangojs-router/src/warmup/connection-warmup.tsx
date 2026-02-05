"use client";

/**
 * Connection warmup component.
 *
 * Keeps TCP+TLS connections alive so navigations after idle periods
 * don't pay DNS+TCP+TLS handshake costs. Sends a HEAD request with
 * ?_rsc_warmup when the connection goes cold and the user returns.
 *
 * Cold detection: 60s of no user interaction marks the connection as cold.
 * Warmup triggers: on visibility change or first user interaction after cold,
 * debounced 150ms, sends HEAD /?_rsc_warmup to re-establish TLS.
 */

import { useEffect } from "react";

const IDLE_TIMEOUT = 60_000;
const DEBOUNCE_MS = 150;

export function ConnectionWarmup(): null {
  useEffect(() => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let isCold = false;
    let warmupListenersAttached = false;

    // Reset idle timer on any activity
    function resetIdleTimer(): void {
      isCold = false;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        isCold = true;
        attachWarmupListeners();
      }, IDLE_TIMEOUT);
    }

    // Send the warmup HEAD request (debounced)
    function triggerWarmup(): void {
      if (!isCold) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        fetch("/?_rsc_warmup", { method: "HEAD" }).catch(() => {});
        isCold = false;
        // Detach warmup listeners until next cold period
        detachWarmupListeners();
        resetIdleTimer();
      }, DEBOUNCE_MS);
    }

    // Visibility change handler (fires even without mouse/touch)
    function onVisibilityChange(): void {
      if (document.visibilityState === "visible" && isCold) {
        triggerWarmup();
      }
    }

    // Warmup listeners are only active while cold
    function attachWarmupListeners(): void {
      if (warmupListenersAttached) return;
      warmupListenersAttached = true;
      document.addEventListener("visibilitychange", onVisibilityChange);
      document.addEventListener("mousemove", triggerWarmup, { once: true });
      document.addEventListener("touchstart", triggerWarmup, { once: true });
    }

    function detachWarmupListeners(): void {
      if (!warmupListenersAttached) return;
      warmupListenersAttached = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("mousemove", triggerWarmup);
      document.removeEventListener("touchstart", triggerWarmup);
    }

    // Track activity for idle detection
    const activityEvents = ["mousemove", "keydown", "touchstart", "scroll"] as const;
    for (const event of activityEvents) {
      document.addEventListener(event, resetIdleTimer, { passive: true });
    }

    // Start idle timer immediately
    resetIdleTimer();

    return () => {
      clearTimeout(idleTimer);
      clearTimeout(debounceTimer);
      detachWarmupListeners();
      for (const event of activityEvents) {
        document.removeEventListener(event, resetIdleTimer);
      }
    };
  }, []);

  return null;
}
