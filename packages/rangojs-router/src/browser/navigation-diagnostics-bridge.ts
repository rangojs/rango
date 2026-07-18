import type {
  BrowserNavigationKind,
  BrowserNavigationRequestRole,
} from "../router/diagnostics/browser-protocol.js";

declare const __RANGO_DEV_DIAGNOSTICS__: boolean;

export const BROWSER_NAVIGATION_DIAGNOSTICS_ENABLED: boolean =
  typeof __RANGO_DEV_DIAGNOSTICS__ !== "undefined"
    ? __RANGO_DEV_DIAGNOSTICS__
    : ((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV ??
      globalThis.process?.env?.NODE_ENV === "development");

export interface BrowserNavigationDiagnosticRef {
  id: string;
  kind: BrowserNavigationKind;
  pathname: string;
}

export interface BrowserNavigationDiagnosticsApi {
  start(
    kind: BrowserNavigationKind,
    pathname: string,
    existingId?: string,
  ): BrowserNavigationDiagnosticRef;
  linkResponse(
    navigation: BrowserNavigationDiagnosticRef,
    response: Response,
    role: BrowserNavigationRequestRole,
  ): void;
  linkRequest(
    navigation: BrowserNavigationDiagnosticRef,
    requestId: string | null,
    role: BrowserNavigationRequestRole,
  ): void;
  complete(navigation: BrowserNavigationDiagnosticRef): void;
  abort(navigation: BrowserNavigationDiagnosticRef, failed?: boolean): void;
}

let api: BrowserNavigationDiagnosticsApi | null = null;
const pendingOperations: Array<
  (target: BrowserNavigationDiagnosticsApi) => void
> = [];
const MAX_PENDING_OPERATIONS = 256;

export function browserDiagnosticUuid(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
  } catch {}
  const bytes = new Uint8Array(16);
  try {
    globalThis.crypto.getRandomValues(bytes);
  } catch {
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function enqueue(
  operation: (target: BrowserNavigationDiagnosticsApi) => void,
): void {
  if (api) {
    operation(api);
  } else if (pendingOperations.length < MAX_PENDING_OPERATIONS) {
    pendingOperations.push(operation);
  }
}

const pendingApi: BrowserNavigationDiagnosticsApi = {
  start(kind, pathname, existingId) {
    const navigation = {
      id: existingId ?? `nav-${browserDiagnosticUuid()}`,
      kind,
      pathname: new URL(pathname, window.location.origin).pathname,
    };
    enqueue((target) => {
      target.start(kind, navigation.pathname, navigation.id);
    });
    return navigation;
  },
  linkResponse(navigation, response, role) {
    enqueue((target) => target.linkResponse(navigation, response, role));
  },
  linkRequest(navigation, requestId, role) {
    enqueue((target) => target.linkRequest(navigation, requestId, role));
  },
  complete(navigation) {
    enqueue((target) => target.complete(navigation));
  },
  abort(navigation, failed) {
    enqueue((target) => target.abort(navigation, failed));
  },
};

export function registerBrowserNavigationDiagnostics(
  next: BrowserNavigationDiagnosticsApi,
): void {
  api = next;
  for (const operation of pendingOperations.splice(0)) {
    try {
      operation(next);
    } catch {}
  }
}

export function getBrowserNavigationDiagnostics(): BrowserNavigationDiagnosticsApi | null {
  return BROWSER_NAVIGATION_DIAGNOSTICS_ENABLED ? (api ?? pendingApi) : null;
}
