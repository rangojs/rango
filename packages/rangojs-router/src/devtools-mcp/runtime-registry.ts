import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod/v4";
import { RANGO_MCP_ENDPOINT, type RangoPreset } from "./protocol.js";

const MAX_DESCRIPTOR_BYTES = 16 * 1024;

const runtimeDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  instanceId: z.string().uuid(),
  projectRoot: z.string().min(1),
  preset: z.enum(["node", "cloudflare", "vercel"]),
  pid: z.number().int().positive(),
  startedAt: z.string().datetime(),
  endpoint: z.string().url(),
  token: z.string().min(32).max(256),
});

export interface RangoMcpRuntimeIdentity {
  instanceId: string;
  token: string;
  startedAt: string;
}

export interface RangoMcpRuntimeDescriptor {
  schemaVersion: 1;
  instanceId: string;
  projectRoot: string;
  preset: RangoPreset;
  pid: number;
  startedAt: string;
  endpoint: string;
  token: string;
}

export interface RuntimeRegistrationOptions {
  identity: RangoMcpRuntimeIdentity;
  projectRoot: string;
  preset: RangoPreset;
  endpoint: string;
  registryDirectory?: string;
}

export interface RuntimeRegistration {
  descriptor: RangoMcpRuntimeDescriptor;
  dispose(): Promise<void>;
}

export interface SelectRuntimeOptions {
  projectRoot: string;
  instanceId?: string;
  registryDirectory?: string;
}

export function createRangoMcpRuntimeIdentity(): RangoMcpRuntimeIdentity {
  return {
    instanceId: randomUUID(),
    token: randomBytes(32).toString("base64url"),
    startedAt: new Date().toISOString(),
  };
}

export function getRangoMcpRegistryDirectory(): string {
  return join(homedir(), ".rango", "mcp");
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function descriptorFileName(
  projectRoot: string,
  identity: RangoMcpRuntimeIdentity,
): string {
  const rootHash = createHash("sha256")
    .update(projectRoot)
    .digest("hex")
    .slice(0, 16);
  return `${rootHash}.${process.pid}.${identity.instanceId}.json`;
}

async function ensureRegistryDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Rango MCP registry must be a directory, not a symlink");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error("Rango MCP registry must be owned by the current user");
  }
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
  }
}

async function registryDirectoryIsSafe(directory: string): Promise<boolean> {
  try {
    const stat = await lstat(directory);
    const uid = process.getuid?.();
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (uid === undefined || stat.uid === uid) &&
      (process.platform === "win32" || (stat.mode & 0o077) === 0)
    );
  } catch {
    return false;
  }
}

function validateRuntimeEndpoint(value: string): URL {
  const endpoint = new URL(value);
  const loopback =
    endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    !loopback ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== RANGO_MCP_ENDPOINT ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error(
      `Rango MCP runtime endpoint must be ${RANGO_MCP_ENDPOINT} on a literal loopback address`,
    );
  }
  return endpoint;
}

export async function registerRangoMcpRuntime(
  options: RuntimeRegistrationOptions,
): Promise<RuntimeRegistration> {
  const directory = options.registryDirectory ?? getRangoMcpRegistryDirectory();
  const projectRoot = await canonicalPath(options.projectRoot);
  const endpointUrl = validateRuntimeEndpoint(options.endpoint);

  const descriptor: RangoMcpRuntimeDescriptor = {
    schemaVersion: 1,
    instanceId: options.identity.instanceId,
    projectRoot,
    preset: options.preset,
    pid: process.pid,
    startedAt: options.identity.startedAt,
    endpoint: endpointUrl.href,
    token: options.identity.token,
  };
  await ensureRegistryDirectory(directory);

  const filename = descriptorFileName(projectRoot, options.identity);
  const destination = join(directory, filename);
  const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(descriptor)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, destination);
    if (process.platform !== "win32") {
      await chmod(destination, 0o600);
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }

  return {
    descriptor,
    async dispose(): Promise<void> {
      await unlink(destination).catch(() => {});
    },
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readDescriptor(
  directory: string,
  filename: string,
): Promise<RangoMcpRuntimeDescriptor | null> {
  const path = join(directory, filename);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > MAX_DESCRIPTOR_BYTES ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    ) {
      return null;
    }
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) return null;

    const parsed = runtimeDescriptorSchema.safeParse(
      JSON.parse(await handle.readFile({ encoding: "utf8" })),
    );
    if (!parsed.success) return null;
    try {
      validateRuntimeEndpoint(parsed.data.endpoint);
    } catch {
      return null;
    }
    if (!processIsAlive(parsed.data.pid)) {
      await unlink(path).catch(() => {});
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isWithinProject(requestedRoot: string, projectRoot: string): boolean {
  const pathFromProject = relative(projectRoot, requestedRoot);
  return (
    pathFromProject === "" ||
    (!pathFromProject.startsWith("..") && !isAbsolute(pathFromProject))
  );
}

export async function listRangoMcpRuntimes(
  registryDirectory: string = getRangoMcpRegistryDirectory(),
): Promise<RangoMcpRuntimeDescriptor[]> {
  if (!(await registryDirectoryIsSafe(registryDirectory))) return [];
  let entries: string[];
  try {
    entries = await readdir(registryDirectory);
  } catch {
    return [];
  }

  const descriptors = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => readDescriptor(registryDirectory, entry)),
  );
  return descriptors
    .filter((entry): entry is RangoMcpRuntimeDescriptor => entry !== null)
    .sort((a, b) => a.projectRoot.localeCompare(b.projectRoot));
}

export async function selectRangoMcpRuntime(
  options: SelectRuntimeOptions,
): Promise<RangoMcpRuntimeDescriptor> {
  const requestedRoot = await canonicalPath(options.projectRoot);
  let candidates = (
    await listRangoMcpRuntimes(options.registryDirectory)
  ).filter((descriptor) =>
    isWithinProject(requestedRoot, descriptor.projectRoot),
  );
  if (options.instanceId) {
    candidates = candidates.filter(
      (descriptor) => descriptor.instanceId === options.instanceId,
    );
  }
  if (candidates.length === 0) {
    throw new Error(
      `No running Rango development server found for ${requestedRoot}`,
    );
  }

  const longestRoot = Math.max(
    ...candidates.map((descriptor) => descriptor.projectRoot.length),
  );
  candidates = candidates.filter(
    (descriptor) => descriptor.projectRoot.length === longestRoot,
  );
  if (candidates.length > 1) {
    throw new Error(
      `Multiple Rango development servers found for ${requestedRoot}: ${candidates
        .map((descriptor) => descriptor.instanceId)
        .join(", ")}. Restart with --instance <id> to select one.`,
    );
  }
  return candidates[0]!;
}
