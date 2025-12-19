import { Outlet, ParallelOutlet } from "rsc-router/client";
import { BreadcrumbNav } from "@/components/BreadcrumbNav.js";

export function BlogLayout() {
  return (
    <div>
      <BreadcrumbNav />
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
