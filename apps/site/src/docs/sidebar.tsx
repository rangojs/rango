"use client";

import { Link, useNavigation } from "@rangojs/router/client";

const sections = [
  {
    heading: "Getting Started",
    links: [
      { href: "/docs", label: "Introduction" },
      { href: "/docs/articles", label: "Articles" },
    ],
  },
  {
    heading: "Guides",
    links: [
      { href: "/docs/articles", label: "Writing Articles" },
    ],
  },
];

export function DocsSidebar() {
  const { location } = useNavigation();
  const currentPath = location.pathname;

  return (
    <aside className="hidden w-60 shrink-0 border-r border-white/10 bg-[#151a27] md:block">
      <div className="sticky top-0 flex flex-col gap-8 overflow-y-auto p-6">
        <Link to="/" className="text-lg font-semibold text-[#6ee7b7]">
          Rango
        </Link>

        <nav className="flex flex-col gap-6">
          {sections.map((section) => (
            <div key={section.heading}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
                {section.heading}
              </h3>
              <ul className="flex flex-col gap-0.5">
                {section.links.map((link) => {
                  const isActive = currentPath === link.href;
                  return (
                    <li key={link.href + link.label}>
                      <Link
                        to={link.href}
                        className={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
                          isActive
                            ? "bg-[#6ee7b7]/10 text-[#6ee7b7]"
                            : "text-gray-400 hover:bg-white/5 hover:text-gray-200"
                        }`}
                      >
                        {link.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </div>
    </aside>
  );
}
