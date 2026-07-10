export const DEV_DISCOVERY_READY_EVENT = "rango:dev-discovery-ready";

export const DEV_DISCOVERY_QUERY_EVENT = "rango:dev-discovery-query";

export const DEV_DISCOVERY_PROBE_HEADER = "x-rango-dev-discovery-probe";

export const DEV_DISCOVERY_EPOCH_HEADER = "x-rango-dev-discovery-epoch";

export function isValidDevDiscoveryEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
