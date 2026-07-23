import type { ReactNode } from "react";

import { BrowserChrome } from "@/components/fake-browser/browser-chrome";
import { ImagePlaceholder } from "@/components/fake-browser/primitives";

/**
 * Rango-specific docs demos, composed from the fake-browser segmentation
 * primitives. Visual language matches the shop demos: solid purple = static /
 * cached shell, dashed blue = live segment resolved on every request. Labels
 * here are mono chips naming the exact DSL primitive that produced the region,
 * so code snippets and pictures map one-to-one.
 */

type Tone = "live" | "static" | "structure";

const chipTone: Record<Tone, string> = {
  live: "bg-blue-700",
  static: "bg-purple-700",
  structure: "bg-fuchsia-700",
};

const regionTone: Record<Tone, string> = {
  live: "border-dashed border-blue-700 bg-blue-100/50 dark:bg-blue-950/20",
  static: "border-purple-700 bg-white dark:bg-purple-950/20",
  structure: "border-fuchsia-700 bg-white dark:bg-fuchsia-950/20",
};

const Region = ({
  children,
  className,
  label,
  tone,
}: {
  children: ReactNode;
  className?: string;
  label: string;
  tone: Tone;
}) => (
  <div
    className={`relative rounded-lg border-2 p-3 pt-4 ${regionTone[tone]} ${className ?? ""}`}
  >
    <span
      className={`absolute -top-2.5 left-2 rounded-full px-2 py-0.5 font-mono text-[10px] font-medium whitespace-nowrap text-white ${chipTone[tone]}`}
    >
      {label}
    </span>
    {children}
  </div>
);

const Bar = ({ className }: { className?: string }) => (
  <div className={`rounded bg-black/10 dark:bg-white/10 ${className ?? ""}`} />
);

/* ------------------------------------------------------------------ */
/* Routing: the urls() tree on the left IS the page on the right.      */
/* ------------------------------------------------------------------ */

const treeLines: { text: string; tone?: Tone }[] = [
  { text: "urls(({ path, layout, loader, loading }) => [" },
  { text: "  layout(<ShopLayout />, () => [", tone: "static" },
  { text: "    loader(CartLoader),", tone: "live" },
  { text: '    path("/shop/:slug", ProductPage, () => [', tone: "structure" },
  { text: "      loader(StockLoader),", tone: "live" },
  { text: "      loading(<ProductSkeleton />)," },
  { text: "    ])," },
  { text: "  ])," },
  { text: "]);" },
];

export const TreeToPageDemo = () => (
  <div className="not-prose mb-6 grid gap-4 lg:grid-cols-[1fr_1.2fr]">
    <div className="rounded-xl border bg-fd-background p-4 font-mono text-xs leading-6">
      {treeLines.map((line, i) => (
        <div className="flex items-center gap-2" key={i}>
          <span
            className={`size-2 shrink-0 rounded-full ${line.tone ? chipTone[line.tone] : "bg-transparent"}`}
          />
          <span className="whitespace-pre text-fd-muted-foreground">
            {line.text}
          </span>
        </div>
      ))}
    </div>
    <BrowserChrome url="rango.dev/shop/espresso-cup">
      <Region label="layout(<ShopLayout />)" tone="static">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="size-6 rounded-full bg-black/10 dark:bg-white/10" />
            <Bar className="h-3 w-20" />
          </div>
          <Region
            className="!p-1.5 !pt-1.5 !rounded"
            label="CartLoader"
            tone="live"
          >
            <div className="size-4 rounded bg-black/10 dark:bg-white/10" />
          </Region>
        </div>
        <Region label='path("/shop/:slug")' tone="structure">
          <div className="grid grid-cols-[1fr_1.4fr] gap-3">
            <ImagePlaceholder className="aspect-square rounded-md" />
            <div className="flex flex-col gap-2 py-1">
              <Bar className="h-3 w-4/5" />
              <Bar className="h-3 w-3/5" />
              <Bar className="h-2 w-2/5" />
              <Region className="mt-2" label="StockLoader" tone="live">
                <Bar className="h-2 w-1/2" />
              </Region>
            </div>
          </div>
        </Region>
      </Region>
    </BrowserChrome>
  </div>
);

/* ------------------------------------------------------------------ */
/* Loaders: frozen shell vs the live lane.                             */
/* ------------------------------------------------------------------ */

export const LoaderLanesDemo = () => (
  <BrowserChrome url="rango.dev/shop/espresso-cup">
    <Region label="shell — rendered with the handler" tone="static">
      <div className="mb-3 grid grid-cols-[1fr_1.4fr] gap-3">
        <ImagePlaceholder className="aspect-square rounded-md" />
        <div className="flex flex-col gap-2 py-1">
          <Bar className="h-3 w-full" />
          <Bar className="h-3 w-3/5" />
          <Bar className="h-2 w-2/5" />
          <Region
            className="mt-2"
            label="useLoader(StockLoader) — fresh every request"
            tone="live"
          >
            <Bar className="h-2 w-1/2" />
          </Region>
        </div>
      </div>
      <Region
        label="useFetchLoader(ReviewsPanel) — fetched when the tab opens"
        tone="live"
      >
        <div className="flex gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div className="flex flex-1 flex-col gap-1.5" key={i}>
              <Bar className="h-2 w-full" />
              <Bar className="h-2 w-4/5" />
              <Bar className="h-2 w-3/5" />
            </div>
          ))}
        </div>
      </Region>
    </Region>
  </BrowserChrome>
);

/* ------------------------------------------------------------------ */
/* Caching: a cache HIT streams the stored shell while loaders re-run. */
/* ------------------------------------------------------------------ */

export const CacheHitDemo = () => (
  <BrowserChrome url="rango.dev/products">
    <Region
      label="cache({ ttl: 600 }) — HIT, streamed from the store"
      tone="static"
    >
      <div className="mb-3">
        <Bar className="mb-1 h-4 w-32" />
        <Bar className="h-2 w-48" />
      </div>
      <div className="mb-3 grid grid-cols-4 gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div className="flex flex-col gap-1" key={i}>
            <ImagePlaceholder className="aspect-square rounded" />
            <Bar className="h-2 w-full" />
          </div>
        ))}
      </div>
      <Region
        label="loader(StockLoader) — never cached, re-runs on every hit"
        tone="live"
      >
        <div className="grid grid-cols-4 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Bar className="h-2 w-3/4" key={i} />
          ))}
        </div>
      </Region>
    </Region>
  </BrowserChrome>
);

/* ------------------------------------------------------------------ */
/* Middleware: the onion, with the action outside route middleware.    */
/* ------------------------------------------------------------------ */

const OnionRing = ({
  children,
  label,
  note,
}: {
  children?: ReactNode;
  label: string;
  note?: string;
}) => (
  <div className="rounded-xl border-2 border-dashed border-blue-700/60 bg-blue-100/30 p-3 dark:bg-blue-950/10">
    <div className="mb-2 flex flex-wrap items-baseline gap-2">
      <span className="font-mono text-xs font-medium">{label}</span>
      {note ? (
        <span className="text-xs text-fd-muted-foreground">{note}</span>
      ) : null}
    </div>
    {children}
  </div>
);

export const MiddlewareOnionDemo = () => (
  <div className="not-prose mb-6 rounded-xl border bg-fd-background p-4">
    <OnionRing
      label="router.use(logger)"
      note="global — wraps the entire request"
    >
      <OnionRing
        label='router.use("/admin/*", requireAuth)'
        note="global, pattern-scoped — the only middleware that guards actions"
      >
        <div className="mb-2 rounded-lg border border-black/15 px-3 py-2 font-mono text-xs text-fd-muted-foreground dark:border-white/15">
          server action executes here — before route middleware
        </div>
        <OnionRing
          label="middleware(routeMw)"
          note="route — wraps every render pass, sees action-set state"
        >
          <div className="rounded-lg border-2 border-purple-700 bg-white px-3 py-2 dark:bg-purple-950/20">
            <span className="font-mono text-xs font-medium">render pass</span>
            <span className="ml-2 text-xs text-fd-muted-foreground">
              handler + layouts + parallels, loaders streaming alongside
            </span>
          </div>
        </OnionRing>
      </OnionRing>
    </OnionRing>
  </div>
);

/* ------------------------------------------------------------------ */
/* Response routes: one URL, negotiated by Accept header.              */
/* ------------------------------------------------------------------ */

export const NegotiationDemo = () => (
  <div className="not-prose mb-6 grid gap-4 lg:grid-cols-2">
    <div>
      <p className="mb-2 font-mono text-xs text-fd-muted-foreground">
        Accept: text/html → the RSC page
      </p>
      <BrowserChrome url="rango.dev/products/espresso-cup">
        <Region label='path("/products/:id", ProductPage)' tone="static">
          <div className="grid grid-cols-[1fr_1.4fr] gap-3">
            <ImagePlaceholder className="aspect-square rounded-md" />
            <div className="flex flex-col gap-2 py-1">
              <Bar className="h-3 w-4/5" />
              <Bar className="h-3 w-3/5" />
              <Bar className="h-2 w-2/5" />
            </div>
          </div>
        </Region>
      </BrowserChrome>
    </div>
    <div>
      <p className="mb-2 font-mono text-xs text-fd-muted-foreground">
        Accept: application/json → the same URL, dispatched to path.json()
      </p>
      <div className="rounded-xl bg-gray-950 p-4 font-mono text-xs leading-5 text-gray-300 shadow-(--ds-shadow-modal)">
        <p className="text-gray-500">
          $ curl -H &quot;Accept: application/json&quot; \
        </p>
        <p className="mb-2 text-gray-500">
          {"    "}rango.dev/products/espresso-cup
        </p>
        <p>{"{"}</p>
        <p>
          {"  "}
          <span className="text-blue-400">&quot;id&quot;</span>:{" "}
          <span className="text-green-400">&quot;espresso-cup&quot;</span>,
        </p>
        <p>
          {"  "}
          <span className="text-blue-400">&quot;name&quot;</span>:{" "}
          <span className="text-green-400">&quot;Espresso Cup&quot;</span>,
        </p>
        <p>
          {"  "}
          <span className="text-blue-400">&quot;price&quot;</span>:{" "}
          <span className="text-amber-300">1400</span>,
        </p>
        <p>
          {"  "}
          <span className="text-blue-400">&quot;inStock&quot;</span>:{" "}
          <span className="text-amber-300">true</span>
        </p>
        <p>{"}"}</p>
      </div>
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/* Metadata: segments push, the collected head layers.                 */
/* ------------------------------------------------------------------ */

export const MetaLayersDemo = () => (
  <div className="not-prose mb-6 rounded-xl border bg-fd-background p-4">
    <div className="mb-4 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-purple-700 px-2 py-0.5 font-mono text-[10px] font-medium text-white">
          layout
        </span>
        <code className="font-mono text-xs text-fd-muted-foreground">
          {'meta({ title: { template: "%s | Acme", default: "Acme" } })'}
        </code>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-fuchsia-700 px-2 py-0.5 font-mono text-[10px] font-medium text-white">
          route
        </span>
        <code className="font-mono text-xs text-fd-muted-foreground">
          {"meta({ title: product.name })"}
        </code>
      </div>
    </div>
    <div className="rounded-t-xl border border-b-0 bg-black/5 px-3 pt-2 dark:bg-white/5">
      <div className="flex w-fit items-center gap-2 rounded-t-lg border border-b-0 bg-fd-background px-3 py-1.5 text-xs">
        <span className="size-3 rounded-sm bg-purple-700" />
        Espresso Cup | Acme
      </div>
    </div>
    <div className="rounded-b-xl border border-t-0 px-3 py-2 font-mono text-[10px] text-fd-muted-foreground">
      later segments override per key · unset removes · async values resolve
      before collection
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/* Navigation: an action in one tab strands stale caches in all tabs.  */
/* ------------------------------------------------------------------ */

export const TwoTabsDemo = () => (
  <div className="not-prose mb-6 grid gap-4 sm:grid-cols-2">
    <BrowserChrome url="rango.dev/cart — tab A">
      <div className="flex flex-col gap-2">
        <Bar className="h-3 w-2/5" />
        <Bar className="h-2 w-3/5" />
        <div className="mt-1 w-fit rounded-lg bg-black/80 px-3 py-1.5 font-mono text-[10px] text-white dark:bg-white/90 dark:text-black">
          addToCart() ran
        </div>
        <div className="mt-1 rounded-lg border-2 border-dashed border-blue-700 bg-blue-100/50 p-2 font-mono text-[10px] text-fd-muted-foreground dark:bg-blue-950/20">
          X-Rango-State rotates → prefetch cache flushed, history marked stale,
          HTTP-cached payloads stranded via Vary
        </div>
      </div>
    </BrowserChrome>
    <BrowserChrome url="rango.dev/cart — tab B">
      <div className="flex flex-col gap-2">
        <Bar className="h-3 w-2/5" />
        <Bar className="h-2 w-3/5" />
        <div className="mt-1 rounded-lg border-2 border-dashed border-blue-700 bg-blue-100/50 p-2 font-mono text-[10px] text-fd-muted-foreground dark:bg-blue-950/20">
          notified through the state cookie → paints instantly from history,
          then revalidates in the background
        </div>
      </div>
    </BrowserChrome>
  </div>
);
