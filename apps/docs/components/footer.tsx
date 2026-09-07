import { Link } from "@rangojs/router/client";

const EXTERNAL = [
  { href: "https://github.com/rangojs/rango", label: "GitHub" },
  { href: "https://www.npmjs.com/package/@rangojs/router", label: "npm" },
];

export function Footer() {
  return (
    <footer className="border-t border-gray-alpha-400">
      <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-gray-900">
        <span>Rango — a Django-inspired RSC router for Vite</span>
        <div className="flex items-center gap-5">
          <Link className="transition-colors hover:text-gray-1000" to="/docs">
            Docs
          </Link>
          {EXTERNAL.map((item) => (
            <a
              className="transition-colors hover:text-gray-1000"
              href={item.href}
              key={item.href}
              rel="noopener noreferrer"
              target="_blank"
            >
              {item.label}
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
}
