import type { ReactNode } from "react";

import { CacheHitDemo, TwoTabsDemo } from "@/components/docs-demos";
import Link from "@/components/link";
import { Button } from "@/components/ui/button";
import {
  CommandPromptContent,
  CommandPromptCopy,
  CommandPromptList,
  CommandPromptPrefix,
  CommandPromptRoot,
  CommandPromptSurface,
  CommandPromptTrigger,
  CommandPromptTriggerDivider,
  CommandPromptViewport,
} from "@/components/ui/command-prompt";
import { homeSubtitle, homeTitle } from "@/lib/site";

import { CenteredSection } from "./centered-section";
import { snippetComponents } from "./code-snippet";
import { CTA } from "./cta";
import { Hero } from "./hero";
import { OneTwoSection } from "./one-two-section";
import CacheLoaderSnippet from "./snippets/cache-loader.mdx";
import ResponseRoutesSnippet from "./snippets/response-routes.mdx";
import ReverseSnippet from "./snippets/reverse.mdx";
import RouteTreeSnippet from "./snippets/route-tree.mdx";
import TestingSnippet from "./snippets/testing.mdx";
import { TextGridSection } from "./text-grid-section";

const GITHUB_URL = "https://github.com/rangojs/rango";
const TEMPLATES_URL = "https://github.com/rangojs/templates";

const IDEAS = [
  {
    description:
      "Every route carries a name. ctx.reverse() on the server and useReverse() on the client are compile-time checked against the generated route map, so a rename in the tree updates every link, redirect, and prefetch.",
    id: "names",
    title: "Names, not strings",
  },
  {
    description:
      'cache() and "use cache" answer whether a stored value is still good. revalidate() answers whether a segment re-renders right now. Two questions, two APIs, never conflated.',
    id: "freshness",
    title: "Two axes of freshness",
  },
  {
    description:
      "A loader resolves fresh on every request, even inside a cached render, and streams so data latency overlaps first paint instead of blocking it.",
    id: "loaders",
    title: "Loaders are the live lane",
  },
  {
    description:
      "path.json(), path.text(), path.xml(), path.stream() are ordinary tree entries, dispatched by Accept header, with payload types inferred from the handler.",
    id: "api",
    title: "Your API in the same tree",
  },
  {
    description:
      "Dev and production resolve every request through the same route trie, and JS and no-JS produce the same effects. Both are pinned by a semantic matrix suite.",
    id: "semantics",
    title: "Semantics are a contract",
  },
  {
    description:
      "renderHandler, runLoader, runMiddleware, dispatch, and renderRoute exercise real handlers and middleware chains. No framework mocks.",
    id: "testing",
    title: "Testing is part of the API",
  },
];

const TEMPLATES = [
  {
    command: "pnpm create rango my-app --template basic",
    detail:
      "Vite dev server and a Node production server. Also available as JavaScript with --js.",
    name: "Node",
  },
  {
    command: "pnpm create rango my-app --template cloudflare",
    detail:
      "The cloudflare preset with @cloudflare/vite-plugin. Deploys with wrangler.",
    name: "Cloudflare Workers",
  },
  {
    command: "pnpm create rango my-app --template vercel",
    detail:
      "The vercel preset with the function launcher assembled at build time.",
    name: "Vercel",
  },
];

const TRADEOFFS = [
  {
    description:
      "There is no file convention to scaffold routes for you. The tree is the point, but it is authored, not inferred.",
    title: "You write the tree",
  },
  {
    description:
      "Handles, the two freshness axes, and revalidate() as selection rather than cache expiry take a session to internalize. The skills exist to make that session short.",
    title: "Some vocabulary is new",
  },
  {
    description:
      "The destination branch can render before global middleware finishes, and the clientUrls() DSL leaves route middleware, nested include()/parallel(), error and not-found boundaries, and cache() in the server tree around the mount.",
    title: "Client URL loading is optimistic, not authorization",
  },
];

const SectionCode = ({ children }: { children: ReactNode }) => (
  <div className="not-prose text-left">{children}</div>
);

export function HomeContent() {
  return (
    <div className="container mx-auto max-w-[1448px]">
      <Hero
        badge="Semantics pinned and tested"
        description={homeSubtitle}
        title={homeTitle}
      >
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Button asChild className="h-12 w-fit rounded-full px-5">
            <Link href="/docs/rango/getting-started">Get started</Link>
          </Button>
          <Button
            asChild
            className="h-12 w-fit rounded-full px-5"
            variant="secondary"
          >
            <Link href="/docs">Read the docs</Link>
          </Button>
        </div>
        <div className="flex justify-center pt-4">
          <CommandPromptRoot defaultValue="pnpm">
            <CommandPromptList>
              <CommandPromptTrigger className="min-w-[64px]" value="pnpm">
                pnpm
              </CommandPromptTrigger>
              <CommandPromptTriggerDivider />
              <CommandPromptTrigger className="min-w-[56px]" value="npm">
                npm
              </CommandPromptTrigger>
              <CommandPromptTriggerDivider />
              <CommandPromptTrigger className="min-w-[56px]" value="bun">
                bun
              </CommandPromptTrigger>
            </CommandPromptList>
            <CommandPromptSurface>
              <CommandPromptPrefix>$</CommandPromptPrefix>
              <CommandPromptViewport>
                <CommandPromptContent value="pnpm">
                  pnpm create rango my-app
                </CommandPromptContent>
                <CommandPromptContent value="npm">
                  npm create rango@latest my-app
                </CommandPromptContent>
                <CommandPromptContent value="bun">
                  bun create rango my-app
                </CommandPromptContent>
              </CommandPromptViewport>
              <CommandPromptCopy />
            </CommandPromptSurface>
          </CommandPromptRoot>
        </div>
      </Hero>
      <div className="mx-auto grid max-w-[1080px] px-6 xl:px-0">
        <CenteredSection
          description="Routes are expressed, not configured. One tree shows every URL, who owns it, what data it loads, what wraps it, and what re-renders after an action. No file-system convention, no hunting across page, layout, and route siblings."
          title="The route tree is the app"
        >
          <SectionCode>
            <RouteTreeSnippet components={snippetComponents} />
          </SectionCode>
        </CenteredSection>

        <TextGridSection data={IDEAS} />

        <OneTwoSection
          description={
            <>
              <p>
                A cache hit streams the stored UI instantly while loaders
                resolve fresh alongside it. The partial-prerendering shape is
                the default outcome, not an incantation, and cookies() and
                headers() throw inside cache scopes instead of baking one
                visitor's data into a shared shell.
              </p>
              <div className="mt-6">
                <CacheLoaderSnippet components={snippetComponents} />
              </div>
            </>
          }
          title="Cached shell, live data"
        >
          <CacheHitDemo />
        </OneTwoSection>

        <OneTwoSection
          description="URLs are built from names, never hand-assembled from strings. A misspelled name or a missing param is a type error, not a runtime 404. Change /shop/:slug to /store/:slug in the one place it is defined and every link, redirect, and prefetch follows."
          title="Names, not strings"
        >
          <SectionCode>
            <ReverseSnippet components={snippetComponents} />
          </SectionCode>
        </OneTwoSection>

        <CenteredSection
          description="A fully prefetched navigation commits with no loading flash. Every server action invalidates by default: history entries are marked stale, the prefetch cache flushes, a rotating X-Rango-State value strands HTTP-cached payloads, and sibling tabs are notified through the state cookie."
          title="Navigations that are instant and safe"
        >
          <TwoTabsDemo />
        </CenteredSection>

        <OneTwoSection
          description="Response routes are ordinary tree entries, not a parallel routing system. The same URL serves the RSC page to a browser and JSON to an API client, dispatched by Accept header. Errors serialize as RFC 9457 problem details."
          title="One URL, negotiated by Accept"
        >
          <SectionCode>
            <ResponseRoutesSnippet components={snippetComponents} />
          </SectionCode>
        </OneTwoSection>

        <OneTwoSection
          description="Every feature a consumer can touch is reachable through shipped testing primitives: real handlers, real middleware chains, real Flight serialization. What we use to test the router is what you get to test your app."
          title="Testing is part of the API surface"
        >
          <SectionCode>
            <TestingSnippet components={snippetComponents} />
          </SectionCode>
        </OneTwoSection>

        <CenteredSection
          description="create-rango scaffolds a complete streaming RSC app with routes, layouts, loaders, Server Actions, and caching, wired for one deploy target."
          title="Start from a template"
        >
          <div className="grid gap-4 md:grid-cols-3">
            {TEMPLATES.map((template) => (
              <a
                className="group flex flex-col gap-3 rounded-xl border border-gray-alpha-400 p-5 transition-colors hover:border-gray-alpha-500 hover:bg-background-200"
                href={TEMPLATES_URL}
                key={template.name}
                rel="noopener noreferrer"
                target="_blank"
              >
                <h3 className="font-semibold tracking-tight">
                  {template.name}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {template.detail}
                </p>
                <code className="mt-auto block overflow-x-auto whitespace-nowrap rounded-md bg-background-200 px-3 py-2 font-mono text-xs text-gray-900">
                  {template.command}
                </code>
              </a>
            ))}
          </div>
        </CenteredSection>

        <section className="grid gap-8 py-8 sm:py-12">
          <div className="grid max-w-3xl gap-2">
            <h2 className="font-sans font-semibold text-3xl text-gray-1000 leading-10 tracking-[-0.04em]">
              What it costs
            </h2>
            <p className="text-balance text-lg text-muted-foreground">
              The pitch above is only credible with the trade-offs.
            </p>
          </div>
          <div className="grid gap-8 md:grid-cols-2">
            {TRADEOFFS.map((item) => (
              <div key={item.title}>
                <h3 className="mb-2 font-sans font-semibold text-lg tracking-tight dark:text-white">
                  {item.title}
                </h3>
                <p className="text-muted-foreground">{item.description}</p>
              </div>
            ))}
          </div>
        </section>

        <CTA
          className="mt-12 sm:mt-32"
          description="Correct by default. The source is the source of truth."
          primary={{ href: "/docs", label: "Read the docs" }}
          secondary={{ href: GITHUB_URL, label: "GitHub", target: "_blank" }}
          title="Explicit over implicit."
        />
      </div>
    </div>
  );
}
