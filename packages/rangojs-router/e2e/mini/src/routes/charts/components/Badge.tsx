"use client";

// Same filename as routes/widgets/components/Badge.tsx but a different route.
// Must land in app-charts (keyed on the route id), not collide with the widgets
// badge in a shared app-components chunk.

export function Badge() {
  return <span data-testid="badge-charts">badge-charts</span>;
}
