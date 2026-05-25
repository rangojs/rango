import {
  SharedKeyCard,
  GroupCard,
  GroupRefreshButton,
  ProductCard,
} from "../components/refresh-demo/RefreshCards.js";
import {
  CartBadge,
  ProductsTable,
} from "../components/refresh-demo/ProductsCart.js";
import {
  ActiveUsersLoader,
  OpenOrdersLoader,
  LatencyLoader,
} from "../handlers/refresh-demo/loaders.js";

const grid: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  marginTop: 12,
};
const section: React.CSSProperties = {
  marginTop: 28,
  paddingTop: 8,
};
const note: React.CSSProperties = {
  marginTop: 28,
  padding: "12px 14px",
  background: "#ddf4ff",
  border: "1px solid #b6e3ff",
  borderRadius: 8,
  fontSize: 14,
  color: "#0969da",
  maxWidth: 760,
};

export function RefreshDemoPage() {
  return (
    <main data-testid="refresh-demo-page" style={{ padding: "8px 4px" }}>
      <h1>Client Refresh — keys &amp; groups</h1>
      <p style={{ maxWidth: 760, color: "#57606a" }}>
        Showcases the loader client-refresh primitives: a per-loader{" "}
        <code>key</code> (reads sharing a key refresh together) and a
        cross-loader <code>refreshGroup</code> refreshed via{" "}
        <code>useRefreshLoaders()</code>. No <code>loading()</code> boundary and
        no server actions — just loaders, fetch loaders, and the client refresh.
      </p>

      <section style={section}>
        <h2>Shared key</h2>
        <p style={{ color: "#57606a", maxWidth: 760 }}>
          Three cards read the same loader with <code>key="revenue"</code>. A{" "}
          <code>load()</code> from any one is a <b>single</b> server fetch whose
          result fans out to all three — watch <b>server calls</b> jump by
          exactly 1 across every card, with identical values.
        </p>
        <div style={grid}>
          <SharedKeyCard id="rev-a" withButton />
          <SharedKeyCard id="rev-b" />
          <SharedKeyCard id="rev-c" withButton />
        </div>
      </section>

      <section style={section}>
        <h2>Streaming loader</h2>
        <p style={{ color: "#57606a", maxWidth: 760 }}>
          A keyed loader (<code>key="product"</code>) whose payload arrives in
          two parts: the header (name/price) renders immediately, while a nested{" "}
          <code>details</code> promise <b>streams</b> into a nested{" "}
          <code>&lt;Suspense&gt;</code> a beat later. A <code>load()</code> from
          one card is a <b>single</b> fetch that re-streams <b>both</b>. On
          refresh the already-streamed details are held (the hook commits in{" "}
          <code>startTransition</code>) — they swap in place rather than
          flashing back to the skeleton.
        </p>
        <div style={grid}>
          <ProductCard id="prod-a" withButton />
          <ProductCard id="prod-b" />
        </div>
      </section>

      <section style={section}>
        <h2>Refresh group &quot;metrics&quot;</h2>
        <p style={{ color: "#57606a", maxWidth: 760 }}>
          Three different loaders tagged <code>refreshGroup="metrics"</code>.
          One <code>useRefreshLoaders("metrics")()</code> call refreshes all
          three at once (plain GET each, in parallel).
        </p>
        <div style={{ marginTop: 12 }}>
          <GroupRefreshButton />
        </div>
        <div style={grid}>
          <GroupCard
            id="users"
            label="Active users"
            loader={ActiveUsersLoader}
          />
          <GroupCard
            id="orders"
            label="Open orders"
            loader={OpenOrdersLoader}
          />
          <GroupCard id="latency" label="p95 latency" loader={LatencyLoader} />
        </div>
      </section>

      <section style={section}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <h2 style={{ margin: 0 }}>Products &amp; cart</h2>
          <CartBadge id="header" label="Cart" />
        </div>
        <p style={{ color: "#57606a", maxWidth: 760 }}>
          A paginated table — <b>Load more</b> calls{" "}
          <code>load(&#123; params: &#123; cursor &#125; &#125;)</code> and
          appends the next page. <b>Add to cart</b> is a server action; the cart
          count re-renders via the refresh primitive (
          <code>useRefreshLoaders("cart")</code>), not from the action's return
          value. Both cart badges read <code>CartLoader</code> with{" "}
          <code>key="cart"</code>, so one refresh fans the new count out to both
          at once.
        </p>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 520px", minWidth: 360 }}>
            <ProductsTable />
          </div>
          <aside
            style={{
              flex: "0 0 auto",
              alignSelf: "flex-start",
              marginTop: 12,
            }}
          >
            <CartBadge id="sidebar" label="Items in cart" />
          </aside>
        </div>
      </section>

      <p style={note}>
        Each card body suspends through a real <code>&lt;Suspense&gt;</code>{" "}
        boundary. The first load shows the skeleton; a refresh dims the card
        (the “refreshing…” badge) and the value cross-updates <b>without</b>{" "}
        flashing back to the skeleton — the hook commits new data inside{" "}
        <code>startTransition</code>, so the already-rendered card is kept. An
        e2e asserts the skeleton never reappears during a refresh.
      </p>
    </main>
  );
}
