import { Meta } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router";

async function DataTable() {
  const renderTime = new Date().toISOString();
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const data = Array.from({ length: 50 }, (_, i) => ({
    id: `item-${i + 1}`,
    name: `Item ${i + 1}`,
    value: (i * 17 + 42) % 1000,
    status: ["Active", "Pending", "Completed"][i % 3],
  }));

  return (
    <div data-testid="slow-data-table">
      <p data-testid="render-time" style={{ color: "#666", marginBottom: "1rem" }}>
        Rendered at: {renderTime}
      </p>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        This component has a 2s delay. Cached requests show the same render time.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "#f5f5f5" }}>
            <th style={{ padding: "0.5rem", textAlign: "left", border: "1px solid #ddd" }}>ID</th>
            <th style={{ padding: "0.5rem", textAlign: "left", border: "1px solid #ddd" }}>Name</th>
            <th style={{ padding: "0.5rem", textAlign: "left", border: "1px solid #ddd" }}>Value</th>
            <th style={{ padding: "0.5rem", textAlign: "left", border: "1px solid #ddd" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.id}>
              <td style={{ padding: "0.5rem", border: "1px solid #ddd" }}>{row.id}</td>
              <td style={{ padding: "0.5rem", border: "1px solid #ddd" }}>{row.name}</td>
              <td style={{ padding: "0.5rem", border: "1px solid #ddd" }}>{row.value}</td>
              <td style={{ padding: "0.5rem", border: "1px solid #ddd" }}>{row.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SlowCachePage(ctx: HandlerContext) {
  const meta = ctx.use(Meta);
  meta({ title: "Slow Cache Test - RSC Router" });

  return (
    <main data-testid="slow-cache-page">
      <h1>Cache Test</h1>
      <p style={{ marginBottom: "1rem" }}>This page tests edge caching behavior.</p>
      <DataTable />
    </main>
  );
}
