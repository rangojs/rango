import { RangoLogo } from "../components/rango-logo.js";
import { ShootingStars } from "../components/shooting-stars.js";

export function HomePage() {
  return (
    <main className="relative flex min-h-screen flex-col bg-[#1a1f2e] text-white overflow-hidden">
      <ShootingStars />
      {/* Nav */}
      <nav className="flex shrink-0 items-center justify-between px-8 py-6 md:px-12 lg:px-16">
        <ul className="flex items-center gap-6 md:gap-10 text-sm md:text-base">
          <li>
            <a href="#start" className="underline underline-offset-4 hover:opacity-80">
              Start
            </a>
          </li>
          <li>
            <a href="#why" className="underline underline-offset-4 hover:opacity-80">
              Why
            </a>
          </li>
          <li>
            <a
              href="https://github.com/nicoyou/rango"
              className="underline underline-offset-4 hover:opacity-80"
            >
              Github
            </a>
          </li>
          <li>
            <a href="#docs" className="underline underline-offset-4 hover:opacity-80">
              Docs
            </a>
          </li>
        </ul>
        <a
          href="#get-started"
          className="rounded-full bg-[#6ee7b7] px-5 py-2 text-sm font-medium text-[#1a1f2e] hover:bg-[#5dd4a8] transition-colors"
        >
          Get started
        </a>
      </nav>

      {/* Hero content */}
      <div className="flex shrink-0 flex-col items-center px-4 py-8 md:py-12">
        <h1>
          <RangoLogo className="h-8 md:h-10 lg:h-12 w-auto" />
        </h1>
        <p className="text-sm md:text-base text-gray-300 mb-6">route wrangler</p>
        <a
          href="#read-more"
          className="inline-flex items-center gap-2 text-base underline underline-offset-4 hover:opacity-80"
        >
          Read more
          <span aria-hidden="true">&rarr;</span>
        </a>
      </div>

      {/* Spacer pushes image to the bottom */}
      <div className="flex-1" />

      {/* Desert background */}
      <picture className="shrink-0">
        <source media="(min-width: 1440px)" srcSet="/images/desert-2870w.png" />
        <source media="(min-width: 1024px)" srcSet="/images/desert-1470w.png" />
        <source media="(min-width: 640px)" srcSet="/images/desert-870w.png" />
        <img
          src="/images/desert-570w.png"
          alt=""
          className="w-full"
        />
      </picture>
    </main>
  );
}
