import {
  RANGO_DIAGNOSTIC_BRIDGE_EVENT,
  RANGO_DIAGNOSTIC_BRIDGE_VERSION,
  RANGO_DIAGNOSTIC_MAX_BATCH_BYTES,
  RANGO_DIAGNOSTIC_MAX_BATCH_EVENTS,
  RANGO_DIAGNOSTIC_MAX_DROP_REQUESTS,
  type DiagnosticBridgeBatch,
} from "./bridge-protocol.js";
import {
  DEVELOPMENT_DIAGNOSTICS_ENABLED,
  getDevelopmentDiagnosticHub,
  type DiagnosticHub,
} from "./hub.js";
import type { DiagnosticEvent } from "./types.js";
export { injectDevelopmentDiagnosticFailureForTesting } from "./channel.js";

const MAX_QUEUED_EVENTS = 256;
const MAX_QUEUED_BYTES = 512 * 1024;
const HOT_DATA_KEY = "__rangoDiagnosticBridgeCleanup";

export interface DiagnosticRuntimeHotContext {
  data: Record<string, unknown>;
  send(event: string, data: unknown): void;
  dispose(callback: () => void): void;
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function connectDiagnosticRuntimeBridge(
  hot: DiagnosticRuntimeHotContext,
  hub: DiagnosticHub,
  realmId: string = crypto.randomUUID(),
): () => void {
  const queue: Array<{ event: DiagnosticEvent; bytes: number }> = [];
  let queuedBytes = 0;
  let batchSequence = 0;
  let droppedEvents = 0;
  const droppedEventsByRequest = new Map<string, number>();
  let scheduled = false;
  let active = true;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const noteDroppedEvents = (count: number, requestId?: string): void => {
    droppedEvents += count;
    if (
      !requestId ||
      new TextEncoder().encode(requestId).byteLength > 128 ||
      (!droppedEventsByRequest.has(requestId) &&
        droppedEventsByRequest.size >= RANGO_DIAGNOSTIC_MAX_DROP_REQUESTS)
    ) {
      return;
    }
    droppedEventsByRequest.set(
      requestId,
      (droppedEventsByRequest.get(requestId) ?? 0) + count,
    );
  };

  const scheduleFlush = (): void => {
    if (!active || scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  };

  const scheduleRetry = (): void => {
    if (!active || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      scheduleFlush();
    }, 50);
  };

  function flush(): void {
    scheduled = false;
    if (!active) return;
    while (queue.length > 0 || droppedEvents > 0) {
      const events: DiagnosticEvent[] = [];
      const selected: Array<{ event: DiagnosticEvent; bytes: number }> = [];
      const requestDrops = [...droppedEventsByRequest].map(
        ([requestId, count]) => ({ requestId, droppedEvents: count }),
      );
      const batchDroppedEvents = droppedEvents;
      let batchBytes = 256 + encodedBytes(requestDrops);
      while (
        queue.length > 0 &&
        events.length < RANGO_DIAGNOSTIC_MAX_BATCH_EVENTS
      ) {
        const next = queue[0]!;
        if (
          events.length > 0 &&
          batchBytes + next.bytes > RANGO_DIAGNOSTIC_MAX_BATCH_BYTES
        ) {
          break;
        }
        queue.shift();
        queuedBytes -= next.bytes;
        selected.push(next);
        events.push(next.event);
        batchBytes += next.bytes + 1;
      }

      const batch: DiagnosticBridgeBatch = {
        bridgeVersion: RANGO_DIAGNOSTIC_BRIDGE_VERSION,
        diagnosticSchemaVersion: 1,
        realmId,
        batchSequence: batchSequence + 1,
        droppedEvents: batchDroppedEvents,
        droppedEventsByRequest: requestDrops,
        events,
      };
      try {
        hot.send(RANGO_DIAGNOSTIC_BRIDGE_EVENT, batch);
        batchSequence = batch.batchSequence;
        droppedEvents -= batchDroppedEvents;
        for (const entry of requestDrops) {
          const remaining =
            (droppedEventsByRequest.get(entry.requestId) ?? 0) -
            entry.droppedEvents;
          if (remaining > 0) {
            droppedEventsByRequest.set(entry.requestId, remaining);
          } else {
            droppedEventsByRequest.delete(entry.requestId);
          }
        }
      } catch {
        queue.unshift(...selected);
        queuedBytes += selected.reduce((total, item) => total + item.bytes, 0);
        scheduleRetry();
        break;
      }
    }
  }

  const unsubscribe = hub.subscribe((event) => {
    if (!active) return;
    let bytes: number;
    try {
      bytes = encodedBytes(event);
    } catch {
      noteDroppedEvents(1, event.requestId);
      scheduleFlush();
      return;
    }
    while (
      queue.length > 0 &&
      (queue.length >= MAX_QUEUED_EVENTS ||
        queuedBytes + bytes > MAX_QUEUED_BYTES)
    ) {
      const dropped = queue.shift()!;
      queuedBytes -= dropped.bytes;
      noteDroppedEvents(1, dropped.event.requestId);
    }
    if (bytes > RANGO_DIAGNOSTIC_MAX_BATCH_BYTES) {
      noteDroppedEvents(1, event.requestId);
      scheduleFlush();
      return;
    }
    queue.push({ event, bytes });
    queuedBytes += bytes;
    scheduleFlush();
  });
  const unsubscribeDrops = hub.subscribeDroppedInputs((count, requestId) => {
    noteDroppedEvents(count, requestId);
    scheduleFlush();
  });

  const cleanup = (): void => {
    if (!active) return;
    if (scheduled || queue.length > 0 || droppedEvents > 0) flush();
    active = false;
    if (retryTimer) clearTimeout(retryTimer);
    unsubscribe();
    unsubscribeDrops();
    for (const queued of queue) noteDroppedEvents(1, queued.event.requestId);
    queue.length = 0;
    queuedBytes = 0;
  };
  return cleanup;
}

const runtimeHot = (
  import.meta as ImportMeta & { hot?: DiagnosticRuntimeHotContext }
).hot;

if (DEVELOPMENT_DIAGNOSTICS_ENABLED && runtimeHot) {
  const previousCleanup = runtimeHot.data[HOT_DATA_KEY];
  if (typeof previousCleanup === "function") previousCleanup();
  const hub = getDevelopmentDiagnosticHub();
  if (hub) {
    const cleanup = connectDiagnosticRuntimeBridge(runtimeHot, hub);
    runtimeHot.data[HOT_DATA_KEY] = cleanup;
    runtimeHot.dispose(cleanup);
  }
}
