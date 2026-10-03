// @rangojs/openapi — contract type core (flat verb-operation form).
//
// Compile-verified against api-shop operations (see types.test-d.ts). The
// load-bearing shape: each verb helper is ITS OWN generic call
// `verb(pattern, spec)`, so the operation's schemas are captured from the same
// argument the handler literal sits in — the one configuration TypeScript
// reliably contextual-types. A nested `resource(pattern, { methods: {...} })`
// form does NOT infer (ctx.body collapses, return goes unchecked) — the
// sibling-key contextual-typing trap. The flat verb call avoids it.
import type { ExtractParams, ResponseHandlerContext } from "@rangojs/router";

// ----------------------------------------------------------------------------
// Standard Schema (minimal local copy of @standard-schema/spec). Real
// zod>=3.24 / valibot / arktype expose the identical `~standard` shape; replace
// with a dependency on `@standard-schema/spec` when the package is wired.
// ----------------------------------------------------------------------------
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => { value: Output } | { issues: readonly unknown[] };
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}
export type InferOutput<S extends StandardSchemaV1> =
  S extends StandardSchemaV1<unknown, infer O> ? O : never;

// ----------------------------------------------------------------------------
// Contract types
// ----------------------------------------------------------------------------
export type AnySchema = StandardSchemaV1;
type MaybePromise<T> = T | Promise<T>;

/** Output of an optional schema slot (undefined when no schema declared). */
export type Infer<S> = S extends AnySchema ? InferOutput<S> : undefined;
/** Handler/client response type for an op (unknown when no `response`). */
export type RespOf<R> = R extends AnySchema ? InferOutput<R> : unknown;

/** Typed handler context: params from the pattern, body/query from schemas. */
export interface ApiContext<
  P extends string,
  B,
  Q,
> extends ResponseHandlerContext<ExtractParams<P>> {
  params: ExtractParams<P>;
  body: Infer<B>;
  query: Infer<Q>;
}

/** Declared non-2xx outcome for an operation. */
export interface ErrorSpec {
  status: number;
  code: string;
  schema?: AnySchema;
}

/** One operation's spec. B/Q/R/OpId are inferred from this literal per call. */
export interface OpSpec<
  P extends string,
  OpId extends string,
  B extends AnySchema | undefined,
  Q extends AnySchema | undefined,
  R extends AnySchema | undefined,
> {
  operationId?: OpId;
  summary?: string;
  tags?: string[];
  name?: string;
  body?: B;
  query?: Q;
  params?: AnySchema;
  response?: R;
  errors?: ErrorSpec[];
  use?: unknown[];
  cache?: { ttl: number; swr?: number };
  handler: (ctx: ApiContext<P, B, Q>) => MaybePromise<RespOf<R> | Response>;
}

/** A captured operation; phantom `__types` retains B/Q/R for the client. */
export interface Operation<
  P extends string,
  OpId extends string,
  B extends AnySchema | undefined,
  Q extends AnySchema | undefined,
  R extends AnySchema | undefined,
> {
  readonly method: string;
  readonly pattern: P;
  readonly operationId: OpId;
  readonly __types: {
    readonly body: B;
    readonly query: Q;
    readonly response: R;
  };
}

/** A verb helper: pattern + spec → operation, with OpId/B/Q/R inferred. */
export type Verb = <
  P extends string,
  const OpId extends string = string,
  B extends AnySchema | undefined = undefined,
  Q extends AnySchema | undefined = undefined,
  R extends AnySchema | undefined = undefined,
>(
  pattern: P,
  spec: OpSpec<P, OpId, B, Q, R>,
) => Operation<P, OpId, B, Q, R>;

/**
 * Builder helpers. Phase-1 covers the verbs (the load-bearing generics);
 * `middleware`/`cache` grouping + nested-array flattening land with the api()
 * adapter (phase-3).
 */
export interface ApiHelpers {
  get: Verb;
  post: Verb;
  put: Verb;
  patch: Verb;
  delete: Verb;
}

export type AnyOperation = Operation<string, string, any, any, any>;

export interface ApiDocOptions {
  info?: { title: string; version: string };
  servers?: { url: string }[];
  ui?: "scalar" | "swagger" | false;
}

/** Mountable module; `typeof` carries the operations tuple for the client. */
export interface ApiModule<TOps extends readonly AnyOperation[]> {
  readonly __ops: TOps;
}

/**
 * Collect operations and (at runtime) coalesce by path into Rango route items.
 * Phase-1 type signature: flat operation list. (Type signature; the runtime
 * implementation + nested-group flattening land in the impl phase.)
 */
export declare function api<const TOps extends readonly AnyOperation[]>(
  builder: (h: ApiHelpers) => TOps,
  opts?: ApiDocOptions,
): ApiModule<TOps>;

// ----------------------------------------------------------------------------
// Typed client, keyed flat by operationId (type-only)
// ----------------------------------------------------------------------------
type ClientArgs<P extends string, B, Q> = ({} extends ExtractParams<P>
  ? { params?: ExtractParams<P> }
  : { params: ExtractParams<P> }) &
  (B extends AnySchema ? { body: InferOutput<B> } : {}) &
  (Q extends AnySchema ? { query?: InferOutput<Q> } : {});

type OpCall<Op> =
  Op extends Operation<infer P, any, infer B, infer Q, infer R>
    ? {} extends ClientArgs<P, B, Q>
      ? (args?: ClientArgs<P, B, Q>) => Promise<RespOf<R>>
      : (args: ClientArgs<P, B, Q>) => Promise<RespOf<R>>
    : never;

export type Client<M> =
  M extends ApiModule<infer TOps>
    ? { [Op in TOps[number] as Op["operationId"]]: OpCall<Op> }
    : never;

/**
 * Build a per-operation typed client. Runtime input is a string routes map
 * (operationId → pattern); request/response TYPES flow via TContract
 * (`typeof apiModule`, imported type-only) so no operation value reaches the
 * client bundle. (Type signature; runtime implementation lands in the impl phase.)
 */
export declare function createClient<TContract>(
  routes: Record<string, string>,
  opts?: { baseUrl?: string; fetch?: typeof fetch },
): Client<TContract>;
