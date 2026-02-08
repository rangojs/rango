/**
 * Persistent Node.js prerender server for Cloudflare dev mode.
 *
 * In cloudflare dev mode, RSC and SSR environments run in workerd via
 * @cloudflare/vite-plugin. Prerender handlers use Node.js APIs (node:fs,
 * import.meta.dirname) that aren't available in workerd.
 *
 * This module creates a persistent Vite dev server (reusing the buildStart
 * temp server pattern) that stays alive for the dev session. A middleware
 * intercepts requests matching prerender routes BEFORE they reach the
 * cloudflare workerd proxy and delegates them to this Node.js server.
 */

import type { Plugin } from "vite";
import { createServer as createViteServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { VIRTUAL_ENTRY_SSR, VIRTUAL_ENTRY_BROWSER } from "./virtual-entries.ts";

export interface PrerenderServer {
  /** Execute a request through the prerender server's RSC handler */
  fetch(request: Request): Promise<Response>;
  /** Populate manifest data from main server's discovery */
  setManifest(
    manifest: Record<string, string>,
    precomputed?: any[],
    trie?: any,
  ): void;
  /**
   * Discover routers and return prerender route info.
   * Uses the server's own RSC env so module resolution is consistent.
   */
  discoverPrerenderRoutes(): Promise<{
    prerenderRoutes: string[];
    routeManifest: Record<string, string>;
  }>;
  /** Dispose the server */
  dispose(): Promise<void>;
}

export interface CreatePrerenderServerOptions {
  projectRoot: string;
  entryPath: string;
  resolveAlias: any;
  /** Extra Vite plugins (version, virtual stubs) for the temp server */
  extraPlugins?: Plugin[];
}

/**
 * Create a persistent Node.js Vite dev server for prerender route handling.
 * Mirrors the buildStart temp server pattern but stays alive for the session.
 */
export async function createPrerenderServer(
  opts: CreatePrerenderServerOptions,
): Promise<PrerenderServer> {
  const { default: rsc } = await import("@vitejs/plugin-rsc");

  // Virtual module plugin: provide real SSR/browser entries for SSR rendering,
  // and stubs for other virtual modules not needed in the prerender server.
  const virtualAndStubPlugin: Plugin = {
    name: "@rangojs/router:prerender-stubs",
    resolveId(id) {
      if (id === "virtual:entry-ssr") return "\0virtual:entry-ssr";
      if (id === "virtual:entry-client") return "\0virtual:entry-client";
      if (
        id.startsWith("virtual:rsc-router/") ||
        id.startsWith("virtual:entry-") ||
        id.startsWith("virtual:vite-rsc/")
      ) {
        return "\0stub:" + id;
      }
      return null;
    },
    load(id) {
      if (id === "\0virtual:entry-ssr") return VIRTUAL_ENTRY_SSR;
      if (id === "\0virtual:entry-client") return VIRTUAL_ENTRY_BROWSER;
      if (id.startsWith("\0stub:")) {
        return "export default {}";
      }
      return null;
    },
  };

  const server = await createViteServer({
    root: opts.projectRoot,
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
    resolve: { alias: opts.resolveAlias },
    esbuild: { jsx: "automatic", jsxImportSource: "react" },
    plugins: [
      rsc({
        entries: {
          client: "virtual:entry-client",
          ssr: "virtual:entry-ssr",
          rsc: opts.entryPath,
        },
      }),
      ...(opts.extraPlugins || []),
      virtualAndStubPlugin,
    ],
  });

  const rscEnv = (server.environments as any)?.rsc;
  if (!rscEnv?.runner) {
    await server.close();
    throw new Error(
      "[rsc-router] Prerender server: RSC environment runner not available",
    );
  }

  // Mock env that throws when cloudflare bindings are accessed
  const mockEnv = new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === "toString" || prop === Symbol.toPrimitive) {
          return () => "[PrerenderEnv]";
        }
        if (prop === Symbol.toStringTag) return "PrerenderEnv";
        // Allow Variables to pass through as empty
        if (prop === "Variables") return {};
        throw new Error(
          `Cloudflare binding "${String(prop)}" is not available in prerender environment`,
        );
      },
    },
  );

  return {
    async fetch(request: Request): Promise<Response> {
      // Append __no_cache to skip cache middleware (CFCacheStore would throw
      // without real bindings). The handler already supports this param.
      const url = new URL(request.url);
      url.searchParams.set("__no_cache", "");
      const modifiedRequest = new Request(url.toString(), {
        method: request.method,
        headers: request.headers,
      });

      // Import the worker entry via RSC runner (modules are cached by Vite)
      const workerMod = await rscEnv.runner.import(opts.entryPath);
      const handler = workerMod.default;

      if (!handler?.fetch) {
        throw new Error(
          "[rsc-router] Prerender server: worker entry does not export a default fetch handler",
        );
      }

      return handler.fetch(modifiedRequest, mockEnv, {
        waitUntil: () => {},
        passThroughOnException: () => {},
      });
    },

    setManifest(manifest, precomputed, trie) {
      // Populate the prerender server's RSC env with manifest data
      rscEnv.runner
        .import("@rangojs/router/server")
        .then((serverMod: any) => {
          if (serverMod.setCachedManifest) {
            serverMod.setCachedManifest(manifest);
          }
          if (
            precomputed &&
            precomputed.length > 0 &&
            serverMod.setPrecomputedEntries
          ) {
            serverMod.setPrecomputedEntries(precomputed);
          }
          if (trie && serverMod.setRouteTrie) {
            serverMod.setRouteTrie(trie);
          }
        })
        .catch((err: Error) => {
          console.warn(
            "[rsc-router] Prerender server: failed to set manifest:",
            err.message,
          );
        });
    },

    async discoverPrerenderRoutes() {
      // Import entry to register routers in this server's module context
      await rscEnv.runner.import(opts.entryPath);

      const serverMod = await rscEnv.runner.import("@rangojs/router/server");
      const registry: Map<string, any> = serverMod.RouterRegistry;

      if (!registry || registry.size === 0) {
        return { prerenderRoutes: [], routeManifest: {} };
      }

      const buildMod = await rscEnv.runner.import("@rangojs/router/build");
      const generateManifest = buildMod.generateManifest;
      if (!generateManifest) {
        return { prerenderRoutes: [], routeManifest: {} };
      }

      const allPrerenderRoutes: string[] = [];
      const mergedManifest: Record<string, string> = {};
      let routerMountIndex = 0;

      for (const [, router] of registry) {
        if (!router.urlpatterns) continue;
        const manifest = generateManifest(router.urlpatterns, routerMountIndex);
        routerMountIndex++;
        Object.assign(mergedManifest, manifest.routeManifest);
        if (manifest.prerenderRoutes) {
          allPrerenderRoutes.push(...manifest.prerenderRoutes);
        }
      }

      // Populate this server with the discovered manifest
      if (Object.keys(mergedManifest).length > 0) {
        this.setManifest(mergedManifest);
      }

      return { prerenderRoutes: allPrerenderRoutes, routeManifest: mergedManifest };
    },

    async dispose() {
      await server.close();
    },
  };
}

// -- Middleware helpers -------------------------------------------------------

/**
 * Convert URL patterns from route manifest to regexes for matching.
 * Replaces :param with [^/]+ and * with .*.
 * Trailing slashes are made optional to handle both /articles and /articles/.
 */
export function buildPrerenderPatternMatchers(
  prerenderRouteNames: string[],
  routeManifest: Record<string, string>,
): RegExp[] {
  const matchers: RegExp[] = [];
  for (const name of prerenderRouteNames) {
    const pattern = routeManifest[name];
    if (!pattern) continue;
    // Convert route pattern to regex:
    // :param -> [^/]+  and  * -> .*
    // Strip trailing slash and make it optional for matching
    const normalized = pattern.replace(/\/$/, "");
    const regexStr =
      "^" +
      normalized.replace(/:[^/]+/g, "[^/]+").replace(/\*/g, ".*") +
      "/?$";
    matchers.push(new RegExp(regexStr));
  }
  return matchers;
}

/**
 * Check if a pathname matches any prerender route pattern.
 */
export function matchesPrerenderRoute(
  pathname: string,
  matchers: RegExp[],
): boolean {
  for (const re of matchers) {
    if (re.test(pathname)) return true;
  }
  return false;
}

/**
 * Convert a Node.js IncomingMessage to a web Request.
 */
export function nodeToWebRequest(req: IncomingMessage): Request {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }
  }
  return new Request(url.toString(), {
    method: req.method || "GET",
    headers,
  });
}

/**
 * Write a web Response to a Node.js ServerResponse.
 */
export async function writeWebResponseToNode(
  response: Response,
  res: ServerResponse,
): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  res.end();
}
