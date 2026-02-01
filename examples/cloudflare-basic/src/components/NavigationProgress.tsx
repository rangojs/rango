"use client";

import { useClientCache, useNavigation } from "@ivogt/rsc-router/client";
import { useEffect } from "react";

/**
 * Shows a loading indicator only when navigation takes longer than 400ms.
 * Uses pure CSS for delay (avoids React state timing issues with transitions).
 * - 400ms delay before showing (CSS animation-delay)
 * - 200ms fade out when hiding (CSS transition)
 */
export function NavigationProgress() {
  const { clear } = useClientCache();

  const isNavigating = useNavigation(
    (nav) => nav.state === "loading" || nav.isStreaming,
  );

  useEffect(() => {
    if (!isNavigating) clear();
  }, [isNavigating, clear]);

  return (
    <div
      data-navigating={isNavigating}
      className="navigation-progress"
    >
      <div className="navigation-progress-bar" />
      <style
        dangerouslySetInnerHTML={{
          __html: `
            .navigation-progress {
              position: fixed;
              top: 0;
              left: 0;
              right: 0;
              height: 3px;
              background-color: #e0e7ff;
              z-index: 9999;
              overflow: hidden;
              opacity: 0;
              visibility: hidden;
            }

            /* When navigating: delay 400ms, then show */
            .navigation-progress[data-navigating="true"] {
              animation: showProgress 0ms forwards;
              animation-delay: 400ms;
            }

            /* When not navigating: fade out over 200ms */
            .navigation-progress[data-navigating="false"] {
              opacity: 0;
              visibility: hidden;
              transition: opacity 200ms ease-out, visibility 0ms 200ms;
            }

            @keyframes showProgress {
              to {
                opacity: 1;
                visibility: visible;
              }
            }

            .navigation-progress-bar {
              height: 100%;
              width: 33%;
              background-color: #4f46e5;
              animation: progress 1s ease-in-out infinite;
            }

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
