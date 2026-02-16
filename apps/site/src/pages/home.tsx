import {
  Code2,
  Globe,
  Layers,
  Loader,
  Route,
  Server,
  Shield,
  Timer,
} from "lucide-react";

import { FadeIn } from "../components/fade-in.js";
import { RangoLogo } from "../components/rango-logo.js";
import { ShootingStars } from "../components/shooting-stars.js";

const features = [
  {
    icon: Route,
    title: "Django-Style Routes",
    description:
      "Composable URL patterns with the urls() DSL. Layouts, loaders, and caching compose like middleware.",
  },
  {
    icon: Server,
    title: "RSC-First",
    description:
      "Server Components by default. Stream HTML to the browser with zero client JS for static content.",
  },
  {
    icon: Shield,
    title: "Type-Safe",
    description:
      "Auto-generated route types. Compile-time checking for route names, params, and URL generation.",
  },
  {
    icon: Layers,
    title: "Nested Layouts",
    description:
      "Layout hierarchy with <Outlet />. Only changed segments re-render on navigation.",
  },
  {
    icon: Globe,
    title: "Edge-Native",
    description:
      "Built for Cloudflare Workers. Sub-millisecond cold starts at the edge.",
  },
  {
    icon: Timer,
    title: "Segment Caching",
    description:
      "Per-segment TTL + stale-while-revalidate. Cache layouts independently from dynamic content.",
  },
  {
    icon: Loader,
    title: "Data Loaders",
    description:
      "Streaming data fetching with Suspense. Loaders run in parallel and stream as they resolve.",
  },
  {
    icon: Code2,
    title: "Pre-rendering",
    description:
      "Build-time caching. Pre-render known routes at build, serve unknown routes live.",
  },
];

// Group features into rows of 2 for alternating layout
const featureRows = [
  [features[0], features[1]],
  [features[2], features[3]],
  [features[4], features[5]],
  [features[6], features[7]],
];

export function HomePage() {
  return (
    <main className="relative flex flex-col bg-[#1a1f2e] text-white overflow-hidden">
      {/* Hero section */}
      <div className="relative flex min-h-screen flex-col">
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
              <a href="/docs" className="underline underline-offset-4 hover:opacity-80">
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
      </div>

      {/* Routing Showcase — editorial flow */}
      <section
        id="start"
        className="relative px-8 py-16 md:px-12 lg:px-16"
      >
        {/* Gradient transition from desert edge */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-[#2a1f1a] to-transparent" />

        <div className="relative mx-auto max-w-2xl">
          <FadeIn>
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
              Routes that{" "}
              <span className="text-[#6ee7b7]">compose</span>
            </h2>
            <p className="mt-4 text-gray-300 leading-relaxed">
              Rango borrows the best idea from Django: declarative URL patterns
              you can read top-to-bottom. Layouts, loaders, and cache rules nest
              naturally — no magic file conventions, just functions.
            </p>
            <p className="mt-3 text-gray-400 leading-relaxed">
              Every route is explicit. Compose patterns across modules with{" "}
              <code className="text-[#6ee7b7]">include()</code>, wrap segments
              in shared data or cache policies, and let the type system keep it
              all honest.
            </p>
          </FadeIn>

          <FadeIn delay={150}>
            <div className="mt-10 overflow-hidden rounded-xl border border-[#2a3040] bg-[#131825]">
              <div className="flex items-center gap-2 border-b border-[#2a3040] px-4 py-3">
                <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
                <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
                <span className="h-3 w-3 rounded-full bg-[#28c840]" />
                <span className="ml-3 text-xs text-gray-500">urls.tsx</span>
              </div>
              <pre className="overflow-x-auto p-5 text-sm leading-relaxed">
                <code>
                  <span className="text-[#7c8599]">{"export"}</span>
                  {" "}
                  <span className="text-[#7c8599]">{"const"}</span>
                  {" urlpatterns = "}
                  <span className="text-[#6ee7b7]">{"urls"}</span>
                  {"(\n"}
                  {"  ({ "}
                  <span className="text-[#6ee7b7]">path</span>
                  {", "}
                  <span className="text-[#6ee7b7]">layout</span>
                  {", "}
                  <span className="text-[#6ee7b7]">loader</span>
                  {", "}
                  <span className="text-[#6ee7b7]">cache</span>
                  {", "}
                  <span className="text-[#6ee7b7]">include</span>
                  {" }) => [\n"}
                  {"    "}
                  <span className="text-[#6ee7b7]">layout</span>
                  {"(RootLayout, [\n"}
                  {"      "}
                  <span className="text-[#6ee7b7]">path</span>
                  {"("}
                  <span className="text-[#f59e0b]">{'"/"'}</span>
                  {", HomePage, { name: "}
                  <span className="text-[#f59e0b]">{'"home"'}</span>
                  {" }),\n\n"}
                  {"      "}
                  <span className="text-[#6ee7b7]">loader</span>
                  {"(BlogLoader, [\n"}
                  {"        "}
                  <span className="text-[#6ee7b7]">path</span>
                  {"("}
                  <span className="text-[#f59e0b]">{'"/blog"'}</span>
                  {", BlogList, { name: "}
                  <span className="text-[#f59e0b]">{'"blog"'}</span>
                  {" }),\n"}
                  {"        "}
                  <span className="text-[#6ee7b7]">path</span>
                  {"("}
                  <span className="text-[#f59e0b]">{'"/blog/:slug"'}</span>
                  {", Article, { name: "}
                  <span className="text-[#f59e0b]">{'"article"'}</span>
                  {" }),\n"}
                  {"      ]),\n\n"}
                  {"      "}
                  <span className="text-[#6ee7b7]">cache</span>
                  {"({ ttl: "}
                  <span className="text-[#c4b5fd]">60</span>
                  {", swr: "}
                  <span className="text-[#c4b5fd]">300</span>
                  {" }, [\n"}
                  {"        "}
                  <span className="text-[#6ee7b7]">path</span>
                  {"("}
                  <span className="text-[#f59e0b]">{'"/dashboard"'}</span>
                  {", Dashboard, { name: "}
                  <span className="text-[#f59e0b]">{'"dashboard"'}</span>
                  {" }),\n"}
                  {"      ]),\n\n"}
                  {"      "}
                  <span className="text-[#6ee7b7]">include</span>
                  {"("}
                  <span className="text-[#f59e0b]">{'"/docs"'}</span>
                  {", docsPatterns),\n"}
                  {"    ]),\n"}
                  {"  ]\n"}
                  {");"}
                </code>
              </pre>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* Features — alternating rows */}
      <section
        id="why"
        className="px-8 py-16 md:px-12 lg:px-16"
      >
        <div className="mx-auto max-w-2xl">
          <FadeIn>
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
              Why <span className="text-[#6ee7b7]">Rango</span>?
            </h2>
            <p className="mt-4 text-gray-400 leading-relaxed">
              A React framework built for the edge — with routing that makes sense.
            </p>
          </FadeIn>

          <div className="mt-12 space-y-8">
            {featureRows.map((row, i) => (
              <FadeIn key={i} delay={i * 100}>
                <div className="flex flex-col gap-8 md:flex-row">
                  {row.map((feature) => (
                    <div
                      key={feature.title}
                      className="flex-1 border-l-2 border-[#6ee7b7]/40 pl-5"
                    >
                      <div className="flex items-center gap-3">
                        <feature.icon className="h-5 w-5 text-[#6ee7b7]" />
                        <h3 className="font-semibold">{feature.title}</h3>
                      </div>
                      <p className="mt-2 text-sm leading-relaxed text-gray-300">
                        {feature.description}
                      </p>
                    </div>
                  ))}
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
