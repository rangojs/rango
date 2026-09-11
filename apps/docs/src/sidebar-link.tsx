"use client";

import { useEffect, useRef } from "react";
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
  const ref = useRef<HTMLAnchorElement>(null);

  // Keep the current page visible inside the scrollable rail after a
  // navigation lands on an entry that was scrolled out of the sidebar.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <Link
      aria-current={active ? "page" : undefined}
      className="flex min-h-8 w-full items-center rounded-lg px-2 py-1.5 leading-snug text-muted-foreground transition-colors hover:text-foreground data-[active=true]:bg-accent data-[active=true]:font-medium data-[active=true]:text-accent-foreground"
      data-active={active}
      ref={ref}
      to={to}
    >
      {title}
    </Link>
  );
}
