export type DiagnosticPrimitive = string | number | boolean | null;

export type DiagnosticValue =
  | DiagnosticPrimitive
  | DiagnosticValue[]
  | { [key: string]: DiagnosticValue };

export interface DiagnosticEventInput {
  type: string;
  timestamp: number;
  requestId: string;
  transactionId: string;
  clientCorrelationId?: string;
  routerId: string;
  routeKey?: string;
  segmentId?: string;
  data: Record<string, DiagnosticValue>;
}

export interface DiagnosticEvent extends DiagnosticEventInput {
  schemaVersion: 1;
  sequence: number;
}

export type DiagnosticTruncationReason =
  | "event-count"
  | "encoded-bytes"
  | "event-too-large";

export interface DiagnosticTrace {
  schemaVersion: 1;
  requestId: string;
  routerId: string;
  clientCorrelationId: string | null;
  transactionIds: string[];
  startedAt: number;
  updatedAt: number;
  completed: boolean;
  events: DiagnosticEvent[];
  truncated: boolean;
  truncationReasons: DiagnosticTruncationReason[];
  droppedEvents: number;
}

export interface DiagnosticHubLimits {
  maxRequests: number;
  maxEvents: number;
  maxAgeMs: number;
  maxEncodedBytes: number;
  maxEventBytes: number;
}

export interface DiagnosticHubStats {
  requestCount: number;
  eventCount: number;
  encodedBytes: number;
  droppedEvents: number;
  evictedByRequestCount: number;
  evictedByAge: number;
}
