"use client";

// Nested under routes/widgets/components/ with the SAME filename as the badge in
// routes/charts/components/. The built-in clientChunks strategy keys on the route
// id (the segment after `routes/`), so this lands in app-widgets, not a shared
// app-components — proving same-named subdirs no longer collide.

export function Badge() {
  return <span data-testid="badge-widgets">badge-widgets</span>;
}
