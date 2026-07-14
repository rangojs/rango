import type {
  DiagnosticEvent,
  DiagnosticEventInput,
  DiagnosticHubLimits,
  DiagnosticHubStats,
  DiagnosticTrace,
  DiagnosticTruncationReason,
} from "./types.js";

declare const __RANGO_DEV_DIAGNOSTICS__: boolean;

export const DEVELOPMENT_DIAGNOSTICS_ENABLED: boolean =
  typeof __RANGO_DEV_DIAGNOSTICS__ !== "undefined"
    ? __RANGO_DEV_DIAGNOSTICS__
    : ((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV ??
      globalThis.process?.env?.NODE_ENV === "development");

const DEFAULT_LIMITS: DiagnosticHubLimits = {
  maxRequests: 100,
  maxEvents: 5_000,
  maxAgeMs: 5 * 60_000,
  maxEncodedBytes: 4 * 1024 * 1024,
  maxEventBytes: 32 * 1024,
};

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

interface StoredTrace {
  trace: DiagnosticTrace;
  encodedBytes: number;
  eventEncodedBytes: number[];
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function addReason(
  trace: DiagnosticTrace,
  reason: DiagnosticTruncationReason,
): boolean {
  trace.truncated = true;
  if (!trace.truncationReasons.includes(reason)) {
    trace.truncationReasons.push(reason);
    return true;
  }
  return false;
}

export class DiagnosticHub {
  private readonly limits: DiagnosticHubLimits;
  private readonly traces = new Map<string, StoredTrace>();
  private sequence = 0;
  private eventCount = 0;
  private totalEncodedBytes = 0;
  private droppedEvents = 0;
  private evictedByRequestCount = 0;
  private evictedByAge = 0;

  constructor(limits: Partial<DiagnosticHubLimits> = {}) {
    const configured = { ...DEFAULT_LIMITS, ...limits };
    this.limits = {
      maxRequests: positiveInteger(
        configured.maxRequests,
        DEFAULT_LIMITS.maxRequests,
      ),
      maxEvents: positiveInteger(
        configured.maxEvents,
        DEFAULT_LIMITS.maxEvents,
      ),
      maxAgeMs: positiveInteger(configured.maxAgeMs, DEFAULT_LIMITS.maxAgeMs),
      maxEncodedBytes: positiveInteger(
        configured.maxEncodedBytes,
        DEFAULT_LIMITS.maxEncodedBytes,
      ),
      maxEventBytes: positiveInteger(
        configured.maxEventBytes,
        DEFAULT_LIMITS.maxEventBytes,
      ),
    };
  }

  private addBytes(stored: StoredTrace, bytes: number): void {
    stored.encodedBytes += bytes;
    this.totalEncodedBytes += bytes;
  }

  private removeTrace(requestId: string): void {
    const stored = this.traces.get(requestId);
    if (!stored) return;
    this.eventCount -= stored.trace.events.length;
    this.totalEncodedBytes -= stored.encodedBytes;
    this.traces.delete(requestId);
  }

  private sweepAge(now: number): void {
    for (const [requestId, stored] of this.traces) {
      if (now - stored.trace.updatedAt <= this.limits.maxAgeMs) continue;
      this.removeTrace(requestId);
      this.evictedByAge++;
    }
  }

  private getOrCreateTrace(input: DiagnosticEventInput): StoredTrace {
    const existing = this.traces.get(input.requestId);
    if (existing) return existing;

    while (this.traces.size >= this.limits.maxRequests) {
      const oldest = this.traces.keys().next().value as string | undefined;
      if (!oldest) break;
      this.removeTrace(oldest);
      this.evictedByRequestCount++;
    }

    const trace: DiagnosticTrace = {
      schemaVersion: 1,
      requestId: input.requestId,
      routerId: input.routerId,
      clientCorrelationId: input.clientCorrelationId ?? null,
      transactionIds: [input.transactionId],
      startedAt: input.timestamp,
      updatedAt: input.timestamp,
      completed: false,
      events: [],
      truncated: false,
      truncationReasons: [],
      droppedEvents: 0,
    };
    const stored = {
      trace,
      encodedBytes: encodedBytes(trace),
      eventEncodedBytes: [],
    };
    this.traces.set(input.requestId, stored);
    this.totalEncodedBytes += stored.encodedBytes;
    return stored;
  }

  private dropOldestEvent(reason: DiagnosticTruncationReason): boolean {
    for (const [requestId, stored] of this.traces) {
      if (stored.trace.events.length === 0) {
        if (this.traces.size > 1) {
          this.removeTrace(requestId);
          this.droppedEvents++;
          return true;
        }
        continue;
      }
      stored.trace.events.shift();
      const eventBytes = stored.eventEncodedBytes.shift() ?? 0;
      const separatorBytes = stored.trace.events.length > 0 ? 1 : 0;
      stored.encodedBytes -= eventBytes + separatorBytes;
      this.totalEncodedBytes -= eventBytes + separatorBytes;
      stored.trace.droppedEvents++;
      this.droppedEvents++;
      this.eventCount--;
      const addedReason = addReason(stored.trace, reason);
      this.addBytes(
        stored,
        encodedBytes(stored.trace.droppedEvents) +
          (addedReason ? encodedBytes(reason) + 1 : 0),
      );
      return true;
    }
    return false;
  }

  record(input: DiagnosticEventInput): void {
    this.sweepAge(input.timestamp);
    const stored = this.getOrCreateTrace(input);
    const event: DiagnosticEvent = {
      ...input,
      schemaVersion: 1,
      sequence: ++this.sequence,
    };
    const eventBytes = encodedBytes(event);
    if (eventBytes > this.limits.maxEventBytes) {
      stored.trace.updatedAt = input.timestamp;
      stored.trace.droppedEvents++;
      this.droppedEvents++;
      const addedReason = addReason(stored.trace, "event-too-large");
      this.addBytes(
        stored,
        encodedBytes(input.timestamp) +
          encodedBytes(stored.trace.droppedEvents) +
          (addedReason ? encodedBytes("event-too-large") + 1 : 0),
      );
      this.enforceEncodedByteLimit();
      return;
    }

    const hadEvents = stored.trace.events.length > 0;
    stored.trace.events.push(event);
    stored.eventEncodedBytes.push(eventBytes);
    stored.trace.updatedAt = input.timestamp;
    let metadataBytes = encodedBytes(input.timestamp);
    if (!stored.trace.transactionIds.includes(input.transactionId)) {
      stored.trace.transactionIds.push(input.transactionId);
      metadataBytes += encodedBytes(input.transactionId) + 1;
    }
    if (input.type === "request.completed" || input.type === "request.failed") {
      stored.trace.completed = true;
    }
    this.eventCount++;
    this.addBytes(stored, eventBytes + (hadEvents ? 1 : 0) + metadataBytes);

    while (this.eventCount > this.limits.maxEvents) {
      if (!this.dropOldestEvent("event-count")) break;
    }
    this.enforceEncodedByteLimit();
  }

  private enforceEncodedByteLimit(): void {
    while (this.totalEncodedBytes > this.limits.maxEncodedBytes) {
      if (!this.dropOldestEvent("encoded-bytes")) break;
    }
    while (this.totalEncodedBytes > this.limits.maxEncodedBytes) {
      const oldest = this.traces.keys().next().value as string | undefined;
      if (!oldest) break;
      this.removeTrace(oldest);
      this.droppedEvents++;
    }
  }

  noteDroppedEvent(requestId?: string): void {
    this.droppedEvents++;
    if (!requestId) return;
    const stored = this.traces.get(requestId);
    if (!stored) return;
    stored.trace.droppedEvents++;
    this.addBytes(stored, encodedBytes(stored.trace.droppedEvents));
    this.enforceEncodedByteLimit();
  }

  getTrace(
    requestId: string,
    now: number = performance.now(),
  ): DiagnosticTrace | null {
    this.sweepAge(now);
    const trace = this.traces.get(requestId)?.trace;
    return trace ? structuredClone(trace) : null;
  }

  listTraces(now: number = performance.now()): DiagnosticTrace[] {
    this.sweepAge(now);
    return [...this.traces.values()].map(({ trace }) => structuredClone(trace));
  }

  getStats(now: number = performance.now()): DiagnosticHubStats {
    this.sweepAge(now);
    return {
      requestCount: this.traces.size,
      eventCount: this.eventCount,
      encodedBytes: this.totalEncodedBytes,
      droppedEvents: this.droppedEvents,
      evictedByRequestCount: this.evictedByRequestCount,
      evictedByAge: this.evictedByAge,
    };
  }
}

let developmentHub: DiagnosticHub | undefined;

export function getDevelopmentDiagnosticHub(): DiagnosticHub | null {
  if (!DEVELOPMENT_DIAGNOSTICS_ENABLED) return null;
  developmentHub ??= new DiagnosticHub();
  return developmentHub;
}

export function resetDevelopmentDiagnosticHub(): void {
  developmentHub = undefined;
}
