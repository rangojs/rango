import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackageExports {
  [key: string]:
    | string
    | {
        default?: string;
        import?: string;
        "react-server"?: string;
        types?: string;
      };
}

interface ImportRecord {
  clause: string;
  file: string;
  names: string[];
  specifier: string;
}

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, "../..");
const docsRoot = resolve(packageRoot, "skills");
const packageJson = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
) as { exports: PackageExports };

const markdownFiles = [
  resolve(packageRoot, "README.md"),
  ...walkMarkdownFiles(docsRoot),
];

const canonicalImportPaths: Record<string, string> = {
  CFCacheStore: "@rangojs/router/cache",
  MemorySegmentCacheStore: "@rangojs/router/cache",
  Outlet: "@rangojs/router/client",
  ParallelOutlet: "@rangojs/router/client",
  createRSCHandler: "@rangojs/router/rsc",
  createSSRHandler: "@rangojs/router/ssr",
  invalidateClientCache: "@rangojs/router",
  keepClientCache: "@rangojs/router",
  useAction: "@rangojs/router/client",
  useFetchLoader: "@rangojs/router/client",
  useHandle: "@rangojs/router/client",
  useLoader: "@rangojs/router/client",
  useLocationState: "@rangojs/router/client",
  useOutlet: "@rangojs/router/client",
  useSegments: "@rangojs/router/client",
  useTheme: "@rangojs/router/theme",
};

describe("documentation imports", () => {
  it("use only exported subpaths and canonical public entrypoints", async () => {
    const failures: string[] = [];

    for (const file of markdownFiles) {
      const content = readFileSync(file, "utf8");
      const imports = extractImportRecords(file, content);

      for (const record of imports) {
        const exportKey = toExportKey(record.specifier);
        const exportTarget = packageJson.exports[exportKey];

        if (!exportTarget) {
          failures.push(
            `${relativeToPackage(record.file)} imports non-exported subpath ${record.specifier}`,
          );
          continue;
        }

        if (record.names.length === 0) {
          continue;
        }

        for (const name of record.names) {
          if (name === "include") {
            failures.push(
              `${relativeToPackage(record.file)} imports include from ${record.specifier}, but include() should be used from the urls() callback helpers instead of imported directly`,
            );
            continue;
          }

          const expectedSpecifier = canonicalImportPaths[name];
          if (expectedSpecifier && record.specifier !== expectedSpecifier) {
            failures.push(
              `${relativeToPackage(record.file)} imports ${name} from ${record.specifier}, but the canonical public import is ${expectedSpecifier}`,
            );
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });
});

function walkMarkdownFiles(dir: string): string[] {
  const results: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && extname(entry.name) === ".md") {
      results.push(fullPath);
    }
  }

  return results;
}

function extractImportRecords(file: string, content: string): ImportRecord[] {
  const records: ImportRecord[] = [];
  const statementRegex = /^\s*import[\s\S]*?;$/gm;

  for (const match of content.matchAll(statementRegex)) {
    const statement = match[0]?.trim();
    if (!statement) continue;

    const specifierMatch = statement.match(
      /from\s+["'](@rangojs\/router(?:\/[^"'`\s)]+)?)["']/,
    );
    if (!specifierMatch?.[1]) continue;

    const clauseMatch = statement.match(/^import\s+([\s\S]*?)\s+from\s+["']/);
    const clause = clauseMatch?.[1]?.trim();
    const specifier = specifierMatch[1].trim();
    if (!clause) continue;

    records.push({
      clause,
      file,
      specifier,
      names: extractRuntimeNamedImports(clause),
    });
  }

  return records;
}

function extractRuntimeNamedImports(clause: string): string[] {
  const namedMatch = clause.match(/\{([\s\S]*?)\}/);
  if (!namedMatch) {
    return [];
  }

  return namedMatch[1]
    .split(",")
    .map((part) => part.replace(/\/\/.*$/g, "").trim())
    .filter(Boolean)
    .filter((part) => !part.startsWith("type "))
    .map((part) => part.split(/\s+as\s+/)[0]?.trim() ?? "")
    .filter(Boolean);
}

function toExportKey(specifier: string): string {
  return specifier === "@rangojs/router"
    ? "."
    : `.${specifier.slice("@rangojs/router".length)}`;
}

function relativeToPackage(file: string): string {
  return file.replace(`${packageRoot}/`, "");
}
