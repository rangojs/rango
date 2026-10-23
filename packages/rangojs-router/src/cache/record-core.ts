/**
 * The record read every family of a cache store runs: backend read, decode,
 * heal of a value that does not decode, expiry, the request's invalidation
 * check, stale claim and one debug event, in the order of the store's I/O
 * (pinned per store, family and outcome by
 * `__tests__/record-read-sequence.test.ts`). A FamilyPolicy holds what differs
 * per family, a RecordBackend what differs per platform (keys, I/O, the stale
 * lock), a RecordEnv what differs per store or per read. A stale record's
 * revalidation is claimed only once the record is known to be servable, so a
 * read never takes the lock of a record it then drops.
 */

import { reportCacheError } from "./cache-error.js";
import { CACHE_READ_ERROR, type CacheReadError } from "./types.js";

export type RecordFamily = "segment" | "item" | "response" | "shell";

export interface RecordWriteOptions {
  ttlSeconds: number;
  tags?: string[];
  label: string;
}

/**
 * A platform's record storage: key derivation per family and the I/O, nothing
 * about envelopes or staleness.
 */
export interface RecordBackend {
  /**
   * The value stored under `key`, or a promise of it; nullish when absent.
   * Throws or rejects when the backend fails. A value returned synchronously
   * (an in-process map) settles the read without an await, so an expired
   * record is removed in the tick it was read: an await in between would let
   * a write that lands meanwhile be removed with it.
   */
  read(key: string, family: RecordFamily): unknown;
  /** Stores `record` under `key`: the one write of every family. */
  write(
    key: string,
    family: RecordFamily,
    record: unknown,
    options: RecordWriteOptions,
  ): void | Promise<void>;
  /** Removes an expired, corrupt or invalidated record. Never throws or rejects. */
  remove(key: string, family: RecordFamily): void | Promise<void>;
  /**
   * Claims a stale record's revalidation for this read (herd dampening);
   * false when another reader holds it. A backend without it revalidates on
   * every stale read.
   */
  claimRevalidation?(
    key: string,
    family: RecordFamily,
    expiresAt: number,
    label: string,
  ): Promise<boolean>;
}

export interface RecordMeta {
  /** When the record goes stale (ms since epoch); 0: never. */
  staleAt: number;
  expiresAt: number;
  /** Its tags, for the invalidation check (RecordEnv.invalidated). */
  tags?: string[];
  /** The stamp that check compares with (ms since epoch). */
  taggedAt?: number;
}

/**
 * What a failed backend read returns: `"read-error"` is CACHE_READ_ERROR (the
 * segment family: PPR replay renders uncached instead of substituting the
 * seeded doc record), `"miss"` is null.
 */
export type ReadErrorPolicy = "read-error" | "miss";

export type ReadErrorResult<E extends ReadErrorPolicy> = E extends "read-error"
  ? CacheReadError
  : null;

export interface FamilyPolicy<
  R,
  V = R,
  Op extends string = string,
  E extends ReadErrorPolicy = ReadErrorPolicy,
> {
  family: RecordFamily;
  debugOp: Op;
  label: string;
  onReadError: E;
  /** The record in a backend value; null when it is not one (corrupt). */
  decode(raw: unknown): R | null;
  meta(record: R): RecordMeta;
  /**
   * What a hit serves, built before the stale claim; a throw makes the record
   * corrupt. Without it, the record itself.
   */
  open?(record: R): V;
  /** Whether a record the invalidation check rejects is removed too. */
  removeInvalidated?: boolean;
}

export type RecordReadOutcome =
  | "miss"
  | "fresh"
  | "stale-revalidate"
  | "expired"
  | "corrupt"
  | "invalidated"
  | "error";

export interface RecordReadEvent<Op extends string = string> {
  op: Op;
  key: string;
  outcome: RecordReadOutcome;
  shouldRevalidate?: boolean;
  staleAt?: number;
  expiresAt?: number;
  readMs?: number;
}

/**
 * A store's or a read's hooks. Function-typed properties, not methods, so
 * their parameters stay contravariant and a store-wide `RecordEnv<unknown>`
 * leaves readRecord inferring the record type from the policy.
 */
export interface RecordEnv<R = unknown, Op extends string = string> {
  /** Receives the read's debug event; without it none is built. */
  emit?: (event: RecordReadEvent<Op>) => void;
  /** Runs once a value was decoded, before the corrupt check (read timing). */
  afterDecode?: () => void;
  /**
   * Whether this request must not be served the record (the request tag
   * mask, tag markers). A rejected record is a miss.
   */
  invalidated?: (record: R, meta: RecordMeta) => boolean | PromiseLike<boolean>;
  /**
   * Whether this stale read claims the revalidation (default: it does). A
   * stale read that does not claim still reports `shouldRevalidate`.
   */
  claims?: (record: R, now: number) => boolean;
}

export interface RecordRead<R, V = R> {
  record: R;
  value: V;
  stale: boolean;
  /** Stale, and this read holds the revalidation (or needs no claim). */
  shouldRevalidate: boolean;
  raw: unknown;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return typeof (value as PromiseLike<T> | null)?.then === "function";
}

function healCorrupt<R, V, Op extends string, E extends ReadErrorPolicy>(
  backend: RecordBackend,
  key: string,
  policy: FamilyPolicy<R, V, Op, E>,
  env: RecordEnv<R, Op>,
  readMs: number,
  error: unknown,
): null {
  reportCacheError(error, "cache-corrupt", policy.label);
  void backend.remove(key, policy.family);
  env.emit?.({ op: policy.debugOp, key, outcome: "corrupt", readMs });
  return null;
}

/**
 * Reads the record of `policy.family` under `key`: null on a miss (absent, corrupt,
 * expired or invalidated), the policy's read-error result when the backend
 * fails, else the served record.
 */
export async function readRecord<
  R,
  V = R,
  Op extends string = string,
  E extends ReadErrorPolicy = ReadErrorPolicy,
>(
  backend: RecordBackend,
  key: string,
  policy: FamilyPolicy<R, V, Op, E>,
  env: RecordEnv<R, Op>,
): Promise<RecordRead<R, V> | null | ReadErrorResult<E>> {
  const { family, debugOp: op } = policy;
  const started = Date.now();
  let raw: unknown;
  try {
    const pending = backend.read(key, family);
    raw = isPromiseLike(pending) ? await pending : pending;
  } catch (error) {
    reportCacheError(error, "cache-read", policy.label);
    env.emit?.({ op, key, outcome: "error" });
    return (
      policy.onReadError === "read-error" ? CACHE_READ_ERROR : null
    ) as ReadErrorResult<E>;
  }
  const readMs = Date.now() - started;

  if (raw == null) {
    env.emit?.({ op, key, outcome: "miss", readMs });
    return null;
  }
  const record = policy.decode(raw);
  env.afterDecode?.();
  if (record === null) {
    return healCorrupt(
      backend,
      key,
      policy,
      env,
      readMs,
      new Error(`malformed ${family} envelope`),
    );
  }

  const meta = policy.meta(record);
  const { staleAt, expiresAt } = meta;
  const now = Date.now();
  if (now > expiresAt) {
    void backend.remove(key, family);
    env.emit?.({ op, key, outcome: "expired", staleAt, expiresAt, readMs });
    return null;
  }
  if (env.invalidated) {
    const check = env.invalidated(record, meta);
    if (isPromiseLike<boolean>(check) ? await check : check) {
      if (policy.removeInvalidated) void backend.remove(key, family);
      env.emit?.({ op, key, outcome: "invalidated", readMs });
      return null;
    }
  }

  let value: V;
  if (policy.open) {
    try {
      value = policy.open(record);
    } catch (error) {
      return healCorrupt(backend, key, policy, env, readMs, error);
    }
  } else {
    value = record as unknown as V;
  }

  const stale = staleAt > 0 && now > staleAt;
  let shouldRevalidate = stale;
  if (
    stale &&
    backend.claimRevalidation &&
    (env.claims?.(record, now) ?? true)
  ) {
    shouldRevalidate = await backend.claimRevalidation(
      key,
      family,
      expiresAt,
      policy.label,
    );
  }
  env.emit?.({
    op,
    key,
    outcome: shouldRevalidate ? "stale-revalidate" : "fresh",
    shouldRevalidate,
    staleAt,
    expiresAt,
    readMs,
  });
  return { record, value, stale, shouldRevalidate, raw };
}
