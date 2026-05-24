import {
  SharedKeyCard,
  GroupCard,
  GroupRefreshButton,
} from "../components/refresh-demo/RefreshCards.js";
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
