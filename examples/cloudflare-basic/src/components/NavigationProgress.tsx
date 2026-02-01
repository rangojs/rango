"use client";

import { useClientCache, useNavigation } from "@ivogt/rsc-router/client";
import { useEffect } from "react";
import { useSpinDelay } from "spin-delay";

/**
 * Shows a loading indicator only when navigation takes longer than 400ms.
 * Uses spin-delay to avoid flashing for quick navigations and ensures
 * minimum display time once shown.
 */
export function NavigationProgress() {
  const { clear } = useClientCache();

  const isNavigating = useNavigation(
    (nav) => nav.state === "loading" || nav.isStreaming,
  );

  useEffect(() => {
    if (!isNavigating) clear();
  }, [isNavigating]);

  const showProgress = useSpinDelay(isNavigating, {
    delay: 400,
    minDuration: 200,
  });

  console.log("showProgress", showProgress);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: "3px",
        backgroundColor: "#e0e7ff",
        zIndex: 9999,
        overflow: "hidden",
        display: isNavigating ? "block" : "none",
      }}
    >
      <div
        style={{
          height: "100%",
          width: "33%",
          backgroundColor: "#4f46e5",
          animation: "progress 1s ease-in-out infinite",
        }}
      />
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @keyframes progress {
              0% { transform: translateX(-100%); }
              100% { transform: translateX(400%); }
            }
          `,
        }}
      />
    </div>
  );
}
