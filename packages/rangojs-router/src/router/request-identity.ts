import { AsyncLocalStorage } from "node:async_hooks";

const MAX_CLIENT_CORRELATION_BYTES = 128;

export interface RequestIdentity {
  requestId: string;
  clientCorrelationId: string | null;
  createdAt: number;
}

export interface RequestTransactionIdentity extends RequestIdentity {
  transactionId: string;
  transaction: string;
  routerId?: string;
  diagnosticsEnabled: boolean;
}

export interface RequestTransactionOptions {
  routerId?: string;
  diagnosticsEnabled?: boolean;
}

const requestIds = new WeakMap<Request, string>();
const requestIdentities = new WeakMap<Request, RequestIdentity>();
const transactionCounters = new WeakMap<Request, number>();
let transactionStorage:
  | AsyncLocalStorage<RequestTransactionIdentity>
  | undefined;

function getTransactionStorage(): AsyncLocalStorage<RequestTransactionIdentity> {
  transactionStorage ??= new AsyncLocalStorage<RequestTransactionIdentity>();
  return transactionStorage;
}

function boundedPrintableHeader(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  const encoded = new TextEncoder().encode(trimmed);
  if (encoded.byteLength > MAX_CLIENT_CORRELATION_BYTES) return null;
  return trimmed;
}

function readClientCorrelationId(request: Request): string | null {
  return boundedPrintableHeader(
    request.headers.get("x-rsc-router-request-id") ??
      request.headers.get("x-request-id") ??
      request.headers.get("cf-ray"),
  );
}

function createServerRequestId(): string {
  return `req-${globalThis.crypto.randomUUID()}`;
}

export function getRequestIdentity(request: Request): RequestIdentity {
  const existing = requestIdentities.get(request);
  if (existing) return existing;

  const identity: RequestIdentity = {
    requestId: getServerRequestId(request),
    clientCorrelationId: readClientCorrelationId(request),
    createdAt: performance.now(),
  };
  requestIdentities.set(request, identity);
  return identity;
}

export function getServerRequestId(request: Request): string {
  const existing = requestIds.get(request);
  if (existing) return existing;
  const requestId = createServerRequestId();
  requestIds.set(request, requestId);
  return requestId;
}

export function runWithRequestTransaction<T>(
  request: Request,
  transaction: string,
  fn: () => T,
  options: RequestTransactionOptions = {},
): T {
  const identity = getRequestIdentity(request);
  const storage = getTransactionStorage();
  const parent = storage.getStore();
  const inheritedRouterId =
    parent?.requestId === identity.requestId ? parent.routerId : undefined;
  const routerId = options.routerId ?? inheritedRouterId;
  const next = (transactionCounters.get(request) ?? 0) + 1;
  transactionCounters.set(request, next);
  return storage.run(
    {
      ...identity,
      transactionId: `${transaction}-tx-${next.toString(36)}`,
      transaction,
      ...(routerId ? { routerId } : {}),
      diagnosticsEnabled:
        options.diagnosticsEnabled ??
        (parent?.requestId === identity.requestId
          ? parent.diagnosticsEnabled
          : false),
    },
    fn,
  );
}

export function getActiveRequestTransaction():
  | RequestTransactionIdentity
  | undefined {
  return transactionStorage?.getStore();
}
