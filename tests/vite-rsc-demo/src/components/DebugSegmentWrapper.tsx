import type { ReactNode } from "react";

/**
 * Debug wrapper to visualize segment boundaries in development mode
 * Shows colored borders and labels for layouts, routes, and parallel routes
 */

export type SegmentType = "layout" | "route" | "parallel" | "outlet";

interface DebugSegmentWrapperProps {
  type: SegmentType;
  name: string;
  children: ReactNode;
}

const SEGMENT_STYLES = {
  layout: {
    borderColor: "#3b82f6", // blue
    backgroundColor: "#eff6ff",
    borderStyle: "dashed" as const,
  },
  route: {
    borderColor: "#10b981", // green
    backgroundColor: "#f0fdf4",
    borderStyle: "solid" as const,
  },
  parallel: {
    borderColor: "#f59e0b", // orange
    backgroundColor: "#fffbeb",
    borderStyle: "dotted" as const,
  },
  outlet: {
    borderColor: "#8b5cf6", // purple
    backgroundColor: "#faf5ff",
    borderStyle: "double" as const,
  },
};

export function DebugSegmentWrapper({
  type,
  name,
  children,
}: DebugSegmentWrapperProps) {
  // Only show in development mode
  if (!import.meta.env.DEV) {
    return <>{children}</>;
  }

  const style = SEGMENT_STYLES[type];

  return (
    <div
      data-segment-type={type}
      data-segment-name={name}
      style={{
        position: "relative",
        border: `2px ${style.borderStyle} ${style.borderColor}`,
        margin: "4px",
        padding: "8px",
        borderRadius: "4px",
      }}
    >
      {/* Label badge */}
      <div
        style={{
          position: "absolute",
          top: "-12px",
          left: "8px",
          background: style.borderColor,
          color: "white",
          fontSize: "10px",
          fontWeight: "bold",
          padding: "2px 8px",
          borderRadius: "3px",
          fontFamily: "monospace",
          textTransform: "uppercase",
          zIndex: 1000,
        }}
      >
        {type}: {name}
      </div>
      {children}
    </div>
  );
}
