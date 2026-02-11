import { createPrerenderHandler } from "@rangojs/router";

interface Release {
  version: string;
  date: string;
  highlights: string[];
}

// Pre-render handler that reads releases data at build time via node:fs.
// After build, this handler code is evicted from the production bundle.
// All node:fs/path/url imports are dynamic (inside the handler body) so they
// get evicted too — top-level imports would survive eviction and crash workerd
// because import.meta.url is not a file:// URL in the bundled output.
export const ReleasesPage = createPrerenderHandler(async (ctx) => {
  const { readFileSync } = await import("node:fs");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = dirname(fileURLToPath(import.meta.url));

  const raw = readFileSync(
    resolve(__dirname, "../../content/releases.json"),
    "utf-8",
  );
  const entries: Release[] = JSON.parse(raw);
  return (
    <div data-testid="releases-page">
      <h1>Releases</h1>
      <p>Pre-rendered from content/releases.json at build time.</p>
      {entries.map((r) => (
        <div key={r.version} data-testid={`release-${r.version}`}>
          <h2>{r.version}</h2>
          <p>{r.date}</p>
          <ul>
            {r.highlights.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
});
