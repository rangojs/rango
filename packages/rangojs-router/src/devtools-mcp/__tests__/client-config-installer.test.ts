import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import packageJson from "../../../package.json";
import {
  installRangoMcpClientConfig,
  type RangoMcpClient,
} from "../client-config-installer.js";

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "rango-mcp-install-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("Rango MCP client config installer", () => {
  it.each<{
    client: RangoMcpClient;
    file: string;
    parent: string;
    type?: string;
  }>([
    { client: "claude-code", file: ".mcp.json", parent: "mcpServers" },
    { client: "cursor", file: ".cursor/mcp.json", parent: "mcpServers" },
    {
      client: "vscode",
      file: ".vscode/mcp.json",
      parent: "servers",
      type: "stdio",
    },
    { client: "gemini", file: ".gemini/settings.json", parent: "mcpServers" },
  ])("creates a project-local $client configuration", async (target) => {
    const root = await workspace();
    const result = await installRangoMcpClientConfig({
      workspaceRoot: root,
      projectRoot: root,
      client: target.client,
    });

    expect(result).toMatchObject({ action: "created", dryRun: false });
    const config = JSON.parse(await readFile(join(root, target.file), "utf8"));
    expect(config[target.parent]["rango-devtools"]).toEqual({
      ...(target.type ? { type: target.type } : {}),
      command: "npx",
      args: ["-y", `@rangojs/router@${packageJson.version}`, "mcp"],
    });
    expect(JSON.stringify(config)).not.toMatch(
      /__rango\/mcp|authorization|bearer|token/iu,
    );
  });

  it("updates only the managed command while preserving JSONC and custom fields", async () => {
    const root = await workspace();
    await mkdir(join(root, "apps", "store"), { recursive: true });
    const configPath = join(root, ".mcp.json");
    await writeFile(
      configPath,
      `{
  // This server belongs to the consumer.
  "mcpServers": {
    "other": { "command": "secret-helper" },
    "rango-devtools": {
      "command": "npx",
      "args": ["-y", "@rangojs/router@experimental", "mcp"],
      "disabledTools": ["get_errors"]
    }
  }
}\n`,
    );

    const result = await installRangoMcpClientConfig({
      workspaceRoot: root,
      projectRoot: "apps/store",
      client: "claude-code",
    });
    const updated = await readFile(configPath, "utf8");

    expect(result.action).toBe("updated");
    expect(updated).toContain("This server belongs to the consumer.");
    expect(updated).toContain('"other": { "command": "secret-helper" }');
    expect(updated).toContain('"disabledTools": ["get_errors"]');
    expect(updated).toContain('"--root"');
    expect(updated).toContain('"apps/store"');
  });

  it("preserves restrictive permissions when replacing a config", async () => {
    const root = await workspace();
    const configPath = join(root, ".mcp.json");
    await writeFile(
      configPath,
      '{"mcpServers":{"rango-devtools":{"command":"npx","args":["-y","@rangojs/router@experimental","mcp"]}}}\n',
    );
    await chmod(configPath, 0o600);

    await installRangoMcpClientConfig({
      workspaceRoot: root,
      projectRoot: root,
      client: "claude-code",
    });

    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("repairs required VS Code fields on a managed entry", async () => {
    const root = await workspace();
    const configPath = join(root, ".vscode", "mcp.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      '{"servers":{"rango-devtools":{"type":"http","command":"npx","args":["-y","@rangojs/router@0.4.1","mcp"]}}}\n',
    );

    const result = await installRangoMcpClientConfig({
      workspaceRoot: root,
      projectRoot: root,
      client: "vscode",
    });
    const config = JSON.parse(await readFile(configPath, "utf8"));

    expect(result.action).toBe("updated");
    expect(config.servers["rango-devtools"].type).toBe("stdio");
  });

  it("does not let concurrent installers overwrite each other", async () => {
    const root = await workspace();
    const results = await Promise.allSettled([
      installRangoMcpClientConfig({
        workspaceRoot: root,
        projectRoot: root,
        client: "claude-code",
      }),
      installRangoMcpClientConfig({
        workspaceRoot: root,
        projectRoot: root,
        client: "claude-code",
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(root, ".mcp.json"), "utf8")),
    ).toMatchObject({
      mcpServers: { "rango-devtools": { command: "npx" } },
    });
  });

  it("recovers a lock owned by a process that no longer exists", async () => {
    const root = await workspace();
    const lockPath = join(root, ".mcp.json.rango-install.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 2_147_483_647,
        token: "00000000-0000-4000-8000-000000000001",
        createdAt: 0,
      }),
    );

    await expect(
      installRangoMcpClientConfig({
        workspaceRoot: root,
        projectRoot: root,
        client: "claude-code",
      }),
    ).resolves.toMatchObject({ action: "created" });
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("allows only one installer to reclaim an abandoned lock", async () => {
    const root = await workspace();
    const lockPath = join(root, ".mcp.json.rango-install.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 2_147_483_647,
        token: "00000000-0000-4000-8000-000000000001",
        createdAt: 0,
      }),
    );

    const results = await Promise.allSettled([
      installRangoMcpClientConfig({
        workspaceRoot: root,
        projectRoot: root,
        client: "claude-code",
      }),
      installRangoMcpClientConfig({
        workspaceRoot: root,
        projectRoot: root,
        client: "claude-code",
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers a reclaim claim owned by a process that no longer exists", async () => {
    const root = await workspace();
    const lockPath = join(root, ".mcp.json.rango-install.lock");
    const reclaimPath = `${lockPath}.reclaim.00000000-0000-4000-8000-000000000001`;
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 2_147_483_647,
        token: "00000000-0000-4000-8000-000000000001",
        createdAt: 0,
      }),
    );
    await writeFile(
      reclaimPath,
      JSON.stringify({
        pid: 2_147_483_647,
        token: "00000000-0000-4000-8000-000000000002",
        createdAt: 0,
      }),
    );

    await expect(
      installRangoMcpClientConfig({
        workspaceRoot: root,
        projectRoot: root,
        client: "claude-code",
      }),
    ).resolves.toMatchObject({ action: "created" });
    await expect(readFile(reclaimPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    [
      "live",
      () =>
        JSON.stringify({
          pid: process.pid,
          token: "00000000-0000-4000-8000-000000000003",
          createdAt: Date.now(),
        }),
    ],
    ["malformed", () => "not-json"],
  ])("does not reclaim a %s installer lock", async (_label, contents) => {
    const root = await workspace();
    const lockPath = join(root, ".mcp.json.rango-install.lock");
    const content = contents();
    await writeFile(lockPath, content);

    await expect(
      installRangoMcpClientConfig({
        workspaceRoot: root,
        projectRoot: root,
        client: "claude-code",
      }),
    ).rejects.toThrow(lockPath);
    expect(await readFile(lockPath, "utf8")).toBe(content);
  });

  it("rejects persisted lock tokens that are unsafe as path components", async () => {
    const root = await workspace();
    const lockPath = join(root, ".mcp.json.rango-install.lock");
    const content = JSON.stringify({
      pid: 2_147_483_647,
      token: "../outside",
      createdAt: 0,
    });
    await writeFile(lockPath, content);

    await expect(
      installRangoMcpClientConfig({
        workspaceRoot: root,
        projectRoot: root,
        client: "claude-code",
      }),
    ).rejects.toThrow(lockPath);
    expect(await readFile(lockPath, "utf8")).toBe(content);
  });

  it("is idempotent and refuses unmanaged collisions", async () => {
    const root = await workspace();
    const first = await installRangoMcpClientConfig({
      workspaceRoot: root,
      projectRoot: root,
      client: "claude-code",
    });
    const original = await readFile(first.configPath, "utf8");
    expect(
      await installRangoMcpClientConfig({
        workspaceRoot: root,
        projectRoot: root,
        client: "claude-code",
      }),
    ).toMatchObject({ action: "unchanged" });
    expect(await readFile(first.configPath, "utf8")).toBe(original);

    await writeFile(
      first.configPath,
      '{"mcpServers":{"rango-devtools":{"command":"custom"}}}\n',
    );
    await expect(
      installRangoMcpClientConfig({
        workspaceRoot: root,
        projectRoot: root,
        client: "claude-code",
      }),
    ).rejects.toThrow("unmanaged rango-devtools");
  });

  it("keeps dry runs write-free and rejects symlink targets", async () => {
    const root = await workspace();
    const dryRun = await installRangoMcpClientConfig({
      workspaceRoot: root,
      projectRoot: root,
      client: "cursor",
      dryRun: true,
    });
    expect(dryRun).toMatchObject({ action: "created", dryRun: true });
    await expect(readFile(dryRun.configPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const external = await workspace();
    const configPath = join(root, ".mcp.json");
    await writeFile(join(external, "config.json"), "{}\n");
    await symlink(join(external, "config.json"), configPath);
    await expect(
      installRangoMcpClientConfig({
        workspaceRoot: root,
        projectRoot: root,
        client: "claude-code",
      }),
    ).rejects.toThrow("through symlink");
    expect(dirname(configPath)).toBe(root);
  });
});
