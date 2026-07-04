"use client";

import { Link } from "@rangojs/router/client";
import { useTheme } from "@rangojs/router/theme";
import { ArrowUpRight, MoonIcon, SearchIcon, SunIcon } from "lucide-react";

import { Logo } from "@/components/logo";

const NAV = [
  // Docs is the primary destination from anywhere on the site — prefetch it
  // as soon as the navbar mounts so the first navigation is instant.
  {
    external: false,
    href: "/docs",
    label: "Docs",
    prefetch: "render" as const,
  },
  { external: true, href: "https://template.vercel.shop", label: "Demo" },
  { external: true, href: "https://github.com/vercel/shop", label: "GitHub" },
];

export function Navbar() {
  const { setTheme, theme } = useTheme();
  const linkClass =
    "inline-flex items-center gap-0.5 text-sm text-gray-900 transition-colors hover:text-gray-1000";

  return (
    <header className="sticky top-0 z-50 border-b border-gray-alpha-400 bg-background-100/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-[90rem] items-center gap-6 px-6">
        <Link className="shrink-0" to="/">
          <Logo />
        </Link>
        <nav className="flex items-center gap-5">
          {NAV.map((item) =>
            item.external ? (
              <a
                className={linkClass}
                href={item.href}
                key={item.href}
                rel="noopener noreferrer"
                target="_blank"
              >
                {item.label}
                <ArrowUpRight className="size-3 text-gray-700" />
              </a>
            ) : (
              <Link
                className={linkClass}
                key={item.href}
                prefetch={item.prefetch}
                to={item.href}
              >
                {item.label}
              </Link>
            ),
          )}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {/* Search + Ask AI are visual placeholders — the Orama search and AI
              chat features are deferred; the shells keep navbar parity. */}
          <button
            className="hidden items-center gap-2 rounded-md border border-gray-alpha-400 bg-background-200 py-1.5 pr-2 pl-3 text-sm text-gray-700 transition-colors hover:border-gray-alpha-500 sm:flex"
            title="Search — coming soon"
            type="button"
          >
            <SearchIcon className="size-3.5" />
            <span className="pr-8">Search…</span>
            <kbd className="rounded border border-gray-alpha-400 bg-background-100 px-1.5 py-0.5 text-[11px] text-gray-700">
              ⌘K
            </kbd>
          </button>
          <button
            className="hidden rounded-md border border-gray-alpha-400 px-3 py-1.5 text-sm font-medium text-gray-1000 transition-colors hover:bg-gray-100 sm:block"
            title="Ask AI — coming soon"
            type="button"
          >
            Ask AI
          </button>
          <button
            aria-label="Toggle theme"
            className="rounded-md p-1.5 text-gray-900 transition-colors hover:bg-gray-100 hover:text-gray-1000"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            type="button"
          >
            <SunIcon className="hidden size-4 dark:block" />
            <MoonIcon className="size-4 dark:hidden" />
          </button>
        </div>
      </div>
    </header>
  );
}
