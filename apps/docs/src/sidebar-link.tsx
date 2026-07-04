"use client";

import { Link, usePathname } from "@rangojs/router/client";

/**
 * Sidebar link with client-side active state. The sidebar tree is rendered
 * once at build time (Static) and shared by every docs page, so the
 * current-page highlight cannot be baked server-side — it derives from the
 * live pathname instead and follows soft navigations.
 */
export function SidebarLink({ title, to }: { title: string; to: string }) {
  const pathname = usePathname();
  const active = pathname === to;

  return (
    <Link
      className={
        active
          ? "block py-1 font-medium text-gray-1000"
          : "block py-1 text-gray-900 transition-colors hover:text-gray-1000"
      }
      to={to}
    >
      {title}
    </Link>
  );
}
