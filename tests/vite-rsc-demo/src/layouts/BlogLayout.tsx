import { Outlet, ParallelOutlet } from "@rangojs/router/client";

export function BlogLayout() {
  return (
    <div>
      <h1>Blog</h1>
      <p className="segment-id">Segment: BlogLayout</p>
      <div style={{ display: "flex", gap: "2rem" }}>
        <main style={{ flex: 1 }}>
          <Outlet />
        </main>
        <ParallelOutlet name="@sidebar" />
      </div>
      <Outlet name="@modal" />
    </div>
  );
}
