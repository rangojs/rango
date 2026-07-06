import { Link } from "@rangojs/router/client";

export function Footer() {
  return (
    <footer className="border-t border-gray-alpha-400">
      <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-8 text-sm text-gray-900">
        <span>Vercel Shop Documentation</span>
        <div className="flex items-center gap-5">
          <Link className="transition-colors hover:text-gray-1000" to="/docs">
            Docs
          </Link>
          <a
            className="transition-colors hover:text-gray-1000"
            href="https://github.com/vercel/shop"
            rel="noopener noreferrer"
            target="_blank"
          >
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
