import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRangoMcpRuntimeIdentity,
  listRangoMcpRuntimes,
  registerRangoMcpRuntime,
  selectRangoMcpRuntime,
  type RuntimeRegistration,
} from "../runtime-registry.js";

const tempDirectories: string[] = [];
const registrations: RuntimeRegistration[] = [];

afterEach(async () => {
  await Promise.all(registrations.splice(0).map((item) => item.dispose()));
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "rango-mcp-registry-test-"));
  tempDirectories.push(base);
  const registryDirectory = join(base, "registry");
  const projectRoot = join(base, "project");
  await mkdir(projectRoot);
  return { registryDirectory, projectRoot };
}

describe("Rango MCP runtime registry", () => {
  it("writes owner-only descriptors and selects from a project subdirectory", async () => {
    const { registryDirectory, projectRoot } = await setup();
    const identity = createRangoMcpRuntimeIdentity();
    const registration = await registerRangoMcpRuntime({
      identity,
      projectRoot,
      preset: "node",
      endpoint: "http://127.0.0.1:5173/__rango/mcp",
      registryDirectory,
    });
    registrations.push(registration);
    const nested = join(projectRoot, "src");
    await mkdir(nested);

    expect(
      await selectRangoMcpRuntime({
        projectRoot: nested,
        registryDirectory,
      }),
    ).toMatchObject({
      instanceId: identity.instanceId,
      projectRoot: await realpath(projectRoot),
    });

    if (process.platform !== "win32") {
      const [filename] = await readdir(registryDirectory);
      expect((await lstat(registryDirectory)).mode & 0o777).toBe(0o700);
      expect(
        (await lstat(join(registryDirectory, filename!))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("rejects ambiguous instances for the same project", async () => {
    const { registryDirectory, projectRoot } = await setup();
    for (let port = 5173; port <= 5174; port++) {
      const registration = await registerRangoMcpRuntime({
        identity: createRangoMcpRuntimeIdentity(),
        projectRoot,
        preset: "cloudflare",
        endpoint: `http://127.0.0.1:${port}/__rango/mcp`,
        registryDirectory,
      });
      registrations.push(registration);
    }

    expect(await listRangoMcpRuntimes(registryDirectory)).toHaveLength(2);
    await expect(
      selectRangoMcpRuntime({ projectRoot, registryDirectory }),
    ).rejects.toThrow("Multiple Rango development servers");
  });

  it("rejects endpoints outside the exact loopback MCP path", async () => {
    const { registryDirectory, projectRoot } = await setup();
    for (const endpoint of [
      "http://localhost:5173/__rango/mcp",
      "http://127.0.0.1:5173/not-mcp",
      "http://127.0.0.1:5173/__rango/mcp?forward=1",
      "https://example.com/__rango/mcp",
    ]) {
      await expect(
        registerRangoMcpRuntime({
          identity: createRangoMcpRuntimeIdentity(),
          projectRoot,
          preset: "node",
          endpoint,
          registryDirectory,
        }),
      ).rejects.toThrow("literal loopback address");
    }
  });

  it.skipIf(process.platform === "win32")(
    "ignores registries and descriptors readable through unsafe permissions or symlinks",
    async () => {
      const { registryDirectory, projectRoot } = await setup();
      const registration = await registerRangoMcpRuntime({
        identity: createRangoMcpRuntimeIdentity(),
        projectRoot,
        preset: "node",
        endpoint: "http://127.0.0.1:5173/__rango/mcp",
        registryDirectory,
      });
      registrations.push(registration);
      const [filename] = await readdir(registryDirectory);

      await chmod(join(registryDirectory, filename!), 0o644);
      expect(await listRangoMcpRuntimes(registryDirectory)).toEqual([]);

      await chmod(join(registryDirectory, filename!), 0o600);
      await chmod(registryDirectory, 0o755);
      expect(await listRangoMcpRuntimes(registryDirectory)).toEqual([]);

      await chmod(registryDirectory, 0o700);
      const descriptorPath = join(registryDirectory, filename!);
      const descriptorTarget = join(
        registryDirectory,
        "..",
        "descriptor-target.json",
      );
      await rename(descriptorPath, descriptorTarget);
      await symlink(descriptorTarget, descriptorPath, "file");
      expect(await listRangoMcpRuntimes(registryDirectory)).toEqual([]);

      const symlinkDirectory = join(
        registryDirectory,
        "..",
        "registry-symlink",
      );
      await symlink(registryDirectory, symlinkDirectory, "dir");
      expect(await listRangoMcpRuntimes(symlinkDirectory)).toEqual([]);
      await expect(
        registerRangoMcpRuntime({
          identity: createRangoMcpRuntimeIdentity(),
          projectRoot,
          preset: "node",
          endpoint: "http://127.0.0.1:5173/__rango/mcp",
          registryDirectory: symlinkDirectory,
        }),
      ).rejects.toThrow("not a symlink");
    },
  );
});
