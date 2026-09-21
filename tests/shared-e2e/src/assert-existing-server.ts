import { spawnSync } from "node:child_process";
import process from "node:process";

/**
 * Playwright `reuseExistingServer` + `webServer.port` only checks that the TCP
 * port is open (`checkPortOnly`). A foreign Vite server on this checkout's
 * port is reused silently and the suite runs against the wrong app (issue
 * #863). Call this before enabling reuse: if the port is taken, GET the URL
 * and require `marker` in the body; otherwise throw with `lsof` so the
 * listener is named.
 */

export type ExistingServerKind = "free" | "ours" | "foreign";

export type ExistingServerIdentity = {
  port: number;
  /** Unique substring that must appear in the GET response body. */
  marker: string;
  /** Shown in the error (e.g. "cloudflare-basic dev"). */
  label: string;
  path?: string;
  headers?: Record<string, string>;
};

export function classifyExistingServer(input: {
  reachable: boolean;
  body: string;
  marker: string;
}): ExistingServerKind {
  if (!input.reachable) return "free";
  return input.body.includes(input.marker) ? "ours" : "foreign";
}

const PROBE_SCRIPT = `
const http = require("node:http");
const headers = JSON.parse(process.env.RANGO_E2E_PROBE_HEADERS || "{}");
const req = http.get(process.env.RANGO_E2E_PROBE_URL, { headers, timeout: 8000 }, (res) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => {
    process.stdout.write(Buffer.concat(chunks));
    process.exit(0);
  });
});
req.on("error", (err) => {
  if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") process.exit(2);
  process.exit(1);
});
req.on("timeout", () => { req.destroy(); process.exit(3); });
`;

function probeHttp(
  url: string,
  headers: Record<string, string> | undefined,
): { reachable: boolean; body: string } {
  // Drop NODE_OPTIONS so a vitest/playwright-launched Node doesn't inject
  // loaders into the probe child (that hangs the GET until timeout).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RANGO_E2E_PROBE_URL: url,
    RANGO_E2E_PROBE_HEADERS: JSON.stringify(headers ?? {}),
  };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, ["-e", PROBE_SCRIPT], {
    encoding: "utf8",
    timeout: 10_000,
    env,
  });
  if (result.status === 2) return { reachable: false, body: "" };
  return { reachable: true, body: result.stdout ?? "" };
}

function describeListener(port: number): string {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
    timeout: 3000,
  });
  const text = (result.stdout || result.stderr || "").trim();
  return text || `(lsof did not report a listener on ${port})`;
}

export function formatForeignServerError(
  identity: ExistingServerIdentity,
  listener: string,
): string {
  const url = `http://127.0.0.1:${identity.port}${identity.path ?? "/"}`;
  return [
    `e2e webServer "${identity.label}" would reuse ${url}, but the listener is not this app (missing ${identity.marker}).`,
    "Playwright only checks that the TCP port is open (issue #863).",
    "",
    "Listener:",
    listener,
    "",
    "Kill that process or set RANGO_E2E_PORT_OFFSET=<n>.",
  ].join("\n");
}

export function assertExistingServerIsOurs(
  identity: ExistingServerIdentity,
): void {
  const url = `http://127.0.0.1:${identity.port}${identity.path ?? "/"}`;
  const probe = probeHttp(url, identity.headers);
  const kind = classifyExistingServer({
    reachable: probe.reachable,
    body: probe.body,
    marker: identity.marker,
  });
  if (kind !== "foreign") return;
  throw new Error(
    formatForeignServerError(identity, describeListener(identity.port)),
  );
}
