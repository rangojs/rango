import {
  RANGO_MCP_MAX_RESULT_BYTES,
  RANGO_MCP_SCHEMA_VERSION,
  RANGO_MCP_TOOL_SCHEMA_VERSION,
  serializedToolResultBytes,
  type DiscoveryStatusSnapshot,
  type GetRoutesInput,
  type ProjectMetadataSnapshot,
  type RouteRecord,
  type RouterRecord,
  type RoutesPageSnapshot,
  type RouteOwnershipRecord,
  type RouteSourceOwnership,
  type RangoPreset,
} from "./protocol.js";

const DEFAULT_ROUTE_PAGE_SIZE = 200;
const MAX_ROUTE_PAGE_SIZE = 1_000;
const MAX_PROJECT_ROUTERS = 32;
const MAX_PROJECT_URLS = 16;
const MAX_PROJECT_URL_BYTES = 2_048;
const MAX_ERROR_MESSAGE_LENGTH = 2_048;
const MAX_OVERSIZED_ROUTE_FIELD_BYTES = 512;

interface RoutesCursor {
  instanceId: string;
  generation: number;
  routerId: string | null;
  offset: number;
}

export interface SnapshotStoreOptions {
  projectRoot: string;
  preset: RangoPreset;
  mode: string;
  entryFile: string | null;
  rangoVersion: string;
  instanceId: string;
  startedAt: string;
  getDevServerUrls: () => string[];
}

export interface RangoMcpSnapshotStore {
  markDiscoveryPending(): void;
  beginDiscovery(): DiscoveryAttempt;
  publishRoutes(
    routes: RouteRecord[],
    routers: RouterRecord[],
    attempt: DiscoveryAttempt,
    ownership?: RouteOwnershipRecord[],
  ): void;
  failDiscovery(error: unknown, attempt: DiscoveryAttempt): void;
  markRuntimeConvergence(state: "ready" | "pending" | "timeout"): void;
  getProjectMetadata(): ProjectMetadataSnapshot;
  getDiscoveryStatus(): DiscoveryStatusSnapshot;
  getRoutes(input?: GetRoutesInput): RoutesPageSnapshot;
  getRouteSource(
    routerId: string,
    routeKey: string | null,
    routePattern: string | null,
  ): RouteSourceOwnership | null;
}

export interface DiscoveryAttempt {
  id: number;
  changeRevision: number;
}

function isoTime(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function stripControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    ) {
      continue;
    }
    result += character;
  }
  return result;
}

function boundUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  return encoded
    .subarray(0, maxBytes - 3)
    .toString("utf8")
    .replace(/\ufffd$/u, "")
    .concat("...");
}

function redactCredentialAssignment(
  match: string,
  _quote: string,
  key: string,
): string {
  const normalized = key.toLowerCase().replaceAll(/[_-]/g, "");
  return /secret|token|password|passwd|credential|privatekey|accesskey|apikey|databaseurl/.test(
    normalized,
  )
    ? `${key}=[redacted]`
    : match;
}

function sanitizeErrorMessage(error: unknown, projectRoot: string): string {
  let message = "Route discovery failed";
  try {
    if (typeof error === "string") {
      message = error;
    } else if (error && typeof error === "object") {
      const descriptor = Object.getOwnPropertyDescriptor(error, "message");
      if (typeof descriptor?.value === "string") message = descriptor.value;
    }
  } catch {}

  message = stripControlCharacters(
    message
      .slice(0, MAX_ERROR_MESSAGE_LENGTH * 4)
      .replaceAll(projectRoot, ".")
      .replace(/([?&][^=\s&]+)=([^&\s]+)/g, "$1=[redacted]")
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
      .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]*/gi, "$1=[redacted]")
      .replace(
        /\b(authorization)\s*[:=]\s*(?:(?:bearer|basic)\s+)?\S+/gi,
        "$1=[redacted]",
      )
      .replace(/\b(bearer|basic)\s+[a-z0-9._~+/=-]+/gi, "$1 [redacted]")
      .replace(
        /\b(password|passwd|database[_-]?url|api[_-]?key|(?:(?:client|access|refresh|session|auth)[_-]?)?(?:secret|token))\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
        "$1=[redacted]",
      )
      .replace(
        /(["']?)([a-z][a-z0-9_-]{0,127})\1\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi,
        redactCredentialAssignment,
      ),
  );
  return message.length <= MAX_ERROR_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3)}...`;
}

function encodeCursor(cursor: RoutesCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): RoutesCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<RoutesCursor>;
    if (
      !Number.isSafeInteger(parsed.generation) ||
      typeof parsed.instanceId !== "string" ||
      (parsed.routerId !== null && typeof parsed.routerId !== "string") ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0
    ) {
      throw new Error("invalid cursor fields");
    }
    return parsed as RoutesCursor;
  } catch {
    throw new Error("Invalid routes cursor");
  }
}

function truncateOversizedRoute(route: RouteRecord): RouteRecord {
  return {
    routerId: boundUtf8(route.routerId, MAX_OVERSIZED_ROUTE_FIELD_BYTES),
    routerFile:
      route.routerFile === null
        ? null
        : boundUtf8(route.routerFile, MAX_OVERSIZED_ROUTE_FIELD_BYTES),
    name:
      route.name === null
        ? null
        : boundUtf8(route.name, MAX_OVERSIZED_ROUTE_FIELD_BYTES),
    pattern: boundUtf8(route.pattern, MAX_OVERSIZED_ROUTE_FIELD_BYTES),
    kind: route.kind,
    trailingSlash:
      route.trailingSlash === null
        ? null
        : boundUtf8(route.trailingSlash, MAX_OVERSIZED_ROUTE_FIELD_BYTES),
    search: null,
    truncated: true,
  };
}

export function createRangoMcpSnapshotStore(
  options: SnapshotStoreOptions,
): RangoMcpSnapshotStore {
  let phase: DiscoveryStatusSnapshot["phase"] = "starting";
  let attempt = 0;
  let generation = 0;
  let routes: RouteRecord[] = [];
  let routers: RouterRecord[] = [];
  let routeSourcesByName = new Map<string, RouteSourceOwnership | null>();
  let routeSourcesByPattern = new Map<string, RouteSourceOwnership | null>();
  let changeRevision = 0;
  let lastAttemptAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let lastError: DiscoveryStatusSnapshot["lastError"] = null;
  let runtimeConvergence: DiscoveryStatusSnapshot["runtimeConvergence"] =
    options.preset === "cloudflare" ? "pending" : "not-applicable";

  const getDiscoveryStatus = (): DiscoveryStatusSnapshot => {
    return {
      schemaVersion: RANGO_MCP_SCHEMA_VERSION,
      phase,
      attempt,
      generation,
      stale:
        generation > 0 &&
        (phase !== "ready" ||
          runtimeConvergence === "pending" ||
          runtimeConvergence === "timeout"),
      runtimeConvergence,
      routerCount: routers.length,
      routeCount: routes.length,
      lastAttemptAt: isoTime(lastAttemptAt),
      lastSuccessAt: isoTime(lastSuccessAt),
      lastError,
    };
  };

  return {
    markDiscoveryPending(): void {
      changeRevision++;
      phase = "discovering";
    },

    beginDiscovery(): DiscoveryAttempt {
      attempt++;
      phase = "discovering";
      lastAttemptAt = Date.now();
      return { id: attempt, changeRevision };
    },

    publishRoutes(
      nextRoutes: RouteRecord[],
      nextRouters: RouterRecord[],
      discoveryAttempt: DiscoveryAttempt,
      ownership: RouteOwnershipRecord[] = [],
    ): void {
      if (discoveryAttempt.id !== attempt) return;
      routes = [...nextRoutes].sort((a, b) => {
        return (
          a.routerId.localeCompare(b.routerId) ||
          (a.name ?? "").localeCompare(b.name ?? "") ||
          a.pattern.localeCompare(b.pattern)
        );
      });
      routers = [...nextRouters].sort((a, b) => a.id.localeCompare(b.id));
      routeSourcesByName = new Map();
      routeSourcesByPattern = new Map();
      for (const entry of ownership) {
        if (entry.routeName) {
          routeSourcesByName.set(
            `${entry.routerId}\0${entry.routeName}`,
            entry.source,
          );
        }
        const patternKey = `${entry.routerId}\0${entry.routePattern}`;
        const previous = routeSourcesByPattern.get(patternKey);
        if (!routeSourcesByPattern.has(patternKey)) {
          routeSourcesByPattern.set(patternKey, entry.source);
        } else if (JSON.stringify(previous) !== JSON.stringify(entry.source)) {
          routeSourcesByPattern.set(patternKey, null);
        }
      }
      generation++;
      phase =
        discoveryAttempt.changeRevision === changeRevision
          ? "ready"
          : "discovering";
      lastSuccessAt = Date.now();
      lastError = null;
    },

    failDiscovery(error: unknown, discoveryAttempt: DiscoveryAttempt): void {
      if (discoveryAttempt.id !== attempt) return;
      phase =
        discoveryAttempt.changeRevision === changeRevision
          ? "error"
          : "discovering";
      lastError = {
        message: sanitizeErrorMessage(error, options.projectRoot),
        at: new Date().toISOString(),
      };
    },

    markRuntimeConvergence(state): void {
      if (options.preset === "cloudflare") runtimeConvergence = state;
    },

    getProjectMetadata(): ProjectMetadataSnapshot {
      const allUrls = options.getDevServerUrls();
      let urls = allUrls
        .slice(0, MAX_PROJECT_URLS)
        .map((url) => boundUtf8(url, MAX_PROJECT_URL_BYTES));
      let selectedRouters = routers.slice(0, MAX_PROJECT_ROUTERS);
      const createMetadata = (): ProjectMetadataSnapshot => ({
        schemaVersion: RANGO_MCP_SCHEMA_VERSION,
        toolSchemaVersion: RANGO_MCP_TOOL_SCHEMA_VERSION,
        projectRoot: options.projectRoot,
        preset: options.preset,
        mode: options.mode,
        entryFile: options.entryFile,
        versions: { rango: options.rangoVersion, node: process.version },
        runtime: {
          instanceId: options.instanceId,
          pid: process.pid,
          startedAt: options.startedAt,
          urls,
          urlsTruncated:
            urls.length < allUrls.length ||
            urls.some((url, index) => url !== allUrls[index]),
        },
        routers: selectedRouters,
        routersTruncated: selectedRouters.length < routers.length,
        capabilities: {
          routes: true,
          discoveryStatus: true,
          compilationIssues: true,
          recentRequests: true,
          runtimeErrors: true,
          renderExplanation: true,
          revalidationExplanation: true,
          cacheTagExplanation: true,
          sourceOwnership: true,
          browserState: false,
          logs: false,
        },
      });

      let metadata = createMetadata();
      while (
        serializedToolResultBytes(metadata) > RANGO_MCP_MAX_RESULT_BYTES &&
        selectedRouters.length > 0
      ) {
        selectedRouters = selectedRouters.slice(0, -1);
        metadata = createMetadata();
      }
      while (
        serializedToolResultBytes(metadata) > RANGO_MCP_MAX_RESULT_BYTES &&
        urls.length > 0
      ) {
        urls = urls.slice(0, -1);
        metadata = createMetadata();
      }
      if (serializedToolResultBytes(metadata) > RANGO_MCP_MAX_RESULT_BYTES) {
        throw new Error("Rango MCP project metadata exceeded its output limit");
      }
      return metadata;
    },

    getDiscoveryStatus,

    getRoutes(input: GetRoutesInput = {}): RoutesPageSnapshot {
      const routerId = input.routerId ?? null;
      const limit = Math.min(
        Math.max(input.limit ?? DEFAULT_ROUTE_PAGE_SIZE, 1),
        MAX_ROUTE_PAGE_SIZE,
      );
      let offset = 0;

      if (input.cursor) {
        const cursor = decodeCursor(input.cursor);
        if (cursor.instanceId !== options.instanceId) {
          throw new Error(
            "Routes cursor belongs to a previous development server; request the first page again",
          );
        }
        if (cursor.generation !== generation) {
          throw new Error(
            "Routes changed after this cursor was issued; request the first page again",
          );
        }
        if (cursor.routerId !== routerId) {
          throw new Error("Routes cursor does not match the routerId filter");
        }
        offset = cursor.offset;
      }

      const filteredRoutes = routerId
        ? routes.filter((route) => route.routerId === routerId)
        : routes;
      const page: RouteRecord[] = [];
      const status = getDiscoveryStatus();
      const createPage = (
        pageRoutes: RouteRecord[],
        nextOffset: number,
        truncated: boolean,
      ): RoutesPageSnapshot => ({
        schemaVersion: RANGO_MCP_SCHEMA_VERSION,
        generation,
        capturedAt: status.lastSuccessAt,
        stale: status.stale,
        routerCount: status.routerCount,
        totalRoutes: filteredRoutes.length,
        routes: pageRoutes,
        nextCursor:
          nextOffset < filteredRoutes.length
            ? encodeCursor({
                instanceId: options.instanceId,
                generation,
                routerId,
                offset: nextOffset,
              })
            : null,
        truncated,
      });
      let stoppedForSize = false;
      while (
        page.length < limit &&
        offset + page.length < filteredRoutes.length
      ) {
        const route = filteredRoutes[offset + page.length]!;
        const candidate = createPage(
          [...page, route],
          offset + page.length + 1,
          false,
        );
        if (
          serializedToolResultBytes(candidate) <= RANGO_MCP_MAX_RESULT_BYTES
        ) {
          page.push(route);
          continue;
        }
        if (page.length > 0) {
          stoppedForSize = true;
          break;
        }
        const truncatedRoute = truncateOversizedRoute(route);
        const truncatedCandidate = createPage(
          [truncatedRoute],
          offset + 1,
          false,
        );
        if (
          serializedToolResultBytes(truncatedCandidate) >
          RANGO_MCP_MAX_RESULT_BYTES
        ) {
          throw new Error("Rango MCP route record exceeded its output limit");
        }
        page.push(truncatedRoute);
      }
      const nextOffset = offset + page.length;
      return createPage(page, nextOffset, stoppedForSize);
    },

    getRouteSource(
      routerId: string,
      routeKey: string | null,
      routePattern: string | null,
    ): RouteSourceOwnership | null {
      if (routeKey) {
        const nameKey = `${routerId}\0${routeKey}`;
        if (routeSourcesByName.has(nameKey)) {
          return routeSourcesByName.get(nameKey) ?? null;
        }
      }
      if (!routePattern) return null;
      const patternKey = `${routerId}\0${routePattern}`;
      if (routeSourcesByPattern.has(patternKey)) {
        return routeSourcesByPattern.get(patternKey) ?? null;
      }
      const routerFile = routes.find(
        (route) =>
          route.routerId === routerId &&
          route.pattern === routePattern &&
          (!routeKey || route.name === routeKey),
      )?.routerFile;
      return routerFile
        ? {
            file: routerFile,
            kind: "route",
            precision: "router-file",
          }
        : null;
    },
  };
}
