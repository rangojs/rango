import {
  DEV_DISCOVERY_QUERY_EVENT,
  DEV_DISCOVERY_READY_EVENT,
  isValidDevDiscoveryEpoch,
} from "../dev-discovery-protocol.js";

export interface DevDiscoveryHot {
  on(
    event: typeof DEV_DISCOVERY_READY_EVENT | "vite:ws:connect",
    listener: (payload: unknown) => void,
  ): void;
  send(
    event: typeof DEV_DISCOVERY_QUERY_EVENT,
    payload: { epoch: number },
  ): void;
}

export interface DevDiscoveryHandshakeOptions {
  reload?: () => void;
}

function readEpoch(payload: unknown): number | undefined {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("epoch" in payload)
  ) {
    return undefined;
  }

  return isValidDevDiscoveryEpoch(payload.epoch) ? payload.epoch : undefined;
}

export function startDevDiscoveryHandshake(
  documentEpoch: unknown,
  hot: DevDiscoveryHot,
  options: DevDiscoveryHandshakeOptions = {},
): void {
  if (!isValidDevDiscoveryEpoch(documentEpoch)) return;
  const currentDocumentEpoch = documentEpoch;

  const reload = options.reload ?? (() => window.location.reload());
  let reloadRequested = false;

  function reloadIfNewer(payload: unknown): void {
    const readyEpoch = readEpoch(payload);
    if (
      reloadRequested ||
      readyEpoch === undefined ||
      readyEpoch <= currentDocumentEpoch
    ) {
      return;
    }

    reloadRequested = true;
    reload();
  }

  function requestReadyEpoch(): void {
    hot.send(DEV_DISCOVERY_QUERY_EVENT, { epoch: currentDocumentEpoch });
  }

  hot.on(DEV_DISCOVERY_READY_EVENT, reloadIfNewer);
  hot.on("vite:ws:connect", requestReadyEpoch);
  requestReadyEpoch();
}
