# VITE-RSC Router Architecture: Complete Guide

## Overview

The vite-rsc router is a sophisticated Express/Hono-style routing system built for React Server Components (RSC). It enables:
- Full-page document loads (traditional Document requests)
- Partial page updates (SPA-like client-side navigation)
- Nested layouts with state preservation
- Automatic tree reconstruction on the client

The system is divided into three execution environments (rsc, ssr, client) and orchestrates data flow between them.

---

## Part 1: Core Architecture Overview

### Three Environments

The Vite config (`vite.config.ts`) defines three distinct build environments:

```
┌─────────────────────────────────────────────────────────────────┐
│                      VITE RSC ENVIRONMENTS                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  RSC Environment (Server-Side)                                   │
│  ├─ Loads modules with "react-server" condition                 │
│  ├─ Renders React VDOM to RSC stream                            │
│  ├─ Handles server functions & actions                          │
│  └─ Entry: entry.rsc.tsx                                        │
│                                                                   │
│  SSR Environment (Server-Side)                                   │
│  ├─ Loads modules WITHOUT "react-server" condition              │
│  ├─ Deserializes RSC stream to React VDOM                       │
│  ├─ Converts VDOM to HTML string/stream                         │
│  └─ Entry: entry.ssr.tsx                                        │
│                                                                   │
│  Client Environment (Browser-Side)                               │
│  ├─ Deserializes RSC stream in browser                          │
│  ├─ Hydrates DOM with deserialized VDOM                         │
│  ├─ Handles client-side navigation                              │
│  ├─ Fetches RSC payloads for SPA navigation                     │
│  └─ Entry: entry.browser.tsx                                    │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Part 2: Document Requests (Full Page Loads)

### 2.1 Request Flow for Document Requests

A **Document Request** occurs when:
- User directly navigates to a URL in the address bar
- User presses F5 to refresh
- No previous page metadata exists (first page load)

### 2.2 Flow Diagram

```
BROWSER → HTTP REQUEST → VITE SERVER
                           │
                           ├─→ [entry.rsc.tsx]
                           │   ├─ Routes.match(request)
                           │   ├─ Renders full component tree
                           │   └─ Serializes to RSC stream
                           │
                           ├─→ [entry.ssr.tsx]
                           │   ├─ Deserializes RSC stream
                           │   ├─ Renders to HTML stream
                           │   └─ Injects RSC payload as <script>
                           │
                           └─→ HTML Response
                               ├─ Full page HTML
                               ├─ RSC payload injected
                               └─ Bootstrap script loaded

BROWSER (HTML Loads) → [entry.browser.tsx]
├─ createFromReadableStream() reads injected RSC payload
├─ hydrateRoot() mounts React to DOM
└─ Browser app is ready
```

### 2.3 Code Flow

#### Step 1: Request Handler (entry.rsc.tsx)

```typescript
export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  
  // Check if this is a partial render request
  const isPartialRequest = url.searchParams.has("_rsc_partial");
  
  if (!isPartialRequest) {
    // Full page load - use complete router.match()
    const [component, segments] = await router.match(request);
    
    const rscPayload = {
      root: component,           // Full rendered tree
      metadata: {
        pathname: url.pathname,
        segments: segments        // All segments for reconstruction
      }
    };
    
    const rscStream = renderToReadableStream(rscPayload);
    
    // Check if HTML is requested
    if (request.headers.get("accept")?.includes("text/html")) {
      // Load SSR module to convert RSC stream to HTML
      const ssrModule = await import.meta.viteRsc.loadModule("ssr", "index");
      const htmlStream = await ssrModule.renderHTML(rscStream);
      return new Response(htmlStream, { headers: { "Content-type": "text/html" } });
    } else {
      // Return raw RSC stream for SPA navigation
      return new Response(rscStream, { headers: { "content-type": "text/x-component" } });
    }
  }
  // ... partial request handling covered in Section 3
}
```

#### Step 2: Router Matching (router.tsx)

The `router.match()` method recursively traverses the route tree:

```typescript
async match(request: Request): Promise<[ReactNode, Segment[]]> {
  const pathname = new URL(request.url).pathname;
  
  // Find all matching routes (including parent layouts)
  const matchedRoutes = this.findMatchingRoutes(pathname, "GET", this.routes);
  
  // Process from outermost to innermost
  let componentTree = null;
  let currentSegments = [];
  
  for (let i = matchedRoutes.length - 1; i >= 0; i--) {
    const { route } = matchedRoutes[i];
    
    for (const handler of route.handlers) {
      if (route.isLayout) {
        // Wrap current tree with OutletProvider
        const layoutComponent = await handler(context);
        componentTree = <OutletProvider content={componentTree}>
          {layoutComponent}
        </OutletProvider>;
        
        currentSegments.push({
          index: i,
          pattern: route.pattern,
          component: layoutComponent,
          isLayout: true
        });
      } else {
        // Execute page handler
        componentTree = await handler(context);
        
        currentSegments.push({
          index: i,
          pattern: route.pattern,
          component: componentTree,
          isLayout: false
        });
      }
    }
  }
  
  return [componentTree, currentSegments];
}
```

#### Step 3: SSR Rendering (entry.ssr.tsx)

```typescript
export async function renderHTML(
  rscStream: ReadableStream<Uint8Array>,
  options: { formState?, nonce?, debugNojs? }
) {
  // Split the RSC stream into two copies
  const [rscStream1, rscStream2] = rscStream.tee();
  
  // Deserialize RSC stream to React VDOM
  function SsrRoot() {
    const payload = createFromReadableStream(rscStream1);
    return <FixSsrThenable>{React.use(payload).root}</FixSsrThenable>;
  }
  
  // Render VDOM to HTML string/stream
  const htmlStream = await renderToReadableStream(<SsrRoot />, {
    bootstrapScriptContent: await import.meta.viteRsc.loadBootstrapScriptContent("index"),
    nonce: options.nonce,
    formState: options.formState
  });
  
  // Inject RSC payload into HTML as <script> tag
  return htmlStream.pipeThrough(
    injectRSCPayload(rscStream2, { nonce: options.nonce })
  );
}
```

#### Step 4: Browser Hydration (entry.browser.tsx)

```typescript
async function initializeApp() {
  // Read the RSC payload that was injected into the HTML
  const initialPayload = await createFromReadableStream(rscStream);
  
  // Reconstruct tree from segments if provided
  if (initialPayload.metadata?.segments) {
    initialPayload.root = reconstructTreeFromSegments(
      initialPayload.metadata.segments
    );
  }
  
  // Setup manager for future navigation
  const manager = {
    currentPathname: window.location.pathname,
    currentSegments: initialPayload.metadata?.segments || [],
    setPayload: null
  };
  
  // Setup navigation interception
  setupNavigationInterception(() => fetchRscPayload(manager));
  
  // Hydrate the app
  hydrateRoot(document, <BrowserRoot initialPayload={initialPayload} manager={manager} />, {
    formState: initialPayload.formState
  });
}
```

### 2.4 Key Points for Document Requests

1. **Full Tree Rendering**: `router.match()` returns the complete component tree with all layouts and the page
2. **Segment Metadata**: All segments are included in the RSC payload metadata for client reconstruction
3. **SSR to HTML**: The RSC stream is deserialized and re-serialized to HTML on the server
4. **Hydration**: The browser reads the injected RSC payload and hydrates the DOM without re-fetching

---

## Part 3: SPA Partial Requests (Client-Side Navigation)

### 3.1 What Makes a Partial Request

A **Partial Request** occurs when:
- User clicks a link on the page (intercepted by navigation listener)
- The navigation is to a DIFFERENT path
- Metadata from the initial load exists (not first page)
- The browser has `_rsc_partial=true` in query params

### 3.2 Request Flow for Partial Navigation

```
USER CLICKS LINK
├─ Link click intercepted (browser.tsx:153)
├─ history.pushState() updates URL
└─ Navigation listener triggers fetchRscPayload()

fetchRscPayload()
├─ Determines if partial is possible
│  └─ If same path OR no metadata: request FULL render
│  └─ If different path AND metadata exists: request PARTIAL render
│
├─ Creates fetch URL with _rsc_partial=true, _rsc_prev={old_path}
│
└─ Fetch to server → VITE SERVER

[entry.rsc.tsx]
├─ Detects isPartialRequest (has _rsc_partial param)
├─ Calls router.matchPartial(request, previousPathname)
│  ├─ Finds routes for NEW path
│  ├─ Finds routes for OLD path
│  ├─ Compares to find divergence point
│  └─ Returns ONLY changed segments
├─ Returns RSC stream with segments metadata
│  └─ metadata.isPartial = true
│
└─ RSC stream response (NOT HTML)

BROWSER receives partial response
├─ createFromFetch() deserializes RSC stream
├─ Detects payload.metadata.isPartial
├─ Calls processPayload()
│  ├─ Merges new segments with existing segments
│  ├─ Reconstructs tree from merged segments
│  └─ Updates manager state
└─ BrowserRoot state update → UI re-renders
```

### 3.3 Code Flow for Partial Requests

#### Step 1: Link Interception (entry.browser.tsx)

```typescript
function setupNavigationInterception(onNavigation: () => void) {
  // Listen for link clicks
  function handleClick(event: MouseEvent) {
    const link = (event.target as Element).closest("a");
    
    if (shouldInterceptLink(link, event)) {
      event.preventDefault();
      // Update browser history - this triggers navigation
      history.pushState(null, "", (link as HTMLAnchorElement).href);
      // Manually trigger navigation since we prevented default
      onNavigation();
    }
  }
  
  document.addEventListener("click", handleClick);
}

function shouldInterceptLink(link: Element | null, event: MouseEvent): boolean {
  return (
    link instanceof HTMLAnchorElement &&
    link.href &&
    link.origin === location.origin &&  // Same origin
    !event.metaKey &&                    // Not Cmd+click
    !event.ctrlKey &&                    // Not Ctrl+click
    event.button === 0                   // Left click only
  );
}
```

#### Step 2: Determine Request Type (entry.browser.tsx)

```typescript
function createFetchUrl(
  targetUrl: string,
  currentPathname: string,
  hasMetadata: boolean
): URL {
  const url = new URL(targetUrl, window.location.origin);
  const targetPathname = url.pathname;
  
  // Can only do partial if we have metadata from initial load
  // AND we're navigating to a different path
  const shouldAttemptPartial =
    currentPathname !== targetPathname && hasMetadata;
  
  if (shouldAttemptPartial) {
    url.searchParams.set("_rsc_partial", "true");
    url.searchParams.set("_rsc_prev", currentPathname);
    logger.info("→ Requesting PARTIAL render");
  } else {
    logger.info("→ Requesting FULL render");
  }
  
  return url;
}
```

#### Step 3: Server-Side Partial Matching (router.tsx)

The `matchPartial()` method finds the divergence point:

```typescript
async matchPartial(
  request: Request,
  previousPathname?: string | null
): Promise<{ segments, startIndex, preservedLayouts } | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;
  
  // Find matches for the NEW path
  const nextMatches = this.findMatchingRoutes(pathname, "GET", this.routes);
  
  if (nextMatches.length === 0) return null;
  
  // If we have a previous path, find where they diverge
  let divergenceIndex = 0;
  if (previousPathname) {
    const prevMatches = this.findMatchingRoutes(previousPathname, "GET", this.routes);
    
    // Find the index where routes differ
    for (let i = 0; i < Math.min(prevMatches.length, nextMatches.length); i++) {
      if (prevMatches[i].route !== nextMatches[i].route) {
        break;  // Different route, stop here
      }
      divergenceIndex++;
    }
  }
  
  // Build segments ONLY from divergence point onwards
  const segments = [];
  
  for (let i = divergenceIndex; i < nextMatches.length; i++) {
    const { route } = nextMatches[i];
    
    for (const handler of route.handlers) {
      if (route.isLayout) {
        const layoutComponent = await handler(context);
        segments.push({
          index: i,
          pattern: route.pattern,
          component: layoutComponent,
          isLayout: true
        });
      } else if (handler.length === 1) {  // Skip middleware
        const pageComponent = await handler(context);
        segments.push({
          index: i,
          pattern: route.pattern,
          component: pageComponent,
          isLayout: false
        });
      }
    }
  }
  
  return {
    segments,
    startIndex: divergenceIndex,
    preservedLayouts: prevMatches.slice(0, divergenceIndex).map(m => m.route.pattern)
  };
}
```

#### Step 4: Partial Response Handling (entry.rsc.tsx)

```typescript
if (isPartialRequest) {
  console.log(`>>> Attempting PARTIAL render`);
  
  const partialResult = await router.matchPartial(request, previousPathname);
  
  if (partialResult) {
    // Send only the changed segments
    const metadata = {
      pathname: url.pathname,
      startIndex: partialResult.startIndex,
      preservedLayouts: partialResult.preservedLayouts,
      isPartial: true,  // Flag for client
      segments: partialResult.segments
    };
    
    // Component is just a placeholder - segments will be used by client
    component = partialResult.segments.at(0)?.component || null;
    
    console.log(`✓ Partial render: ${partialResult.segments.length} segments from index ${partialResult.startIndex}`);
  } else {
    // Fallback to full render if partial fails
    const [_component, segments] = await router.match(request);
    component = _component;
    metadata = { pathname: url.pathname, segments };
  }
}

const rscPayload = { root: component, metadata };
const rscStream = renderToReadableStream(rscPayload);

// Return RSC stream directly (NOT HTML) - it's only sent to browser
return new Response(rscStream, {
  headers: { "content-type": "text/x-component;charset=utf-8" }
});
```

#### Step 5: Client-Side Segment Merging (entry.browser.tsx)

```typescript
function mergeSegments(
  currentSegments: Segment[],
  newSegments: Segment[],
  startIndex: number
): Segment[] {
  // Keep all segments before the divergence point
  const preservedSegments = currentSegments.filter((s) => s.index < startIndex);
  
  // Combine with new segments
  const mergedSegments = [...preservedSegments, ...newSegments];
  
  // Sort by index to maintain order
  mergedSegments.sort((a, b) => b.index - a.index);
  
  return mergedSegments;
}

function processPayload(manager: PayloadManager, payload: RscPayload) {
  if (payload.metadata?.isPartial && payload.metadata?.segments) {
    // Partial update: merge segments
    manager.currentSegments = mergeSegments(
      manager.currentSegments,
      payload.metadata.segments,
      payload.metadata.startIndex ?? 0
    );
    
    // Reconstruct tree from all merged segments
    payload.root = reconstructTreeFromSegments(manager.currentSegments);
  } else if (payload.metadata?.segments) {
    // Full update: replace all segments
    manager.currentSegments = payload.metadata.segments;
    payload.root = reconstructTreeFromSegments(manager.currentSegments);
  }
}
```

#### Step 6: Tree Reconstruction (entry.browser.tsx)

```typescript
function reconstructTreeFromSegments(segments: Segment[]): React.ReactNode {
  if (!segments || segments.length === 0) return null;
  
  // Sort segments by index descending (innermost to outermost)
  const sortedSegments = [...segments].sort((a, b) => b.index - a.index);
  
  // Build tree from innermost (page) to outermost (root layout)
  let tree = null;
  
  for (const segment of sortedSegments) {
    if (segment.isLayout) {
      // Wrap current tree with this layout
      tree = <OutletProvider content={tree}>
        {segment.component}
      </OutletProvider>;
    } else {
      // Start with the page component
      tree = segment.component;
    }
  }
  
  return tree;
}
```

### 3.4 Example: Partial Navigation Flow

**Scenario**: User is on `/dashboard` (with RootLayout + DashboardLayout + DashboardPage) and clicks link to `/dashboard/analytics`

```
Initial state:
  segments = [
    { index: 0, pattern: "/", isLayout: true, component: RootLayout },
    { index: 1, pattern: "/dashboard", isLayout: true, component: DashboardLayout },
    { index: 2, pattern: "/dashboard", isLayout: false, component: DashboardPage }
  ]

Server receives request with _rsc_partial=true, _rsc_prev=/dashboard

Router comparison:
  /dashboard matches:      [/, /dashboard, /dashboard]
  /dashboard/analytics matches: [/, /dashboard, /dashboard/analytics]
                                 ↑  ↑          ↑
                                 divergence point at index 2

Server returns segments:
  [ 
    { index: 2, pattern: "/dashboard/analytics", isLayout: false, component: DashboardAnalyticsPage }
  ]

Client merges:
  preservedSegments = segments.slice(0, 2)  // RootLayout, DashboardLayout
  newSegments = server response
  
  merged = [
    { index: 0, pattern: "/", isLayout: true, component: RootLayout },
    { index: 1, pattern: "/dashboard", isLayout: true, component: DashboardLayout },
    { index: 2, pattern: "/dashboard/analytics", isLayout: false, component: DashboardAnalyticsPage }
  ]

Reconstruct tree:
  DashboardAnalyticsPage (innermost)
    ↓ wrapped by
  OutletProvider with DashboardLayout
    ↓ wrapped by
  OutletProvider with RootLayout
```

**Result**: Only DashboardAnalyticsPage is re-rendered. DashboardLayout and RootLayout maintain their DOM state.

---

## Part 4: Segment System and Data Flow

### 4.1 What Are Segments?

Segments represent a flattened version of the component tree, indexed by their position in the route hierarchy:

```typescript
type Segment = {
  index: number;           // Position in route hierarchy (0=outermost)
  pattern: string;         // Route pattern (e.g., "/dashboard")
  component: React.ReactNode;  // The actual React component
  isLayout: boolean;       // Whether this is a layout or page
};
```

### 4.2 Why Segments Matter

Segments enable three key capabilities:

1. **Divergence Detection**: Find where routes changed by comparing segment indices
2. **Efficient Updates**: Send only changed segments over the network
3. **Client Reconstruction**: Client can rebuild the full tree without knowing the routing logic

### 4.3 Segment Flow Through the System

```
[Request] 
  ↓
[router.match() or router.matchPartial()]
  ↓ builds segments array
[RscPayload.metadata.segments]
  ↓ serialized to RSC stream
[Network → Browser]
  ↓ received by createFromFetch()
[Payload.metadata.segments]
  ↓ merged with existing segments
[manager.currentSegments]
  ↓ passed to reconstructTreeFromSegments()
[Reconstructed React tree]
  ↓
[Rendered DOM]
```

---

## Part 5: Server Rendering vs Client Reconstruction

### 5.1 Full Page Load: Server-Rendered Tree

Document requests use **server-side tree building**:

```
Server:
  1. Match routes
  2. Build component tree with OutletProvider wrapping
  3. Render to RSC stream
  4. Render RSC to HTML
  5. Inject RSC payload
  6. Send HTML with embedded RSC stream

Browser:
  1. Parse HTML
  2. Render DOM from HTML
  3. Extract RSC stream
  4. Hydrate React to DOM
  5. Attach event listeners
```

### 5.2 SPA Navigation: Client-Reconstructed Tree

SPA navigation uses **client-side tree building**:

```
Server:
  1. Match routes (new path)
  2. Compare with old path (partial matching)
  3. Build ONLY new segments from divergence point
  4. Return segments as metadata
  5. Return minimal component (just the changed part)

Browser:
  1. Receive segments
  2. Merge with existing segments
  3. Call reconstructTreeFromSegments()
  4. React re-renders the tree
  5. Outlet updates inject new content
```

### 5.3 Key Difference: Tree Building Location

```
Document Request:
  tree = OutletProvider(RootLayout, 
    OutletProvider(DashboardLayout,
      DashboardPage
    )
  )
  [Serialized and sent to client]

SPA Navigation:
  [Server sends]
  segments = [
    { DashboardLayout },
    { DashboardAnalyticsPage }
  ]
  
  [Client reconstructs]
  tree = OutletProvider(RootLayout,
    OutletProvider(DashboardLayout,
      DashboardAnalyticsPage
    )
  )
```

---

## Part 6: Outlet Pattern and Layout Preservation

### 6.1 Outlet Mechanism

The Outlet pattern is essential for preserving layout state during partial updates:

```typescript
// In RootLayout.tsx (server component)
export default function RootLayout() {
  return (
    <html>
      <body>
        <header>...</header>
        <main>
          <Outlet />  {/* This renders the nested content */}
        </main>
      </body>
    </html>
  );
}

// In DashboardLayout.tsx (server component)
export default function DashboardLayout() {
  return (
    <div>
      <Sidebar />
      <div><Outlet /></div>  {/* This renders the page */}
    </div>
  );
}
```

### 6.2 How Outlet is Wired

```typescript
// From entry.browser.tsx (reconstructing segments)
function reconstructTreeFromSegments(segments: Segment[]) {
  let tree = null;
  
  for (const segment of sortedSegments) {
    if (segment.isLayout) {
      // Wire this layout's Outlet to the current tree
      tree = <OutletProvider content={tree}>
        {segment.component}
      </OutletProvider>;
    } else {
      tree = segment.component;
    }
  }
  
  return tree;
}

// From Outlet.tsx (client component)
export function Outlet() {
  const content = useContext(OutletContext);
  return <>{content}</>;  // Renders what OutletProvider provides
}
```

### 6.3 Layout State Preservation

When navigating between `/dashboard` and `/dashboard/analytics`:

```
BEFORE:
  RootLayout context
    ↓
  DashboardLayout context (with sidebar state)
    ↓
  DashboardPage

AFTER (partial update):
  RootLayout context (PRESERVED - same DOM node)
    ↓
  DashboardLayout context (PRESERVED - same DOM node)
    ↓
  DashboardAnalyticsPage (REPLACED)

The sidebar in DashboardLayout:
  - Re-renders (new component instance)
  - But the containing div maintains its DOM state
  - CSS classes, focus, scroll position, etc. are preserved
```

---

## Part 7: Key Entry Points and Flow Summary

### 7.1 Three Entry Points

| File | Environment | Purpose | When Executed |
|------|-------------|---------|---------------|
| `entry.rsc.tsx` | RSC (Server) | Route matching, component rendering, RSC stream generation | Every request (full or partial) |
| `entry.ssr.tsx` | SSR (Server) | RSC deserialization, HTML generation, stream injection | Only for document requests |
| `entry.browser.tsx` | Client (Browser) | Hydration, navigation interception, partial updates | Browser load and navigation |

### 7.2 Complete Request Flow Chart

```
                    USER ACTION
                         │
            ┌────────────┴────────────┐
            │                         │
      Direct URL              Click Link
       (F5 Refresh)         (SPA Navigation)
            │                         │
            ├─ Document Request ──────┤
            │                         │
            └─→ Accept: text/html     └─→ Accept: application/json
                                          (or detect from browser)
                
                         HTTP REQUEST
                              │
                    [entry.rsc.tsx handler]
                              │
                    ┌─────────┴──────────┐
                    │                    │
            isPartial = false    isPartial = true
                    │                    │
            router.match()       router.matchPartial()
                    │                    │
            Full tree + segs    New segs + startIndex
                    │                    │
                    └─→ rscStream (same payload type)
                         │
            ┌────────────┴─────────────┐
            │                          │
       Text/HTML Response        RSC Response
       (document request)        (SPA navigation)
            │                          │
            └─→ [entry.ssr.tsx] ──────┘
                 │
            Render HTML
            + Inject RSC
                 │
          HTML + RSC Stream
                 │
              BROWSER
                 │
         [entry.browser.tsx]
                 │
        ┌────────┴──────────┐
        │                   │
    Initial Load         Navigation
        │                   │
    createFromReadableStream  createFromFetch
        │                   │
    Reconstruct tree    Merge segments
        │                   │
    hydrateRoot()       setPayload() trigger
        │                   │
    Ready to use        UI updated
```

### 7.3 Router Method Summary

| Method | When Called | What It Does | Returns |
|--------|------------|--------------|---------|
| `router.match(request)` | Document requests, partial fallback | Matches request to routes, builds full tree | `[component, segments]` |
| `router.matchPartial(request, prev)` | Partial navigation requests | Finds divergence point, builds minimal tree | `{ segments, startIndex, preservedLayouts }` or `null` |
| `findMatchingRoutes(pathname)` | Internal to both | Recursively finds all matching route handlers | Array of `{ route, params }` |

---

## Part 8: Request Handling Deep Dive

### 8.1 Request Parameter Guide

```typescript
// Query parameters that control behavior:

_rsc_partial=true
  └─ Browser set this, tells server to attempt partial render
  └─ Server can ignore if partial matching fails (fallback to full)

_rsc_prev=/old/path
  └─ Browser set this, tells server the previous pathname
  └─ Server uses this to find divergence point
  
__rsc
  └─ Browser developer set this (via ?__rsc in URL)
  └─ Forces RSC response (not HTML) even for document requests
  
__html
  └─ Browser developer set this
  └─ Forces HTML response even for RSC clients

__nojs
  └─ Browser developer set this
  └─ Disables JavaScript bootstrap for testing no-JS scenarios
```

### 8.2 Content Type Detection

```typescript
const isRscRequest =
  (!request.headers.get("accept")?.includes("text/html") &&
   !url.searchParams.has("__html")) ||
  url.searchParams.has("__rsc");

if (isRscRequest) {
  // Return RSC stream directly
  return new Response(rscStream, {
    headers: { "content-type": "text/x-component;charset=utf-8" }
  });
} else {
  // Return HTML (document request)
  // Need to call SSR module for HTML rendering
  const htmlStream = await ssrModule.renderHTML(rscStream);
  return new Response(htmlStream, {
    headers: { "content-type": "text/html" }
  });
}
```

### 8.3 Server Function Handling

Server functions (POST requests with `x-rsc-action` header) are handled before routing:

```typescript
const isAction = request.method === "POST";

if (isAction) {
  const actionId = request.headers.get("x-rsc-action");
  
  if (actionId) {
    // Server function call from client component
    const body = await request.text();
    const args = await decodeReply(body, { temporaryReferences });
    const action = await loadServerAction(actionId);
    returnValue = await action.apply(null, args);
  } else {
    // Form submission before hydration (progressive enhancement)
    const formData = await request.formData();
    const decodedAction = await decodeAction(formData);
    const result = await decodedAction();
    formState = await decodeFormState(result, formData);
  }
}

// Then proceed with normal routing and rendering
// The new render will reflect the updated state
```

---

## Part 9: Storage and Async Context

### 9.1 AsyncLocalStorage Usage

The `entry.storage.ts` provides context for the request:

```typescript
// entry.storage.ts
import { AsyncLocalStorage } from "async_hooks";
const Storage = new AsyncLocalStorage();
export { Storage };
```

This is used to pass request-specific data through the async call stack:

```typescript
// entry.rsc.tsx
export default async function handler(request: Request): Promise<Response> {
  const streams = [];
  
  return await Storage.run(streams, () => _handler(request));
}

// This allows _handler and all functions it calls to access `streams`
// via Storage.getStore()
```

The `streams` array can be used to collect async resources that need to be:
- Injected into the HTML
- Tracked for cleanup
- Passed to SSR module

---

## Part 10: Summary Tables

### 10.1 Data Flow by Request Type

#### Document Request (First Load or F5)

```
Browser HTTP Request
  ├─ Headers: Accept: text/html
  ├─ Query: (none)
  └─ Path: /dashboard

[entry.rsc.tsx]
  ├─ isPartialRequest = false
  ├─ router.match()
  └─ Segments: All (0 to N)

[entry.ssr.tsx]
  ├─ Deserialize RSC stream
  ├─ Render to HTML
  └─ Inject RSC stream as <script>

HTTP Response: text/html
  ├─ Full page HTML
  ├─ Embedded RSC stream
  └─ Bootstrap script

[entry.browser.tsx]
  ├─ Read RSC stream from page
  ├─ Reconstruct tree
  └─ hydrateRoot()
```

#### SPA Navigation (Link Click)

```
Browser Fetch
  ├─ Headers: Accept: application/json (or omit)
  ├─ Query: _rsc_partial=true&_rsc_prev=/dashboard
  └─ Path: /dashboard/analytics

[entry.rsc.tsx]
  ├─ isPartialRequest = true
  ├─ router.matchPartial(request, "/dashboard")
  │  ├─ nextMatches: [/, /dashboard, /dashboard/analytics]
  │  ├─ prevMatches: [/, /dashboard]
  │  └─ divergenceIndex: 2
  └─ Segments: Only changed (index 2+)

HTTP Response: text/x-component
  ├─ RSC stream
  ├─ metadata.segments: [DashboardAnalyticsPage]
  ├─ metadata.startIndex: 2
  └─ metadata.isPartial: true

[entry.browser.tsx]
  ├─ processPayload()
  ├─ mergeSegments()
  │  └─ Keep [RootLayout, DashboardLayout] + new [DashboardAnalyticsPage]
  ├─ reconstructTreeFromSegments()
  └─ setPayload() triggers re-render
```

### 10.2 Component Classification

| File | Type | When | Rendered |
|------|------|------|----------|
| `RootLayout.tsx` | Layout (Server) | Every request | Both document and SPA |
| `DashboardLayout.tsx` | Layout (Server) | /dashboard/* requests | Both document and SPA |
| `DashboardPage.tsx` | Page (Server) | /dashboard requests | Both document and SPA |
| `Outlet.tsx` | Client Component | Browser | Never sent to server |
| `Link.tsx` | Client Component | Browser | Never sent to server |

### 10.3 Metadata Structure Evolution

```
Initial Load (document request):
{
  pathname: "/dashboard",
  segments: [
    { index: 0, pattern: "/", component: RootLayout, isLayout: true },
    { index: 1, pattern: "/dashboard", component: DashboardLayout, isLayout: true },
    { index: 2, pattern: "/dashboard", component: DashboardPage, isLayout: false }
  ]
}

After Navigation to /dashboard/analytics (partial response):
{
  pathname: "/dashboard/analytics",
  startIndex: 2,
  preservedLayouts: ["/", "/dashboard"],
  isPartial: true,
  segments: [
    { index: 2, pattern: "/dashboard/analytics", component: DashboardAnalyticsPage, isLayout: false }
  ]
}

Client merges to:
{
  pathname: "/dashboard/analytics",
  segments: [
    { index: 0, pattern: "/", component: RootLayout, isLayout: true },
    { index: 1, pattern: "/dashboard", component: DashboardLayout, isLayout: true },
    { index: 2, pattern: "/dashboard/analytics", component: DashboardAnalyticsPage, isLayout: false }
  ]
}
```

---

## Part 11: Advanced Concepts

### 11.1 Divergence Detection Algorithm

The core of partial rendering is finding where routes diverge:

```typescript
for (let i = 0; i < Math.min(prevMatches.length, nextMatches.length); i++) {
  // Compare route objects by reference
  if (prevMatches[i].route !== nextMatches[i].route) {
    break;  // Found divergence
  }
  divergenceIndex++;
}
```

This works because:
- Route objects are singletons (created once, reused)
- Comparing by reference is O(1) and reliable
- Found index indicates first changed route level

Example:
```
/dashboard         → [RootRoute, DashboardRoute, DashboardPageRoute]
/dashboard/page/:id → [RootRoute, DashboardRoute, DashboardArticleRoute]
                                               ↑ divergence at index 2
```

### 11.2 Fallback to Full Render

Partial rendering can fail if:
- Previous pathname not provided
- No matching routes found
- Server can't determine divergence point

When this happens:
```typescript
if (partialResult) {
  // Use partial result
} else {
  // Fallback to full render
  const [component, segments] = await router.match(request);
  // Return full tree like a document request
}
```

This ensures stability - worst case is a full re-render (like a page refresh).

### 11.3 Route Compilation

Routes are compiled once at router setup:

```typescript
private compileRoute(route: Route) {
  const paramNames: string[] = [];
  
  // Convert Express-style "/articles/:id" to regex "^/articles/([^/]+)$"
  const regexPattern = route.pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        return "([^/]+)";  // Matches any characters except /
      }
      if (segment === "*") {
        paramNames.push("*");
        return "(.*)";  // Matches everything
      }
      return segment;  // Literal text
    })
    .join("/");
  
  route.regex = new RegExp(`^${regexPattern}$`);
  route.paramNames = paramNames;
}
```

---

## Conclusion

The vite-rsc router is a sophisticated system that:

1. **Handles Document Requests** by rendering the full component tree on the server, converting it to HTML with embedded RSC stream, and hydrating in the browser

2. **Handles SPA Navigation** by:
   - Intercepting link clicks on the client
   - Detecting partial rendering opportunity
   - Comparing routes to find divergence point
   - Sending only changed components
   - Merging segments on the client
   - Reconstructing the tree using the Outlet pattern
   - Preserving layout state through OutletProvider

3. **Leverages Segments** as a transport-agnostic way to describe the component tree that allows the client to reconstruct it without knowing routing logic

4. **Uses the Outlet Pattern** to preserve layout state and DOM nodes during partial updates

5. **Maintains Flexibility** with fallback to full renders and support for both progressive enhancement and SPA navigation

This design achieves the best of both worlds: server-rendered SEO-friendly pages with SPA-like navigation performance and state preservation.
