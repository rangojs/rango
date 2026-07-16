import type { DiagnosticEvent } from "./types.js";

export const RANGO_DIAGNOSTIC_BRIDGE_EVENT = "rango:diagnostics:batch";
export const RANGO_DIAGNOSTIC_BRIDGE_VERSION = 2 as const;
export const RANGO_DIAGNOSTIC_MAX_BATCH_EVENTS = 64;
export const RANGO_DIAGNOSTIC_MAX_BATCH_BYTES: number = 128 * 1024;
export const RANGO_DIAGNOSTIC_MAX_DROP_REQUESTS: number = 64;

export interface DiagnosticBridgeRequestDrop {
  requestId: string;
  droppedEvents: number;
}

export interface DiagnosticBridgeBatch {
  bridgeVersion: typeof RANGO_DIAGNOSTIC_BRIDGE_VERSION;
  diagnosticSchemaVersion: 1;
  realmId: string;
  batchSequence: number;
  droppedEvents: number;
  droppedEventsByRequest: DiagnosticBridgeRequestDrop[];
  events: DiagnosticEvent[];
}
