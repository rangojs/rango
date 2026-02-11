import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrerenderHandler } from "@rangojs/router";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ChangelogEntry {
  version: string;
  date: string;
  summary: string;
}

// Static page that reads a JSON file at build time via node:fs.
// After build, the handler code (+ node:fs dependency) is evicted from the bundle.
export const ChangelogPage = createPrerenderHandler(async (ctx) => {
  const raw = readFileSync(
    resolve(__dirname, "../../content/changelog.json"),
    "utf-8",
  );
  const entries: ChangelogEntry[] = JSON.parse(raw);
  return (
    <div data-testid="changelog-page">
      <h1>Changelog</h1>
      {entries.map((e) => (
        <div key={e.version} data-testid={`changelog-${e.version}`}>
          <strong>{e.version}</strong> ({e.date}): {e.summary}
        </div>
      ))}
    </div>
  );
});
