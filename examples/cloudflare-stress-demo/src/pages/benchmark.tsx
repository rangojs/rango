/**
 * Benchmark locations to test route matching at different positions
 */
const benchmarkLocations = [
  { key: "flat_first", path: "/flat/1", desc: "First flat route" },
  { key: "flat_middle", path: "/flat/250", desc: "Middle flat route" },
  { key: "flat_last", path: "/flat/500", desc: "Last flat route" },
  { key: "l1_first", path: "/l1/1", desc: "First route in level 1" },
  { key: "l1_last", path: "/l1/100", desc: "Last route in level 1" },
  { key: "l5_first", path: "/l5/1", desc: "First route in level 5 (deepest)" },
  { key: "l5_last", path: "/l5/100", desc: "Last route in level 5 (deepest)" },
  { key: "inc_first", path: "/included/inc/1", desc: "First included route" },
  { key: "inc_last", path: "/included/inc/500", desc: "Last included route" },
];

export function HomePage() {
  return (
    <div>
      <h1>Cloudflare Route Stress Test</h1>
      <p style={{ color: "#666", marginBottom: "2rem" }}>
        1500+ routes for benchmarking manifest generation and route matching performance.
      </p>

      <h2>Route Structure</h2>
      <ul style={{ marginBottom: "2rem" }}>
        <li><strong>500 flat routes</strong> at root level (/flat/1 - /flat/500)</li>
        <li><strong>500 nested routes</strong> across 5 layout levels (/l1/* - /l5/*)</li>
        <li><strong>500 included routes</strong> via include() (/included/inc/*)</li>
      </ul>

      <h2>Benchmark Endpoints</h2>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Test route matching at different positions in the route tree:
      </p>

      <div style={{ display: "grid", gap: "0.5rem" }}>
        {benchmarkLocations.map(({ key, path, desc }) => (
          <a
            key={key}
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
            <span style={{ color: "#666", marginLeft: "1rem" }}>({desc})</span>
          </a>
        ))}
      </div>

      <h2>How to Benchmark</h2>
      <ol>
        <li>Open browser DevTools → Network tab</li>
        <li>Click on different benchmark endpoints above</li>
        <li>Check "Time" column for response times</li>
        <li>Compare first request (cold) vs subsequent (warm)</li>
        <li>Use "Disable cache" to measure uncached performance</li>
      </ol>
    </div>
  );
}
