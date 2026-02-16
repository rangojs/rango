import { Outlet } from "@rangojs/router/client";
import { DocsSidebar } from "./sidebar.js";

export function DocsLayout() {
  return (
    <div className="flex min-h-screen bg-[#1a1f2e] text-white">
      <DocsSidebar />
      <main className="flex-1 overflow-y-auto px-8 py-12 md:px-16 lg:px-20">
        <div className="mx-auto max-w-3xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
