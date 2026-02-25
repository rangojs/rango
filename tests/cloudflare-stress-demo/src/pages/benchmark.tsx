/**
 * Benchmark locations to test route matching with prefix optimization
 */
const benchmarkLocations = [
  {
    category: "Root Routes (no prefix)",
    routes: [
      { path: "/bench/first", desc: "First root route" },
      { path: "/bench/last", desc: "Last root route" },
    ],
  },
  {
    category: "API Routes (skips /site and /shop)",
    routes: [
      { path: "/api/bench/first", desc: "First API route" },
      { path: "/api/bench/last", desc: "Last API route" },
    ],
  },
  {
    category: "Site Routes",
    routes: [
      { path: "/site/en/bench/first", desc: "First site route" },
      { path: "/site/en/bench/last", desc: "Last site route" },
    ],
  },
];

/**
 * Nested includes demo - /shop with /product and /category sub-includes
 */
const nestedIncludesDemo = [
  {
    category: "Shop Product (skips /shop/category)",
    routes: [
      { path: "/shop/product/bench/first", desc: "First product route" },
      { path: "/shop/product/bench/last", desc: "Last product route" },
    ],
  },
  {
    category: "Shop Category (skips /shop/product)",
    routes: [
      { path: "/shop/category/bench/first", desc: "First category route" },
      { path: "/shop/category/bench/last", desc: "Last category route" },
    ],
  },
];

export function HomePage() {
  return (
    <div style={{ maxWidth: "800px", margin: "0 auto", padding: "2rem" }}>
      <h1>@rangojs/router Stress Test</h1>
      <p style={{ color: "#666", marginBottom: "2rem", fontSize: "1.1rem" }}>
        10,000+ routes demonstrating{" "}
        <strong>prefix-based short-circuit optimization</strong> for route
        matching.
      </p>

      <h2>What This Tests</h2>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Routes are grouped by <code>include()</code> prefix into separate
        entries. When matching, entries are <strong>skipped entirely</strong> if
        the pathname doesn't start with the entry's static prefix.
      </p>

      <h2>Route Structure</h2>
      <ul style={{ marginBottom: "2rem", lineHeight: "1.8" }}>
        <li>
          <strong>3 root routes</strong> — <code>/bench/first</code>,{" "}
          <code>/</code>, <code>/bench/last</code>
        </li>
        <li>
          <strong>5,003 site routes</strong> — under{" "}
          <code>/site/:locale/*</code> (staticPrefix: "/site")
        </li>
        <li>
          <strong>5,002 API routes</strong> — under <code>/api/*</code>{" "}
          (staticPrefix: "/api")
        </li>
        <li>
          <strong>~200 shop routes</strong> — nested includes demo:
          <ul style={{ marginTop: "0.5rem" }}>
            <li>
              <code>/shop/product/*</code> — 102 routes (staticPrefix:
              "/shop/product")
            </li>
            <li>
              <code>/shop/category/*</code> — 102 routes (staticPrefix:
              "/shop/category")
            </li>
          </ul>
        </li>
      </ul>

      <div
        style={{
          background: "#e8f5e9",
          padding: "1rem",
          borderRadius: "8px",
          marginBottom: "2rem",
        }}
      >
        <strong>Optimization Impact:</strong>
        <ul style={{ margin: "0.5rem 0 0 1rem", padding: 0 }}>
          <li>API routes skip ~5,000 site routes + ~200 shop routes</li>
          <li>
            Shop product routes skip shop category routes (nested optimization!)
          </li>
          <li>404s for non-prefixed paths skip ~10,000 routes</li>
        </ul>
      </div>

      <h2>Benchmark Endpoints</h2>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Each returns JSON with <code>matchStats</code> showing routes
        checked/skipped:
      </p>

      {benchmarkLocations.map(({ category, routes }) => (
        <div key={category} style={{ marginBottom: "1.5rem" }}>
          <h3
            style={{ fontSize: "1rem", color: "#555", marginBottom: "0.5rem" }}
          >
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
                <span
                  style={{
                    color: "#666",
                    marginLeft: "1rem",
                    fontSize: "0.9rem",
                  }}
                >
                  {desc}
                </span>
              </a>
            ))}
          </div>
        </div>
      ))}

      <h2>Nested Includes Demo</h2>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        <code>/shop</code> contains nested <code>include("/product", ...)</code>{" "}
        and <code>include("/category", ...)</code>. Each gets its own{" "}
        <code>staticPrefix</code>, so they skip each other during matching.
      </p>

      <div
        style={{
          background: "#fff3e0",
          padding: "1rem",
          borderRadius: "8px",
          marginBottom: "1rem",
          fontSize: "0.9rem",
        }}
      >
        <strong>Key insight:</strong> <code>/shop/product/*</code> has
        staticPrefix <code>"/shop/product"</code>, while{" "}
        <code>/shop/category/*</code> has <code>"/shop/category"</code>. They
        are different, so the optimization works!
      </div>

      {nestedIncludesDemo.map(({ category, routes }) => (
        <div key={category} style={{ marginBottom: "1.5rem" }}>
          <h3
            style={{ fontSize: "1rem", color: "#555", marginBottom: "0.5rem" }}
          >
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
                  background: "#fff8e1",
                  borderRadius: "4px",
                  textDecoration: "none",
                  color: "#333",
                }}
              >
                <code style={{ color: "#e65100" }}>{path}</code>
                <span
                  style={{
                    color: "#666",
                    marginLeft: "1rem",
                    fontSize: "0.9rem",
                  }}
                >
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
        <li>
          Check <code>matchStats</code> in JSON response
        </li>
        <li>
          Compare <code>entriesSkipped</code> and <code>routesChecked</code>
        </li>
        <li>
          Measure TTFB:{" "}
          <code>
            curl -w "TTFB: %&#123;time_starttransfer&#125;s\n" -so /dev/null URL
          </code>
        </li>
      </ol>

      <h2>Expected Results</h2>
      <p style={{ color: "#666", marginBottom: "1rem", fontSize: "0.9rem" }}>
        Check <code>matchStats.entriesSkipped</code> in JSON response to see
        optimization in action.
      </p>
      <table
        style={{ width: "100%", borderCollapse: "collapse", marginTop: "1rem" }}
      >
        <thead>
          <tr style={{ background: "#f5f5f5" }}>
            <th
              style={{
                padding: "0.5rem",
                textAlign: "left",
                borderBottom: "2px solid #ddd",
              }}
            >
              Route
            </th>
            <th
              style={{
                padding: "0.5rem",
                textAlign: "left",
                borderBottom: "2px solid #ddd",
              }}
            >
              Skips
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
              <code>/bench/first</code>
            </td>
            <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
              Nothing (root)
            </td>
          </tr>
          <tr>
            <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
              <code>/api/bench/*</code>
            </td>
            <td
              style={{
                padding: "0.5rem",
                borderBottom: "1px solid #eee",
                color: "#2e7d32",
                fontWeight: "bold",
              }}
            >
              /site (5k), /shop/* (200+)
            </td>
          </tr>
          <tr>
            <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
              <code>/site/en/bench/*</code>
            </td>
            <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
              Nothing (matched before /api, /shop)
            </td>
          </tr>
          <tr style={{ background: "#fff8e1" }}>
            <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
              <code>/shop/product/*</code>
            </td>
            <td
              style={{
                padding: "0.5rem",
                borderBottom: "1px solid #eee",
                color: "#e65100",
                fontWeight: "bold",
              }}
            >
              /site (5k), /api (5k), /shop/category (102)
            </td>
          </tr>
          <tr style={{ background: "#fff8e1" }}>
            <td style={{ padding: "0.5rem", borderBottom: "1px solid #eee" }}>
              <code>/shop/category/*</code>
            </td>
            <td
              style={{
                padding: "0.5rem",
                borderBottom: "1px solid #eee",
                color: "#e65100",
                fontWeight: "bold",
              }}
            >
              /site (5k), /api (5k), /shop/product (102)
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
