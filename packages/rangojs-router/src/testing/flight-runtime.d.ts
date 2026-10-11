/**
 * Ambient declaration for the vendored react-server-dom serializer shipped
 * inside @vitejs/plugin-rsc. The package ships no .d.ts for this private
 * subpath, so we declare the minimal surface renderToFlightString uses.
 *
 * Only loadable under the `react-server` export condition (see flight.ts).
 */
declare module "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge" {
  /**
   * Serialize a server-component payload to a Flight wire stream.
   *
   * @param payload The value to serialize (Rango wraps a payload object).
   * @param clientManifest Client-reference manifest; `{}` for server-only trees.
   * @param options Render options; `onError` is invoked per render error.
   */
  export function renderToReadableStream(
    payload: unknown,
    clientManifest: unknown,
    options?: { onError?: (error: unknown) => string | void },
  ): ReadableStream<Uint8Array>;

  /** Server-side temporary-reference set (a WeakMap). */
  export function createTemporaryReferenceSet(): unknown;

  /** Resolve a no-JS form POST to its action, bound to the form data; null for a plain form. */
  export function decodeAction(
    body: FormData,
    serverManifest: unknown,
  ): Promise<unknown> | null;

  /** Decode an action's encoded arguments; rejects for a raw form body. */
  export function decodeReply(
    body: string | FormData,
    serverManifest: unknown,
    options?: object,
  ): Promise<unknown>;

  /** The useActionState form state of a no-JS POST, or null. */
  export function decodeFormState(
    actionResult: unknown,
    body: FormData,
    serverManifest: unknown,
  ): Promise<unknown>;

  /** Tag a function as a server reference; `$$id` becomes `${id}#${exportName}`. */
  export function registerServerReference<T>(
    reference: T,
    id: string,
    exportName: string,
  ): T;

  /**
   * Tag a value as a client reference. Mutates `impl` in place (defining
   * `$$typeof`/`$$id`/`$$async`) and returns it, so a server tree that imports
   * the same module binding renders it as a client boundary (an `I` row) rather
   * than inlining it. `$$id` becomes `${id}#${exportName}`.
   */
  export function registerClientReference<T>(
    impl: T,
    id: string,
    exportName: string,
  ): T;
}

/**
 * Vendored react-server-dom CLIENT deserializer wrappers shipped inside
 * @vitejs/plugin-rsc. Used by renderServerTree to turn a Flight wire string
 * back into an inspectable React element tree. These run in the same
 * `react-server`-condition worker as the serializer (deserialize-only never
 * renders, so the client React/react-dom imports they pull are inert).
 */
declare module "@vitejs/plugin-rsc/react/browser" {
  export function createFromReadableStream<T = unknown>(
    stream: ReadableStream<Uint8Array>,
    options?: { temporaryReferences?: unknown },
  ): Promise<T>;
}

declare module "@vitejs/plugin-rsc/core/browser" {
  /**
   * Install the module loader the client deserializer resolves client
   * references through. Init-once per worker (first call wins).
   */
  export function setRequireModule(options: {
    load: (id: string) => unknown;
  }): void;
}

/**
 * The vendored react-server-dom CLIENT build the RSC environment decodes with
 * (plugin-rsc `react/rsc/client`). The plugin-rsc stub runs the "use cache"
 * codec on it under the react-server condition.
 */
declare module "@vitejs/plugin-rsc/vendor/react-server-dom/client.edge" {
  export function createFromReadableStream<T = unknown>(
    stream: ReadableStream<Uint8Array>,
    options?: object,
  ): Promise<T>;
  export function encodeReply(
    value: unknown,
    options?: object,
  ): Promise<string | FormData>;
  /** Client-side temporary-reference set (a Map). */
  export function createTemporaryReferenceSet(): unknown;
}
