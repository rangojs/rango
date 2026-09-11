"use client";

import { usePathname } from "@rangojs/router/client";
import { MenuIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

/**
 * Pages drawer for viewports below `lg`, where the sidebar is hidden. The nav
 * tree arrives as server-rendered children; the drawer closes itself on any
 * navigation by watching the live pathname.
 */
export function DocsMobileNav({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Sheet onOpenChange={(next) => setOpen(next)} open={open}>
      <SheetTrigger
        aria-label="Open pages navigation"
        render={<Button size="sm" variant="outline" />}
      >
        <MenuIcon />
        Pages
      </SheetTrigger>
      <SheetPopup className="w-80" side="left">
        <SheetHeader>
          <SheetTitle>Documentation</SheetTitle>
        </SheetHeader>
        <SheetPanel>
          <nav className="text-sm">{children}</nav>
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
}
