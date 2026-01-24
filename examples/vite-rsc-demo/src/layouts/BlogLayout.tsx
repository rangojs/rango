import { Outlet, ParallelOutlet } from "@ivogt/rsc-router/client";

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
    </div>
  );
}
