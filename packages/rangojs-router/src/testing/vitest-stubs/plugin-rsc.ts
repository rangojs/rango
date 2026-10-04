/// <reference path="../flight-runtime.d.ts" />
/**
 * Stub for `@vitejs/plugin-rsc/rsc` and the split `/rsc/server`, `/rsc/client`
 * entries, shipped so consumers do not have to write a per-file `vi.mock(...)`.
 * The real entries top-level import Vite virtuals that do not resolve in plain
 * node.
 *
 * Under the `react-server` condition (the Flight project) the "use cache"
 * codec runs on real Flight: the vendored react-server-dom `server.edge` /
 * `client.edge` builds that plugin-rsc's `react/rsc/server` and
 * `react/rsc/client` wrap, with the same manifests and the same server-side
 * reference loader (`@vitejs/plugin-rsc/core/rsc` `setRequireModule`), so
 * keys, writes, hits, value round trips and error rows match a build. The
 * wrappers are not reused: their manifests read `import.meta.env.DEV`, which
 * is undefined in a module node loads directly (vitest externalizes
 * node_modules).
 *
 * Without the condition React's server build refuses to load, so the codec
 * functions throw and a "use cache" call runs uncached. Any other load failure
 * (a moved vendored path, a missing peer) throws. The action entries stay
 * inert either way: no primitive decodes an action request.
 */

/** React's server build throws this on load without the react-server condition. */
const MISSING_REACT_SERVER_CONDITION =
  /"react-server" condition must be enabled/;

async function loadFlightRuntime() {
  // The server build first, alone. `@vitejs/plugin-rsc/core/rsc` statically
  // imports it, and importing that ESM module after the CJS build failed to
  // load leaks an unhandled rejection from Node's module loader even when every
  // import() is caught (Node 22 and 24). So core/rsc loads only once the server
  // build has.
  const server =
    await import("@vitejs/plugin-rsc/vendor/react-server-dom/server.edge").catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          MISSING_REACT_SERVER_CONDITION.test(error.message)
        ) {
          return undefined;
        }
        throw error;
      },
    );
  if (!server) return undefined;
  const [client, core] = await Promise.all([
    import("@vitejs/plugin-rsc/vendor/react-server-dom/client.edge"),
    import("@vitejs/plugin-rsc/core/rsc"),
  ]);
  await import("../internal/flight-client-globals.js");
  // Resolves the `$$decode-client:` / `$$preserve:` ids a cached value's client
  // and server references decode to; any other id would load a server module.
  core.setRequireModule({
    load: (id) => {
      throw new Error(
        `plugin-rsc stub: server reference module "${id}" is not loadable in a test`,
      );
    },
  });
  return { server, client, core };
}

const runtime = await loadFlightRuntime();

/** `<module id>#<export name>` -> manifest entry, as plugin-rsc builds it. */
function referenceManifest(prefix: string): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_target, $$id) {
        if (typeof $$id !== "string") return undefined;
        const [id, name] = $$id.split("#");
        return { id: prefix + id, name, chunks: [], async: true };
      },
    },
  );
}

const CLIENT_MANIFEST = referenceManifest("");

function unavailable(name: string): never {
  throw new Error(
    `plugin-rsc stub: ${name} needs the react-server condition (the Flight test project)`,
  );
}

export const renderToReadableStream = (
  value: unknown,
  options?: object,
): ReadableStream<Uint8Array> =>
  runtime
    ? runtime.server.renderToReadableStream(value, CLIENT_MANIFEST, options)
    : unavailable("renderToReadableStream");
export const createTemporaryReferenceSet = (): unknown =>
  runtime ? runtime.server.createTemporaryReferenceSet() : {};
export const createFromReadableStream = (
  stream: ReadableStream<Uint8Array>,
  options?: object,
  extraOptions?: { preserveServerReferences?: boolean },
): Promise<unknown> =>
  runtime
    ? runtime.client.createFromReadableStream(stream, {
        serverConsumerManifest: {
          serverModuleMap: referenceManifest(
            extraOptions?.preserveServerReferences
              ? "$$server:$$preserve:"
              : "$$server:",
          ),
          moduleMap: runtime.core.createServerDecodeClientManifest(),
        },
        ...options,
      })
    : unavailable("createFromReadableStream");
export const encodeReply = (
  value: unknown,
  options?: object,
): Promise<string | FormData> =>
  runtime
    ? runtime.client.encodeReply(value, options)
    : unavailable("encodeReply");
export const createClientTemporaryReferenceSet = (): unknown =>
  runtime ? runtime.client.createTemporaryReferenceSet() : {};
export const loadServerAction = (): undefined => undefined;
export const decodeReply = (): undefined => undefined;
export const decodeAction = (): undefined => undefined;
export const decodeFormState = (): undefined => undefined;
