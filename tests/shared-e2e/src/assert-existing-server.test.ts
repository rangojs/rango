import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  assertExistingServerIsOurs,
  classifyExistingServer,
  formatForeignServerError,
} from "./assert-existing-server.js";

const LISTEN_SCRIPT = `
const http = require("node:http");
const body = process.env.RANGO_E2E_PROBE_BODY || "";
const server = http.createServer((_req, res) => {
  res.writeHead(200);
  res.end(body);
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(String(server.address().port));
});
`;

async function startMarkerServer(body: string): Promise<{
  port: number;
  stop: () => Promise<void>;
}> {
  const env = { ...process.env, RANGO_E2E_PROBE_BODY: body };
  delete env.NODE_OPTIONS;
  const child: ChildProcess = spawn(process.execPath, ["-e", LISTEN_SCRIPT], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("marker server did not print a port"));
    }, 3000);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      reject(new Error(`marker server exited ${code}`));
    };
    child.stdout?.once("data", (chunk) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(Number(String(chunk).trim()));
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      reject(err);
    });
    child.once("exit", onExit);
  });
  return {
    port,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
    },
  };
}

describe("classifyExistingServer", () => {
  it("is free when nothing answers", () => {
    expect(
      classifyExistingServer({
        reachable: false,
        body: "",
        marker: 'data-testid="home-page"',
      }),
    ).toBe("free");
  });

  it("is ours when the body contains the marker", () => {
    expect(
      classifyExistingServer({
        reachable: true,
        body: '<main data-testid="home-page">Welcome</main>',
        marker: 'data-testid="home-page"',
      }),
    ).toBe("ours");
  });

  it("is foreign when the port answers without the marker", () => {
    expect(
      classifyExistingServer({
        reachable: true,
        body: "<html>some other vite app</html>",
        marker: 'data-testid="home-page"',
      }),
    ).toBe("foreign");
  });
});

describe("formatForeignServerError", () => {
  it("names the app, port, marker, listener, and the offset escape hatch", () => {
    const message = formatForeignServerError(
      {
        port: 5199,
        marker: 'data-testid="home-page"',
        label: "cloudflare-basic dev",
      },
      "COMMAND  PID\nnode     12345",
    );
    expect(message).toContain("cloudflare-basic dev");
    expect(message).toContain("http://127.0.0.1:5199/");
    expect(message).toContain('data-testid="home-page"');
    expect(message).toContain("issue #863");
    expect(message).toContain("node     12345");
    expect(message).toContain("RANGO_E2E_PORT_OFFSET");
  });
});

describe("assertExistingServerIsOurs", () => {
  it("no-ops when the port is free", () => {
    expect(() =>
      assertExistingServerIsOurs({
        port: 59999,
        marker: "unused",
        label: "free-port",
      }),
    ).not.toThrow();
  });

  // The leftover e2e webServer is a separate process. spawnSync GET against an
  // in-process listen() deadlocks (the event loop is blocked until the child
  // exits, so the server never accepts). Drive these through a child server.
  it("accepts a listener whose body contains the marker", async () => {
    const server = await startMarkerServer(
      '<main data-testid="home-page">ours</main>',
    );
    try {
      expect(() =>
        assertExistingServerIsOurs({
          port: server.port,
          marker: 'data-testid="home-page"',
          label: "cf-basic",
        }),
      ).not.toThrow();
    } finally {
      await server.stop();
    }
  });

  it("throws with the listener when the body is not ours, including under CI", async () => {
    const prevCi = process.env.CI;
    process.env.CI = "1";
    const server = await startMarkerServer("<html>foreign vite app</html>");
    try {
      expect(() =>
        assertExistingServerIsOurs({
          port: server.port,
          marker: 'data-testid="home-page"',
          label: "cloudflare-basic dev",
        }),
      ).toThrow(/issue #863/);
    } finally {
      if (prevCi === undefined) delete process.env.CI;
      else process.env.CI = prevCi;
      await server.stop();
    }
  });
});
