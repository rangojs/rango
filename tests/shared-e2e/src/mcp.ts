import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";

const RANGO_CLI_PATH = fileURLToPath(
  new URL(
    "../../../packages/rangojs-router/dist/bin/rango.js",
    import.meta.url,
  ),
);

export interface RangoMcpTestSession {
  client: Client;
  close(): Promise<void>;
}

const descriptorSchema = z.object({
  instanceId: z.string().uuid(),
  projectRoot: z.string(),
  endpoint: z.string().url(),
  pid: z.number().int().positive(),
});

async function resolveInstanceId(
  projectRoot: string,
  serverUrl: string,
): Promise<string> {
  const canonicalRoot = await realpath(projectRoot);
  const expectedPort = new URL(serverUrl).port;
  const directory = join(homedir(), ".rango", "mcp");
  const deadline = Date.now() + 10_000;
  do {
    const entries = await readdir(directory).catch(() => []);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const descriptor = descriptorSchema.parse(
          JSON.parse(await readFile(join(directory, entry), "utf8")),
        );
        const endpoint = new URL(descriptor.endpoint);
        if (
          descriptor.projectRoot === canonicalRoot &&
          endpoint.port === expectedPort
        ) {
          process.kill(descriptor.pid, 0);
          return descriptor.instanceId;
        }
      } catch {}
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(
    `No Rango MCP descriptor found for ${canonicalRoot} on port ${expectedPort}`,
  );
}

export async function connectRangoMcp(
  projectRoot: string,
  serverUrl: string,
): Promise<RangoMcpTestSession> {
  const instanceId = await resolveInstanceId(projectRoot, serverUrl);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      RANGO_CLI_PATH,
      "mcp",
      "--root",
      projectRoot,
      "--instance",
      instanceId,
    ],
    cwd: projectRoot,
    env: {
      ...process.env,
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "",
      NODE_USE_ENV_PROXY: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "Rango e2e", version: "1.0.0" });
  await client.connect(transport);
  return {
    client,
    async close(): Promise<void> {
      await client.close();
    },
  };
}
