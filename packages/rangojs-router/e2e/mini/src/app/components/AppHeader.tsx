"use client";

// Shared component of the app/-rooted fixture, rendered by /app-root/hero and
// /app-root/gallery. app/components/ is not followed by a route-root marker, so
// the built-in clientChunks strategy keys it on "components" (app-components),
// apart from both route groups.

export function AppHeader() {
  return (
    <header data-testid="app-root-header" className="mini-app-header">
      app-header
    </header>
  );
}
