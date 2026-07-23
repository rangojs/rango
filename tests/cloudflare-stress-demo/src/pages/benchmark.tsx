/**
 * Home screen: a comprehension-first map of the stress app.
 *
 * The hero is the route table itself — a clickable prefix-tree built from
 * src/route-structure.ts (data, not JSX: new groups appear on the map by
 * appending an entry there). Design notes: no webfonts (they would pollute
 * the perf numbers this app exists to measure), no motion beyond hover,
 * monospace carries the identity because route paths ARE the subject.
 * Palette = the validated categorical slots shared with /dashboard.
 */
import { Link } from "@rangojs/router/client";
import { routeGroups, type RouteGroup } from "../route-structure.js";

const CSS = `
body { margin: 0; background: #ffffff; }
@media (prefers-color-scheme: dark) {
  body { background: #1a1a19; }
}
.stress-home {
  --surface: #ffffff;
  --ink: #111110;
  --ink-2: #52514e;
  --ink-3: #8a887f;
  --line: #e4e2dd;
  --card: #f7f6f3;
  --accent: #2a78d6;
  --slot-1: #2a78d6;
  --slot-2: #1baf7a;
  --slot-3: #eda100;
  --slot-4: #008300;
  --slot-5: #4a3aa7;
  color: var(--ink);
  max-width: 880px;
  margin: 0 auto;
  padding: 2.5rem 1.25rem 4rem;
  font: 15px/1.55 system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  .stress-home {
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --ink-3: #8a887f;
    --line: #3a3936;
    --card: #232322;
    --accent: #3987e5;
    --slot-1: #3987e5;
    --slot-2: #199e70;
    --slot-3: #c98500;
    --slot-4: #008300;
    --slot-5: #9085e9;
  }
}
.stress-home .eyebrow {
  font: 12px/1 ui-monospace, monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin: 0 0 0.75rem;
}
.stress-home h1 {
  font-size: 2rem;
  letter-spacing: -0.02em;
  line-height: 1.15;
  margin: 0 0 0.75rem;
}
.stress-home .thesis { color: var(--ink-2); max-width: 46rem; margin: 0 0 1.25rem; }
.stress-home .cta-row { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; margin-bottom: 2.5rem; }
.stress-home .cta {
  display: inline-block; padding: 0.55rem 1.1rem; border-radius: 6px;
  background: var(--accent); color: #fff; text-decoration: none; font-weight: 600;
}
.stress-home .cta-note { color: var(--ink-3); font-size: 13px; }
.stress-home h2 { font-size: 1.05rem; margin: 2.5rem 0 0.75rem; }
.stress-home .tree {
  border: 1px solid var(--line); border-radius: 8px; background: var(--card);
  padding: 1rem 1.25rem; font: 13px/1.5 ui-monospace, monospace;
  overflow-x: auto;
}
.stress-home .tree-row { display: flex; align-items: baseline; gap: 0.75rem; padding: 0.35rem 0; flex-wrap: wrap; }
.stress-home .tree-row + .tree-row { border-top: 1px solid var(--line); }
.stress-home .tree-glyph { color: var(--ink-3); white-space: pre; }
.stress-home .tree-prefix { font-weight: 600; white-space: nowrap; }
.stress-home .tree-prefix .dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  margin-right: 6px; vertical-align: 1px;
}
.stress-home .badge {
  font-size: 11px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--ink-2); white-space: nowrap;
}
.stress-home .count { margin-left: auto; font-weight: 600; white-space: nowrap; }
.stress-home .tree-sub {
  flex-basis: 100%; display: flex; gap: 0.5rem; flex-wrap: wrap;
  padding-left: 2.4rem; font-family: system-ui, sans-serif; font-size: 12.5px;
}
.stress-home .tree-sub .what { color: var(--ink-2); margin-right: 0.5rem; }
.stress-home .tree-sub a {
  color: var(--accent); text-decoration: none; border: 1px solid var(--line);
  border-radius: 4px; padding: 0 6px; font-family: ui-monospace, monospace; font-size: 12px;
}
.stress-home .tree-sub a:hover { border-color: var(--accent); }
.stress-home .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 0.75rem; }
.stress-home .tile { border: 1px solid var(--line); border-radius: 8px; padding: 0.9rem 1rem; background: var(--card); }
.stress-home .tile h3 { margin: 0 0 0.35rem; font-size: 0.95rem; }
.stress-home .tile p { margin: 0 0 0.5rem; color: var(--ink-2); font-size: 13.5px; }
.stress-home .tile .see { font-size: 13px; color: var(--accent); text-decoration: none; }
.stress-home .nav-pair { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center; }
.stress-home .nav-pair a {
  border: 1px solid var(--line); border-radius: 6px; padding: 0.4rem 0.8rem;
  color: var(--ink); text-decoration: none;
}
.stress-home .nav-pair a:hover { border-color: var(--accent); }
.stress-home .nav-pair .tag { font-size: 11px; color: var(--ink-3); display: block; }
.stress-home .fine { color: var(--ink-3); font-size: 13px; }
.stress-home .fine code, .stress-home p code { font-family: ui-monospace, monospace; font-size: 0.92em; }
.stress-home a:focus-visible, .stress-home .cta:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}
`;

function TreeRow({ group, last }: { group: RouteGroup; last: boolean }) {
  const glyph = group.prefix === "/" ? " " : last ? "└──" : "├──";
  return (
    <div className="tree-row" data-testid={`tree-${group.id}`}>
      <span className="tree-glyph">{glyph}</span>
      <span className="tree-prefix">
        <span
          className="dot"
          style={{ background: `var(--slot-${group.slot})` }}
        />
        {group.prefix}
      </span>
      <span className="badge">
        {group.chunk === "async" ? "async chunk" : "eager"}
      </span>
      {group.nested?.map((n) => (
        <span key={n} className="badge">
          nested: {n}
        </span>
      ))}
      <span className="count">{group.count} routes</span>
      <span className="tree-sub">
        <span className="what">{group.stresses}</span>
        {group.links.map((l) => (
          <a key={l.path} href={l.path}>
            {l.label}
          </a>
        ))}
      </span>
    </div>
  );
}

export function HomePage() {
  return (
    <div className="stress-home">
      <style>{CSS}</style>

      <p className="eyebrow">cloudflare-stress-demo · @rangojs/router</p>
      <h1>26,000 routes, one worker.</h1>
      <p className="thesis">
        Matching is O(path segments) through a precomputed trie, so the route
        count does not slow requests down. What it does cost — cold-start
        manifest parsing, per-group chunk loads, memory, and the 404 fallback
        scan — this app makes visible and clickable.
      </p>
      <p className="cta-row">
        <a className="cta" href="/dashboard" data-testid="home-dashboard-cta">
          Open the benchmark dashboard
        </a>
        <span className="cta-note">
          any route class, N runs, median/p90 + Server-Timing — works against
          dev and the deployed edge
        </span>
      </p>

      <h2>The route table</h2>
      <p className="fine">
        Every group is an <code>include(prefix, () =&gt; import(…))</code> — its
        own worker chunk, awaited on the first request to that prefix. Click
        into any group:
      </p>
      <div className="tree" data-testid="home-tree">
        {routeGroups.map((g, i) => (
          <TreeRow key={g.id} group={g} last={i === routeGroups.length - 1} />
        ))}
      </div>

      <h2>Where the route count costs</h2>
      <div className="tiles">
        <div className="tile">
          <h3>Cold start</h3>
          <p>
            The first request parses the routes-manifest chunk (~5.7 MB raw at
            26k routes); the named-routes chunk loads with the worker entry.
          </p>
          <a className="see" href="/dashboard">
            Measure: bench cold phase, or dashboard after a fresh deploy →
          </a>
        </div>
        <div className="tile">
          <h3>First hit per prefix</h3>
          <p>
            Each async group pays one chunk import on its first request — then
            it is resident for the isolate's lifetime.
          </p>
          <a className="see" href="/dashboard">
            Measure: dashboard, any class, watch run 1 vs the rest →
          </a>
        </div>
        <div className="tile">
          <h3>404 fallback scan</h3>
          <p>
            Unmatched paths miss the trie and fall through to the regex scan —
            the only remaining route-count-proportional path. Static prefixes
            let it skip whole groups.
          </p>
          <a className="see" href="/dashboard">
            Measure: dashboard, the 404 classes →
          </a>
        </div>
      </div>

      <h2>Two ways to navigate</h2>
      <p className="fine">
        Same target, different transport — a full document load vs the client
        router's Flight request (hover the second one to see prefetch fire in
        the network tab):
      </p>
      <div className="nav-pair">
        <a href="/site/en/flat/1" data-testid="home-doc-link">
          /site/en/flat/1
          <span className="tag">document load (plain &lt;a&gt;)</span>
        </a>
        <Link to="/site/en/flat/1" prefetch="hover" data-testid="home-nav-link">
          /site/en/flat/1
          <span className="tag">
            client navigation (&lt;Link prefetch="hover"&gt;)
          </span>
        </Link>
        <span className="fine">The dashboard's mode toggle measures both.</span>
      </div>

      <h2>Reading matchStats</h2>
      <p className="fine">
        Bench endpoints (<code>/bench/first</code>, <code>/api/bench/last</code>
        , …) return JSON with <code>matchStats</code>. All zeros is the correct
        steady-state answer: named routes are trie hits and the regex scanner —
        the only code that increments those counters — never runs. Non-zero
        stats appear only on the 404 fallback, and only with the{" "}
        <code>MATCH_DEBUG=1</code> binding set; the counters are module-global,
        single-request diagnostics. Full methodology: <code>BENCHMARK.md</code>;
        agent contract: <code>AGENTS.md</code>. The{" "}
        <a href="/links">links demo</a> covers <code>reverse()</code>/
        <code>href()</code> across the full registry.
      </p>
    </div>
  );
}
