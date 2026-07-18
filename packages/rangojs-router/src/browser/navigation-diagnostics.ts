import {
  RANGO_BROWSER_NAVIGATION_EVENT,
  RANGO_BROWSER_NAVIGATION_VERSION,
  type BrowserNavigationEvent,
  type BrowserNavigationKind,
  type BrowserNavigationRequestRole,
} from "../router/diagnostics/browser-protocol.js";
import {
  browserDiagnosticUuid,
  registerBrowserNavigationDiagnostics,
} from "./navigation-diagnostics-bridge.js";

interface BrowserHotChannel {
  send(event: string, data: unknown): void;
}

const documentId = `doc-${browserDiagnosticUuid()}`;
const terminalNavigations = new WeakSet<BrowserNavigationDiagnostic>();
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
  if (!hot) return;
  try {
    hot.send(RANGO_BROWSER_NAVIGATION_EVENT, {
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
  } catch {}
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
    id: existingId ?? `nav-${browserDiagnosticUuid()}`,
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
  if (terminalNavigations.has(navigation)) return;
  terminalNavigations.add(navigation);
  emit(navigation.id, navigation.kind, "committed", navigation.pathname);
}

export function abortBrowserNavigationDiagnostic(
  navigation: BrowserNavigationDiagnostic,
  failed: boolean = false,
): void {
  if (terminalNavigations.has(navigation)) return;
  terminalNavigations.add(navigation);
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
  const metrics = navigation?.serverTiming;
  if (!metrics) return null;
  for (let index = metrics.length - 1; index >= 0; index--) {
    const metric = metrics[index];
    if (
      metric?.name === "rango-request-id" &&
      /^req-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        metric.description,
      )
    ) {
      return metric.description;
    }
  }
  return null;
}

export function installBrowserNavigationDiagnostics(
  channel: BrowserHotChannel,
  initialHref: string = window.location.href,
): void {
  hot = channel;
  const navigation = startBrowserNavigationDiagnostic("document", initialHref);
  linkBrowserNavigationRequest(navigation, initialRequestId(), "document");
  completeBrowserNavigationDiagnostic(navigation);
  registerBrowserNavigationDiagnostics({
    start: startBrowserNavigationDiagnostic,
    linkResponse: linkBrowserNavigationResponse,
    linkRequest: linkBrowserNavigationRequest,
    complete: completeBrowserNavigationDiagnostic,
    abort: abortBrowserNavigationDiagnostic,
  });
}
