import { randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  applyEdits,
  modify,
  parse,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";
import packageJson from "../../package.json";

export type RangoMcpClient = "claude-code" | "cursor" | "vscode" | "gemini";

export interface InstallRangoMcpClientOptions {
  workspaceRoot: string;
  projectRoot: string;
  client: RangoMcpClient;
  dryRun?: boolean;
}

export interface InstallRangoMcpClientResult {
  client: RangoMcpClient;
  configPath: string;
  action: "created" | "updated" | "unchanged";
  dryRun: boolean;
}

interface ClientTarget {
  path: string[];
  parentKey: "mcpServers" | "servers";
  entryDefaults?: Record<string, unknown>;
}

interface InstallerLockOwner {
  pid: number;
  token: string;
}

type InstallerLock = InstallerLockOwner;

const CLIENT_TARGETS: Readonly<Record<RangoMcpClient, ClientTarget>> = {
  "claude-code": { path: [".mcp.json"], parentKey: "mcpServers" },
  cursor: { path: [".cursor", "mcp.json"], parentKey: "mcpServers" },
  vscode: {
    path: [".vscode", "mcp.json"],
    parentKey: "servers",
    entryDefaults: { type: "stdio" },
  },
  gemini: {
    path: [".gemini", "settings.json"],
    parentKey: "mcpServers",
  },
};

const FORMATTING_OPTIONS: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
};

const INSTALLER_LOCK_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!isAbsolute(path) && !path.startsWith(`..${sep}`) && path !== "..")
  );
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readInstallerLockOwner(
  lockPath: string,
): Promise<InstallerLockOwner | null> {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid?: unknown;
      token?: unknown;
    };
    if (
      Number.isSafeInteger(owner.pid) &&
      (owner.pid as number) > 0 &&
      typeof owner.token === "string" &&
      INSTALLER_LOCK_TOKEN_PATTERN.test(owner.token)
    ) {
      return { pid: owner.pid as number, token: owner.token };
    }
  } catch {}
  return null;
}

async function createInstallerOwnerFile(
  path: string,
): Promise<InstallerLockOwner> {
  const token = randomUUID();
  const ownerPath = `${path}.owner.${token}`;
  let file;
  try {
    file = await open(ownerPath, "wx", 0o600);
    await file.writeFile(
      `${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`,
      "utf8",
    );
    await file.close();
    file = undefined;
    await link(ownerPath, path);
    return { pid: process.pid, token };
  } catch (error) {
    await file?.close().catch(() => {});
    throw error;
  } finally {
    await unlink(ownerPath).catch(() => {});
  }
}

async function createInstallerLock(lockPath: string): Promise<InstallerLock> {
  return createInstallerOwnerFile(lockPath);
}

async function acquireInstallerReclaim(
  reclaimPath: string,
): Promise<InstallerLockOwner> {
  try {
    return await createInstallerOwnerFile(reclaimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const observedOwner = await readInstallerLockOwner(reclaimPath);
  if (!observedOwner || processIsRunning(observedOwner.pid)) {
    throw new Error(
      `Another Rango MCP client config update holds ${reclaimPath}`,
    );
  }

  const stalePath = `${reclaimPath}.stale.${randomUUID()}`;
  try {
    const currentOwner = await readInstallerLockOwner(reclaimPath);
    if (
      !currentOwner ||
      currentOwner.token !== observedOwner.token ||
      processIsRunning(currentOwner.pid)
    ) {
      throw new Error(
        `Another Rango MCP client config update holds ${reclaimPath}`,
      );
    }
    await rename(reclaimPath, stalePath);
    return await createInstallerOwnerFile(reclaimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Another Rango MCP client config update holds ${reclaimPath}`,
      );
    }
    throw error;
  } finally {
    await unlink(stalePath).catch(() => {});
  }
}

async function releaseInstallerOwnerFile(
  path: string,
  owner: InstallerLockOwner,
): Promise<void> {
  const currentOwner = await readInstallerLockOwner(path);
  if (currentOwner?.token !== owner.token) return;
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function acquireInstallerLock(lockPath: string): Promise<InstallerLock> {
  try {
    return await createInstallerLock(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const observedOwner = await readInstallerLockOwner(lockPath);
  if (!observedOwner || processIsRunning(observedOwner.pid)) {
    throw new Error(`Another Rango MCP client config update holds ${lockPath}`);
  }

  // Serialize contenders that observed the same abandoned owner. Without this
  // claim, a delayed contender can rename the winner's live replacement.
  const reclaimPath = `${lockPath}.reclaim.${observedOwner.token}`;
  const reclaim = await acquireInstallerReclaim(reclaimPath);

  const stalePath = `${lockPath}.stale.${randomUUID()}`;
  try {
    const currentOwner = await readInstallerLockOwner(lockPath);
    if (
      !currentOwner ||
      currentOwner.token !== observedOwner.token ||
      processIsRunning(currentOwner.pid)
    ) {
      throw new Error(
        `Another Rango MCP client config update holds ${lockPath}`,
      );
    }
    await rename(lockPath, stalePath);
    return await createInstallerLock(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Another Rango MCP client config update holds ${lockPath}`,
      );
    }
    throw error;
  } finally {
    await unlink(stalePath).catch(() => {});
    await releaseInstallerOwnerFile(reclaimPath, reclaim);
  }
}

async function releaseInstallerLock(
  lockPath: string,
  lock: InstallerLock,
): Promise<void> {
  await releaseInstallerOwnerFile(lockPath, lock);
}

async function assertNoSymlink(
  workspaceRoot: string,
  targetPath: string,
): Promise<void> {
  const path = relative(workspaceRoot, targetPath);
  let current = workspaceRoot;
  for (const part of path.split(sep)) {
    if (!part) continue;
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(
          `Refusing to write MCP client configuration through symlink ${current}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isManagedRangoEntry(value: unknown): boolean {
  if (
    !isObject(value) ||
    value.command !== "npx" ||
    !Array.isArray(value.args)
  ) {
    return false;
  }
  return (
    value.args[0] === "-y" &&
    typeof value.args[1] === "string" &&
    /^@rangojs\/router@[^\s]+$/u.test(value.args[1]) &&
    value.args[2] === "mcp"
  );
}

function sameStringArray(value: unknown, expected: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

export async function installRangoMcpClientConfig(
  options: InstallRangoMcpClientOptions,
): Promise<InstallRangoMcpClientResult> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const projectRoot = resolve(workspaceRoot, options.projectRoot);
  const [canonicalWorkspaceRoot, canonicalProjectRoot] = await Promise.all([
    realpath(workspaceRoot),
    realpath(projectRoot),
  ]);
  if (!isInside(canonicalWorkspaceRoot, canonicalProjectRoot)) {
    throw new Error("Rango MCP project root must be inside the workspace root");
  }

  const target = CLIENT_TARGETS[options.client];
  const configPath = join(workspaceRoot, ...target.path);
  await assertNoSymlink(workspaceRoot, configPath);

  const projectRelativePath = relative(workspaceRoot, projectRoot)
    .split(sep)
    .join("/");
  const args = ["-y", `@rangojs/router@${packageJson.version}`, "mcp"];
  if (projectRelativePath) args.push("--root", projectRelativePath);
  const desiredEntry = {
    ...target.entryDefaults,
    command: "npx",
    args,
  };

  let source: string;
  let exists = true;
  let existingMode: number | undefined;
  try {
    source = await readFile(configPath, "utf8");
    existingMode = (await lstat(configPath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    source = "{}\n";
    exists = false;
  }

  const parseErrors: ParseError[] = [];
  const parsed = parse(source, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (parseErrors.length > 0 || !isObject(parsed)) {
    throw new Error(`Invalid JSON object in MCP client config ${configPath}`);
  }
  const parent = parsed[target.parentKey];
  if (parent !== undefined && !isObject(parent)) {
    throw new Error(
      `Expected ${target.parentKey} to be an object in ${configPath}`,
    );
  }
  const existingEntry = isObject(parent) ? parent["rango-devtools"] : undefined;
  if (existingEntry !== undefined && !isManagedRangoEntry(existingEntry)) {
    throw new Error(
      `Refusing to replace unmanaged rango-devtools entry in ${configPath}`,
    );
  }
  if (
    isObject(existingEntry) &&
    Object.entries(desiredEntry).every(([key, value]) =>
      key === "args"
        ? sameStringArray(existingEntry[key], args)
        : existingEntry[key] === value,
    )
  ) {
    return {
      client: options.client,
      configPath,
      action: "unchanged",
      dryRun: options.dryRun === true,
    };
  }

  const entryPath = [target.parentKey, "rango-devtools"];
  let updated = source;
  if (existingEntry === undefined) {
    updated = applyEdits(
      updated,
      modify(updated, entryPath, desiredEntry, {
        formattingOptions: FORMATTING_OPTIONS,
      }),
    );
  } else {
    for (const [key, value] of Object.entries(desiredEntry)) {
      updated = applyEdits(
        updated,
        modify(updated, [...entryPath, key], value, {
          formattingOptions: FORMATTING_OPTIONS,
        }),
      );
    }
  }
  if (!updated.endsWith("\n")) updated += "\n";

  const action = exists ? "updated" : "created";
  if (!options.dryRun) {
    const directory = dirname(configPath);
    await mkdir(directory, { recursive: true });
    const lockPath = `${configPath}.rango-install.lock`;
    let lock;
    try {
      lock = await acquireInstallerLock(lockPath);
      await assertNoSymlink(workspaceRoot, configPath);
      const temporary = join(
        directory,
        `.${target.path.at(-1)}.${randomUUID()}.tmp`,
      );
      try {
        await writeFile(temporary, updated, {
          encoding: "utf8",
          flag: "wx",
          mode: existingMode,
        });
        if (exists) {
          const current = await readFile(configPath, "utf8");
          if (current !== source) {
            throw new Error(
              `MCP client config changed while it was being updated: ${configPath}`,
            );
          }
          await assertNoSymlink(workspaceRoot, configPath);
          await rename(temporary, configPath);
        } else {
          try {
            await link(temporary, configPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw new Error(
                `MCP client config was created while it was being updated: ${configPath}`,
              );
            }
            throw error;
          }
          await unlink(temporary);
        }
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    } finally {
      if (lock) {
        await releaseInstallerLock(lockPath, lock);
      }
    }
  }

  return {
    client: options.client,
    configPath,
    action,
    dryRun: options.dryRun === true,
  };
}
