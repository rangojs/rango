# Vite-RSC Router: Quick Reference Guide

## Core Concept

A sophisticated Express/Hono-style router that:
- Renders React components on the server
- Serializes them to RSC (React Server Components) streams
- Handles both traditional full-page loads AND SPA-like navigation
- Preserves layout state during partial updates

---

## Request Types at a Glance

### Document Request (Full Page Load)
```
USER: Types URL in address bar or presses F5
       ↓
SERVER: Calls router.match() → returns full tree
       ↓
SERVER: Converts RSC to HTML, injects RSC stream as <script>
       ↓
BROWSER: Parses HTML, hydrates React, reads RSC stream
       ↓
APP: Ready with full state
```

**When it happens:** First page load, F5 refresh, direct navigation
**Server response:** HTML with embedded RSC payload
**Client action:** `hydrateRoot()` to mount React

### SPA Partial Request (Navigation)
```
USER: Clicks a link on the page
       ↓
BROWSER: Prevents default, updates URL with history.pushState()
       ↓
BROWSER: Fetches with _rsc_partial=true, _rsc_prev={old_path}
       ↓
SERVER: Calls router.matchPartial() → returns ONLY changed segments
       ↓
BROWSER: Merges segments, reconstructs tree from all segments
       ↓
BROWSER: React re-renders the updated tree
       ↓
UI: Updated with preserved layout state
```

**When it happens:** User clicks internal links, already has metadata
**Server response:** RSC stream with only new/changed segments
**Client action:** `mergeSegments()` + `reconstructTreeFromSegments()`

---

## The Three Environments

```javascript
// vite.config.ts

// RSC Environment: Renders React to RSC stream
// - Executes server components
// - Returns serialized component tree
// - Entry: entry.rsc.tsx
environments: { rsc: { input: "entry.rsc.tsx" } }

// SSR Environment: Converts RSC to HTML
// - Deserializes RSC stream
// - Renders to HTML string
// - Injects RSC as <script>
// - Entry: entry.ssr.tsx
environments: { ssr: { input: "entry.ssr.tsx" } }

// Client Environment: Browser execution
// - Hydrates and manages UI
// - Intercepts navigation
// - Fetches RSC for SPA navigation
// - Entry: entry.browser.tsx
environments: { client: { input: "entry.browser.tsx" } }
```

---

## Routing Configuration

### Define Routes

```typescript
// src/routes.tsx
import { RscRouter } from "rsc-router/server";

const router = new RscRouter();

// Root layout wraps everything
router.layout("/", (ctx) => <RootLayout />);

// Dashboard section
router.layout("/dashboard", (ctx) => <DashboardLayout />);
  router.get("/dashboard", (ctx) => <DashboardPage />);
  router.get("/dashboard/analytics", (ctx) => <DashboardAnalyticsPage />);
router.endLayout();

// Articles section
router.layout("/articles", (ctx) => <ArticlesLayout />);
  router.get("/articles", (ctx) => <ArticlesListPage />);
  router.get("/articles/:id", (ctx) => <ArticleDetailPage id={ctx.params.id} />);
router.endLayout();

// Home
router.get("/", (ctx) => <HomePage />);

// About (uses root layout only)
router.get("/about", (ctx) => <AboutPage />);

// 404
router.all("*", (ctx) => <NotFoundPage />);
```

### How Layout Nesting Works

```
Route structure:
  / (root layout)
    ├─ /dashboard (dashboard layout)
    │  ├─ /dashboard (page)
    │  ├─ /dashboard/analytics (page)
    │  ├─ /dashboard/settings (page)
    │
    ├─ /articles (articles layout)
    │  ├─ /articles (page)
    │  ├─ /articles/:id (page)
    │
    ├─ / (home page, only root layout)
    ├─ /about (about page, only root layout)
    └─ * (404 page, no layout)

Navigation from /dashboard to /articles:
  BEFORE:  RootLayout → DashboardLayout → DashboardPage
  AFTER:   RootLayout → ArticlesLayout → ArticlesListPage
           
  Changed at index 1 (the layout changed)
  Server sends only ArticlesLayout + ArticlesListPage
  RootLayout preserved (same DOM, same state)
```

---

## The Segments System

### What's a Segment?

```typescript
type Segment = {
  index: number;        // 0=outermost (root), 1, 2, ... =innermost (page)
  pattern: string;      // "/dashboard", "/articles/:id", etc.
  component: ReactNode; // The actual JSX component
  isLayout: boolean;    // true for layouts, false for pages
};
```

### How Segments Flow

```
1. router.match() or router.matchPartial()
   └─ Builds array of segments

2. Serialized in RscPayload.metadata.segments
   └─ Sent to client in RSC stream

3. Browser receives segments
   └─ Merged with existing segments (for SPA nav)

4. reconstructTreeFromSegments(segments)
   ├─ Sort by index descending (innermost first)
   ├─ Wrap each layout around previous content with OutletProvider
   └─ Returns full React tree

5. React renders the tree
   └─ Outlet components inject nested content via context
```

### Example: Segments in Action

```typescript
// Initial load: /dashboard
segments = [
  { index: 0, pattern: "/", component: RootLayout, isLayout: true },
  { index: 1, pattern: "/dashboard", component: DashboardLayout, isLayout: true },
  { index: 2, pattern: "/dashboard", component: DashboardPage, isLayout: false }
]

// Click link to /dashboard/analytics (partial request)
// Server detects divergence at index 2 (first different segment)
// Server sends only:
newSegments = [
  { index: 2, pattern: "/dashboard/analytics", component: DashboardAnalyticsPage, isLayout: false }
]

// Browser merges:
merged = [
  { index: 0, ... RootLayout ... },
  { index: 1, ... DashboardLayout ... },
  { index: 2, ... DashboardAnalyticsPage ... }  // NEW!
]

// Browser reconstructs tree:
tree = OutletProvider(
  RootLayout,
  OutletProvider(
    DashboardLayout,
    DashboardAnalyticsPage
  )
)
```

---

## Navigation Flow Details

### Browser Entry Point: entry.browser.tsx

```typescript
// 1. Initial load
const initialPayload = await createFromReadableStream(rscStream);
const manager = {
  currentPathname: "/dashboard",
  currentSegments: initialPayload.metadata.segments,
  setPayload: null
};

// 2. Setup navigation interception
setupNavigationInterception(() => fetchRscPayload(manager));

// 3. Hydrate the app
hydrateRoot(document, <BrowserRoot initialPayload={initialPayload} manager={manager} />);

// 4. When user clicks link
// - Link click detected
// - history.pushState() updates URL
// - fetchRscPayload() is called
// - Fetch is sent with _rsc_partial=true, _rsc_prev={old_path}
// - Response processed with mergeSegments() + reconstructTreeFromSegments()
// - setPayload(newPayload) triggers React re-render
```

### Server Entry Point: entry.rsc.tsx

```typescript
const isPartialRequest = url.searchParams.has("_rsc_partial");
const previousPathname = url.searchParams.get("_rsc_prev");

if (isPartialRequest && previousPathname) {
  // Attempt partial render
  const result = await router.matchPartial(request, previousPathname);
  
  if (result) {
    // Send only new segments
    metadata = {
      pathname: url.pathname,
      startIndex: result.startIndex,      // Where to start inserting
      isPartial: true,                     // Flag for client
      segments: result.segments            // ONLY the changed parts
    };
  } else {
    // Fallback to full render if partial fails
    const [component, segments] = await router.match(request);
    metadata = { pathname: url.pathname, segments };
  }
} else {
  // Full page render
  const [component, segments] = await router.match(request);
  metadata = { pathname: url.pathname, segments };
}

// Serialize to RSC stream
const payload = { root: component, metadata };
const rscStream = renderToReadableStream(payload);

// Decide response type
if (request.headers.get("accept")?.includes("text/html")) {
  // Document request: render HTML
  const htmlStream = await ssrModule.renderHTML(rscStream);
  return new Response(htmlStream, { headers: { "content-type": "text/html" } });
} else {
  // SPA request: return RSC directly
  return new Response(rscStream, { headers: { "content-type": "text/x-component" } });
}
```

---

## Key Files Map

| File | Purpose | Key Functions |
|------|---------|----------------|
| `src/routes.tsx` | Route definitions | Define layout/page routes |
| `src/framework/router/router.tsx` | Router logic | `match()`, `matchPartial()`, `findMatchingRoutes()` |
| `src/framework/entry.rsc.tsx` | RSC handler | Route matching, RSC serialization |
| `src/framework/entry.ssr.tsx` | SSR handler | HTML rendering, RSC deserialization |
| `src/framework/entry.browser.tsx` | Browser logic | Hydration, navigation, partial updates |
| `src/framework/router/Outlet.tsx` | Layout nesting | `Outlet`, `OutletProvider` (client components) |
| `src/layouts/*.tsx` | Layout components | Contain `<Outlet />` for nested content |
| `src/pages/*.tsx` | Page components | Leaf nodes in route tree |

---

## Divergence Detection

The key algorithm that enables partial rendering:

```typescript
// router.matchPartial()

// Find which routes match the new path
const nextMatches = findMatchingRoutes(newPath);

// Find which routes matched the old path
const prevMatches = findMatchingRoutes(oldPath);

// Compare them to find where they diverge
let divergenceIndex = 0;
for (let i = 0; i < Math.min(prevMatches.length, nextMatches.length); i++) {
  if (prevMatches[i].route !== nextMatches[i].route) {
    break;  // Routes differ here
  }
  divergenceIndex++;
}

// Return segments ONLY from divergence point onwards
// Everything before divergenceIndex is preserved
```

### Example

```
Old route: /dashboard/settings
  Matches: [RootRoute, DashboardRoute, SettingsPageRoute]

New route: /dashboard/analytics
  Matches: [RootRoute, DashboardRoute, AnalyticsPageRoute]

Comparison:
  [0] RootRoute === RootRoute ✓
  [1] DashboardRoute === DashboardRoute ✓
  [2] SettingsPageRoute !== AnalyticsPageRoute ✗ DIVERGE!

divergenceIndex = 2

Server sends:
  - Preserve: segments[0:2] (RootLayout, DashboardLayout)
  - Send: segments[2:] (AnalyticsPageRoute)
```

---

## Outlet Pattern: The Key to Layout Preservation

### How It Works

```typescript
// Layouts define an Outlet:
export default function DashboardLayout() {
  return (
    <div className="dashboard">
      <Sidebar />
      <main>
        <Outlet />  {/* This gets replaced with nested content */}
      </main>
    </div>
  );
}

// Client reconstruction wires the Outlet:
function reconstructTreeFromSegments(segments) {
  let tree = <DashboardAnalyticsPage />;
  
  tree = <OutletProvider content={tree}>
    <DashboardLayout />
  </OutletProvider>;
  
  // Now DashboardLayout's <Outlet /> renders the page
  // But DashboardLayout itself is a different instance
}

// OutletProvider provides content via context:
export function Outlet() {
  const content = useContext(OutletContext);
  return <>{content}</>;
}
```

### Why This Preserves State

When navigating `/dashboard` → `/dashboard/analytics`:

1. DashboardLayout re-renders (new component instance)
2. But its DOM node remains the same (React reconciliation)
3. Sidebar state within the DOM is preserved
4. Only the `<Outlet />` changes to show AnalyticsPage

---

## Query Parameters for Development

```
?__rsc
  Force RSC response instead of HTML
  Useful: View raw RSC payload structure
  Example: http://localhost:5173/?__rsc

?__html
  Force HTML response instead of RSC
  Useful: View HTML with debug info
  Example: http://localhost:5173/?__html

?__nojs
  Disable JavaScript bootstrap
  Useful: Test progressive enhancement (form submission without JS)
  Example: http://localhost:5173/?__nojs
```

---

## Request Headers: Content Negotiation

```typescript
// Document Request (User navigation, F5 refresh)
Headers: {
  "Accept": "text/html,application/xhtml+xml,..."  // Browser default
}
Response: HTML with embedded RSC stream

// SPA Navigation (Fetch from JavaScript)
Headers: {
  "Accept": "application/json"  // Or omitted
}
Response: RSC stream only (no HTML)
```

---

## Common Navigation Scenarios

### Scenario 1: User types URL in address bar
```
Browser: Regular HTTP request with Accept: text/html
Server:  router.match() → full tree
Response: HTML + embedded RSC
Client:  hydrateRoot() on received HTML
```

### Scenario 2: User clicks internal link
```
Browser: Prevented by listener, fetch with _rsc_partial=true
Server:  router.matchPartial() → only new segments
Response: RSC with segments metadata and isPartial=true
Client:  mergeSegments() + reconstructTreeFromSegments()
```

### Scenario 3: User presses browser back/forward
```
Browser: popstate event triggers navigation listener
Client:  Same as scenario 2 (sends _rsc_partial request)
```

### Scenario 4: First time on page, click link
```
Browser: Has metadata from initial load
Client:  Can do partial request
Server:  Partial matching possible
Result:  Efficient partial update
```

### Scenario 5: Navigate to completely different section
```
Route:   /dashboard/analytics → /articles/42
Server:  Divergence at index 1 (dashboard layout → articles layout)
Send:    ArticlesLayout + ArticlePage
Client:  Update DashboardLayout → ArticlesLayout + RootLayout stays same
```

---

## Debugging Tips

### Enable console logging
The browser entry (`entry.browser.tsx`) has extensive logging:
```
[Browser] ============ NAVIGATION ============
[Browser] From: /dashboard
[Browser] To: /dashboard/analytics
[Browser] → Requesting PARTIAL render
```

The server entry (`entry.rsc.tsx`) also logs:
```
[Entry.RSC] ==================== REQUEST ====================
[Entry.RSC] URL: /dashboard/analytics?_rsc_partial=true&_rsc_prev=/dashboard
[Entry.RSC] Is partial: true
[Entry.RSC] >>> Attempting PARTIAL render
[Entry.RSC] ✓ Partial render successful
[Entry.RSC]   Start index: 2
[Entry.RSC]   Segments sent: 1
```

### View RSC payload directly
Visit `http://localhost:5173/?__rsc` to see the raw RSC serialization format

### Test without JavaScript
Visit `http://localhost:5173/?__nojs` to verify progressive enhancement (forms work without JS)

---

## Mental Model Summary

Think of the router as:

1. **Route Matcher**: Finds which handlers (layouts + page) apply to a URL
2. **Component Builder**: Wraps components with OutletProvider to create tree
3. **Segment Generator**: Converts tree to flat array of segments (for transport)
4. **Divergence Detector**: Finds what changed between two routes
5. **Serializer**: Converts tree/segments to RSC stream for network
6. **Deserializer & Reconstructor**: Client reads segments and rebuilds tree

The genius is: **Segments are transport-agnostic** - they're just a description of the component tree that the client can understand without knowing any routing logic.
