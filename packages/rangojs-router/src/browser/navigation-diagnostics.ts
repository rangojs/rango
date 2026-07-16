import {
  RANGO_BROWSER_NAVIGATION_EVENT,
  RANGO_BROWSER_NAVIGATION_VERSION,
  type BrowserNavigationEvent,
  type BrowserNavigationKind,
  type BrowserNavigationRequestRole,
} from "../router/diagnostics/browser-protocol.js";
import { registerBrowserNavigationDiagnostics } from "./navigation-diagnostics-bridge.js";

interface BrowserHotChannel {
  send(event: string, data: unknown): void;
}

const documentId = `doc-${crypto.randomUUID()}`;
let sequence = 0;
let hot: BrowserHotChannel | null = null;

function emit(
  navigationId: string,
  kind: BrowserNavigationKind,
  phase: BrowserNavigationEvent["phase"],
  pathname: string,
  requestId?: string,
  role?: BrowserNavigationRequestRole,
): void {
  hot?.send(RANGO_BROWSER_NAVIGATION_EVENT, {
    version: RANGO_BROWSER_NAVIGATION_VERSION,
    sequence: ++sequence,
    documentId,
    navigationId,
    kind,
    phase,
    pathname: new URL(pathname, window.location.origin).pathname,
    ...(requestId ? { requestId } : {}),
    ...(role ? { role } : {}),
  } satisfies BrowserNavigationEvent);
}

export interface BrowserNavigationDiagnostic {
  id: string;
  kind: BrowserNavigationKind;
  pathname: string;
}

export function startBrowserNavigationDiagnostic(
  kind: BrowserNavigationKind,
  pathname: string,
  existingId?: string,
): BrowserNavigationDiagnostic {
  const navigation = {
    id: existingId ?? `nav-${crypto.randomUUID()}`,
    kind,
    pathname: new URL(pathname, window.location.origin).pathname,
  };
  emit(navigation.id, kind, "started", navigation.pathname);
  return navigation;
}

export function linkBrowserNavigationRequest(
  navigation: BrowserNavigationDiagnostic,
  requestId: string | null,
  role: BrowserNavigationRequestRole,
): void {
  if (!requestId) return;
  emit(
    navigation.id,
    navigation.kind,
    "request-linked",
    navigation.pathname,
    requestId,
    role,
  );
}

export function linkBrowserNavigationResponse(
  navigation: BrowserNavigationDiagnostic,
  response: Response,
  role: BrowserNavigationRequestRole,
): void {
  linkBrowserNavigationRequest(
    navigation,
    response.headers.get("X-Rango-Request-Id"),
    role,
  );
}

export function completeBrowserNavigationDiagnostic(
  navigation: BrowserNavigationDiagnostic,
): void {
  emit(navigation.id, navigation.kind, "committed", navigation.pathname);
}

export function abortBrowserNavigationDiagnostic(
  navigation: BrowserNavigationDiagnostic,
  failed: boolean = false,
): void {
  emit(
    navigation.id,
    navigation.kind,
    failed ? "failed" : "aborted",
    navigation.pathname,
  );
}

function initialRequestId(): string | null {
  const navigation = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  const metric = navigation?.serverTiming?.find(
    (entry) => entry.name === "rango-request-id",
  );
  return metric?.description || null;
}

export function installBrowserNavigationDiagnostics(
  channel: BrowserHotChannel,
): void {
  hot = channel;
  registerBrowserNavigationDiagnostics({
    start: startBrowserNavigationDiagnostic,
    linkResponse: linkBrowserNavigationResponse,
    linkRequest: linkBrowserNavigationRequest,
    complete: completeBrowserNavigationDiagnostic,
    abort: abortBrowserNavigationDiagnostic,
  });
  const navigation = startBrowserNavigationDiagnostic(
    "document",
    window.location.href,
  );
  linkBrowserNavigationRequest(navigation, initialRequestId(), "document");
  completeBrowserNavigationDiagnostic(navigation);
}
