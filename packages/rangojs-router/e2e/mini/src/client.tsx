"use client";

// THE single client file.
//
// One "use client" module exporting every interactive component. The server
// tree in router.tsx renders these; RSC sends only components referenced by the
// server graph to the browser, where they hydrate. Covers the full client
// surface: useLoader / useFetchLoader / useRefreshLoaders, useRouter /
// useNavigation / usePathname / useSegments / useParams / useSearchParams,
// useAction + useActionState (server actions), useLocationState, useHandle +
// Breadcrumbs, Link / useHref / useMount / useLinkStatus, and ScrollRestoration.

import { useActionState, useState, useTransition } from "react";
import {
  Link,
  useLoader,
  useFetchLoader,
  useRefreshLoaders,
  useRouter,
  useNavigation,
  usePathname,
  useSegments,
  useParams,
  useSearchParams,
  useAction,
  useLocationState,
  useHandle,
  useHref,
  useMount,
  useReverse,
  useLinkStatus,
  href,
  Breadcrumbs,
} from "@rangojs/router/client";

import {
  ClockLoader,
  CounterLoader,
  CartLoader,
  EchoLoader,
  FlashMessage,
  Origin,
} from "./shared.js";
import {
  increment,
  incrementWithResult,
  addToCart,
  saveFlashRedirect,
} from "./actions.js";
// Per-module routes map (emitted by `rango generate src/urls/products.tsx`) for
// mount-aware, local-name useReverse (".index"/".detail").
import { routes as productsRoutes } from "./urls/products.gen.js";
// Combined named-routes map (auto-emitted by the dev/build plugin). useReverse
// also accepts THIS, using full dotted global names (".products.detail") — no
// per-module gen required. useReverse always joins the current mount, and the
// global map's paths are absolute, so this form is correct only at the root
// mount (where the mount prefix is empty); under a non-root mount it would
// double-prefix.
import { NamedRoutes } from "./router.named-routes.gen.js";

// ---------------------------------------------------------------------------
// Navigation chrome
// ---------------------------------------------------------------------------

export function AppNav() {
  return (
    <nav data-testid="app-nav">
      <Link to="/" data-testid="nav-home">
        Home
      </Link>
      {" | "}
      <Link to="/counter" data-testid="nav-counter">
        Counter
      </Link>
      {" | "}
      <Link to="/products" data-testid="nav-products">
        Products
      </Link>
      {" | "}
      <Link to="/search?q=hi&page=1" data-testid="nav-search">
        Search
      </Link>
      {" | "}
      <Link to="/cache" data-testid="nav-cache">
        Cache
      </Link>
      {" | "}
      <Link to="/state" data-testid="nav-state">
        State
      </Link>
      {" | "}
      <Link to="/hooks" data-testid="nav-hooks">
        Hooks
      </Link>
      {" | "}
      <Link to="/secret" data-testid="nav-secret">
        Secret
      </Link>
    </nav>
  );
}

export function BreadcrumbTrail() {
  const crumbs = useHandle(Breadcrumbs);
  return (
    <nav data-testid="breadcrumb-trail" aria-label="Breadcrumb">
      {crumbs.map((c, i) => (
        <span key={c.href} data-testid={`crumb-${i}`}>
          {i > 0 ? " › " : ""}
          <a href={c.href}>{c.label}</a>
        </span>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export function ClockWidget() {
  const { data } = useLoader(ClockLoader, { refreshGroup: "clocks" });
  const refresh = useRefreshLoaders();
  return (
    <div data-testid="clock-widget">
      <span data-testid="clock-seq">{data.seq}</span>
      <button
        type="button"
        data-testid="clock-refresh"
        onClick={() => refresh("clocks")}
      >
        Refresh clock
      </button>
    </div>
  );
}

export function FreshClock() {
  const { data } = useLoader(ClockLoader);
  return <span data-testid="fresh-seq">{data.seq}</span>;
}

export function FetchEcho() {
  const { data, load, isLoading } = useFetchLoader(EchoLoader);
  return (
    <div data-testid="fetch-echo">
      <span data-testid="echo-value">{data ? data.echo : "none"}</span>
      <button
        type="button"
        data-testid="echo-load"
        disabled={isLoading}
        onClick={() => void load()}
      >
        Fetch echo
      </button>
    </div>
  );
}

export function CartSlot() {
  const { data } = useLoader(CartLoader);
  return <span data-testid="cart-count">{data.count}</span>;
}

// ---------------------------------------------------------------------------
// Server actions
// ---------------------------------------------------------------------------

export function CountDisplay() {
  const { data } = useLoader(CounterLoader);
  return <span data-testid="count-value">{data.count}</span>;
}

export function IncrementButton() {
  const [state, formAction, isPending] = useActionState(
    async () => await incrementWithResult(),
    null,
  );
  return (
    <form action={formAction}>
      <button type="submit" data-testid="increment-button" disabled={isPending}>
        {isPending ? "…" : "Increment (form)"}
      </button>
      {state && <span data-testid="increment-result">{state.count}</span>}
    </form>
  );
}

export function IncrementImperative() {
  const [isPending, start] = useTransition();
  const tracked = useAction(increment);
  return (
    <div>
      <button
        type="button"
        data-testid="increment-imperative"
        disabled={isPending}
        onClick={() => start(() => increment())}
      >
        Increment (imperative)
      </button>
      <span data-testid="action-state">{tracked.state}</span>
    </div>
  );
}

export function AddToCartButton({ productId }: { productId: string }) {
  const [state, formAction, isPending] = useActionState(
    async () => await addToCart(productId),
    null,
  );
  return (
    <form action={formAction} style={{ display: "inline" }}>
      <button
        type="submit"
        data-testid={`add-to-cart-${productId}`}
        disabled={isPending}
      >
        Add
      </button>
      {state && (
        <span data-testid={`add-to-cart-result-${productId}`}>
          {state.count}
        </span>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Params / transition
// ---------------------------------------------------------------------------

export function ParamReadout() {
  const params = useParams<{ id: string }>();
  return <span data-testid="param-id">{params.id}</span>;
}

export function DetailCounter() {
  const [count, setCount] = useState(0);
  return (
    <button
      type="button"
      data-testid="detail-counter"
      onClick={() => setCount((c) => c + 1)}
    >
      count:{count}
    </button>
  );
}

export function ModalClose() {
  const router = useRouter();
  return (
    <button
      type="button"
      data-testid="modal-close"
      onClick={() => router.back()}
    >
      Close
    </button>
  );
}

// ---------------------------------------------------------------------------
// Mount-aware links (inside the /products include)
// ---------------------------------------------------------------------------

export function MountInfo() {
  const mount = useMount();
  const localHref = useHref();
  return (
    <div data-testid="mount-info">
      <span data-testid="mount-value">{mount}</span>
      <span data-testid="local-href">{localHref("/2")}</span>
    </div>
  );
}

// Standalone, mount-unaware href() helper — validates the path against the
// generated route map at the type level and returns it verbatim at runtime.
export function StaticHref() {
  return <span data-testid="static-href">{href("/counter")}</span>;
}

// Mount-aware client reverse: resolves names against the products module's
// generated routes map, auto-prefixing the include() mount ("/products").
// Rendered inside the products layout so the mount is in scope. The leading dot
// is optional — reverse("detail") and reverse(".detail") resolve identically.
export function ProductsReverse() {
  const reverse = useReverse(productsRoutes);
  return (
    <div data-testid="products-reverse">
      <span data-testid="reverse-index">{reverse(".index")}</span>
      <span data-testid="reverse-detail">
        {reverse(".detail", { id: "2" })}
      </span>
      {/* same map, no leading dot — identical results */}
      <span data-testid="reverse-index-nodot">{reverse("index")}</span>
      <span data-testid="reverse-detail-nodot">
        {reverse("detail", { id: "2" })}
      </span>
    </div>
  );
}

// useReverse over the COMBINED named-routes gen (router.named-routes.gen.ts),
// using full dotted GLOBAL names — no per-module gen required. Rendered at the
// root (mount "/"), where the global map's absolute paths pass through unchanged.
export function GlobalReverse() {
  const reverse = useReverse(NamedRoutes);
  return (
    <div data-testid="global-reverse">
      <span data-testid="global-reverse-home">{reverse(".home")}</span>
      <span data-testid="global-reverse-product">
        {reverse(".products.detail", { id: "2" })}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search params
// ---------------------------------------------------------------------------

export function SearchControls() {
  const params = useSearchParams();
  const router = useRouter();
  const current = params.get("q") ?? "";
  return (
    <div data-testid="search-controls">
      <span data-testid="search-current">{current}</span>
      <button
        type="button"
        data-testid="search-go"
        onClick={() => router.push("/search?q=hello&page=2")}
      >
        Search hello p2
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Location state
// ---------------------------------------------------------------------------

export function FlashBanner() {
  const flash = useLocationState(FlashMessage);
  return <span data-testid="flash">{flash ? flash.text : "no-flash"}</span>;
}

export function OriginReadout() {
  const origin = useLocationState(Origin);
  return <span data-testid="origin">{origin ? origin.from : "no-origin"}</span>;
}

export function SaveFlashButton() {
  const [isPending, start] = useTransition();
  return (
    <button
      type="button"
      data-testid="save-flash"
      disabled={isPending}
      onClick={() => start(() => void saveFlashRedirect())}
    >
      Save + redirect
    </button>
  );
}

export function OriginLink() {
  return (
    <Link
      to="/state"
      state={[Origin({ from: "origin-link" })]}
      data-testid="origin-link"
    >
      Set origin
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Navigation hooks
// ---------------------------------------------------------------------------

export function NavHooksDemo() {
  const router = useRouter();
  const nav = useNavigation();
  const pathname = usePathname();
  const segments = useSegments();
  return (
    <div data-testid="nav-hooks">
      <span data-testid="hook-pathname">{pathname}</span>
      <span data-testid="hook-nav-state">{nav.state}</span>
      <span data-testid="hook-segments">
        {segments.path.join("/") || "(root)"}
      </span>
      <button
        type="button"
        data-testid="hook-push"
        onClick={() => router.push("/counter")}
      >
        Push counter
      </button>
      <button
        type="button"
        data-testid="hook-back"
        onClick={() => router.back()}
      >
        Back
      </button>
      <button
        type="button"
        data-testid="hook-forward"
        onClick={() => router.forward()}
      >
        Forward
      </button>
      <button
        type="button"
        data-testid="hook-refresh"
        onClick={() => void router.refresh()}
      >
        Refresh
      </button>
    </div>
  );
}

export function LinkStatusDemo() {
  return (
    <Link to="/products" data-testid="link-status-link">
      <LinkStatusLabel />
    </Link>
  );
}

function LinkStatusLabel() {
  const status = useLinkStatus();
  return (
    <span data-testid="link-status">{status.pending ? "pending" : "idle"}</span>
  );
}
