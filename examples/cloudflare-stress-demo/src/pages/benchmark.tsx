/**
 * Benchmark locations to test route matching with prefix optimization
 */
const benchmarkLocations = [
  {
    category: "Root Routes (no prefix)",
    routes: [
      { path: "/bench/first", desc: "First root route (1 route checked)" },
      { path: "/bench/last", desc: "Last root route (3 routes checked)" },
    ],
  },
  {
    category: "API Routes (skips /site entry)",
    routes: [
      { path: "/api/bench/first", desc: "First API route (skips 5,003 site routes)" },
      { path: "/api/bench/last", desc: "Last API route (5,005 routes checked)" },
    ],
  },
  {
    category: "Site Routes",
    routes: [
      { path: "/site/en/bench/first", desc: "First site route" },
      { path: "/site/en/bench/last", desc: "Last site route (5,006 routes checked)" },
    ],
  },
];

export function HomePage() {
  return (
    <div style={{ maxWidth: "800px", margin: "0 auto", padding: "2rem" }}>
      <h1>@rangojs/router Stress Test</h1>
      <p style={{ color: "#666", marginBottom: "2rem", fontSize: "1.1rem" }}>
        10,000+ routes demonstrating <strong>prefix-based short-circuit optimization</strong> for route matching.
      </p>

      <h2>What This Tests</h2>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Routes are grouped by <code>include()</code> prefix into separate entries.
        When matching, entries are <strong>skipped entirely</strong> if the pathname
        doesn't start with the entry's static prefix.
      </p>

      <h2>Route Structure</h2>
      <ul style={{ marginBottom: "2rem", lineHeight: "1.8" }}>
        <li><strong>3 root routes</strong> — <code>/bench/first</code>, <code>/</code>, <code>/bench/last</code></li>
        <li><strong>5,003 site routes</strong> — under <code>/site/:locale/*</code> (staticPrefix: "/site")</li>
        <li><strong>5,002 API routes</strong> — under <code>/api/*</code> (staticPrefix: "/api")</li>
      </ul>

      <div style={{
        background: "#e8f5e9",
        padding: "1rem",
        borderRadius: "8px",
        marginBottom: "2rem"
      }}>
        <strong>Optimization Impact:</strong> API routes skip 5,003 site routes.
        404s for non-prefixed paths skip ~10,000 routes (99.97% savings).
      </div>

      <h2>Benchmark Endpoints</h2>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Each returns JSON with <code>matchStats</code> showing routes checked/skipped:
      </p>

      {benchmarkLocations.map(({ category, routes }) => (
        <div key={category} style={{ marginBottom: "1.5rem" }}>
          <h3 style={{ fontSize: "1rem", color: "#555", marginBottom: "0.5rem" }}>
            {category}
          </h3>
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {routes.map(({ path, desc }) => (
              <a
                key={path}
                href={path}
                style={{
                  display: "block",
                  padding: "0.75rem 1rem",
                  background: "#f5f5f5",
                  borderRadius: "4px",
                  textDecoration: "none",
                  color: "#333",
                }}
              >
                <code style={{ color: "#0070f3" }}>{path}</code>
                <span style={{ color: "#666", marginLeft: "1rem", fontSize: "0.9rem" }}>
                  {desc}
                </span>
              </a>
            ))}
          </div>
        </div>
      ))}

      <h2>How to Benchmark</h2>
      <ol style={{ lineHeight: "1.8" }}>
        <li>Open DevTools → Network tab</li>
        <li>Click benchmark endpoints above</li>
        <li>Check <code>matchStats</code> in JSON response</li>
        <li>Compare <code>entriesSkipped</code> and <code>routesChecked</code></li>
        <li>Measure TTFB: <code>curl -w "TTFB: %&#123;time_starttransfer&#125;s\n" -so /dev/null URL</code></li>
      </ol>

      <h2>Expected Results</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1rem" }}>
        <thead>
          <tr style={{ background: "#f5f5f5" }}>
            <th style={{ padding: "0.5rem", textAlign: "left", borderBottom: "2px solid #ddd" }}>Route</th>
            <th style={{ padding: "0.5rem", textAlign: "right", borderBottom: "2px solid #ddd" }}>Skipped</th>
            <th style={{ padding: "0.5rem", textAlign: "right", borderBottom: "2px solid #ddd" }}>Checked</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}><code>/bench/first</code></td>
            <td style={{ padding: "0.5rem", textAlign: "right", borderBottom: "1px solid #eee" }}>0</td>
            <td style={{ padding: "0.5rem", textAlign: "right", borderBottom: "1px solid #eee" }}>1</td>
          </tr>
          <tr>
            <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}><code>/api/bench/first</code></td>
            <td style={{ padding: "0.5rem", textAlign: "right", borderBottom: "1px solid #eee", color: "#2e7d32", fontWeight: "bold" }}>1 (5,003)</td>
            <td style={{ padding: "0.5rem", textAlign: "right", borderBottom: "1px solid #eee" }}>4</td>
          </tr>
          <tr>
            <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}><code>/api/bench/last</code></td>
            <td style={{ padding: "0.5rem", textAlign: "right", borderBottom: "1px solid #eee", color: "#2e7d32", fontWeight: "bold" }}>1 (5,003)</td>
            <td style={{ padding: "0.5rem", textAlign: "right", borderBottom: "1px solid #eee" }}>5,005</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
