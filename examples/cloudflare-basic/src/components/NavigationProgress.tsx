"use client";

import { useNavigation } from "@ivogt/rsc-router/client";
import { useSpinDelay } from "spin-delay";

export function NavigationProgress() {
  const isNavigating = useNavigation((nav) => nav.state === "loading");
  const showProgress = useSpinDelay(isNavigating, {
    delay: 400,
    minDuration: 500,
  });

  if (!showProgress) {
    return null;
  }
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
