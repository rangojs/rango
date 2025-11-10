# Vite-RSC Router: Visual Diagrams

## 1. Complete Request Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        USER INTERACTION                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  SCENARIO A: Document Request         │  SCENARIO B: SPA Navigation      │
│  (Address bar, F5, First load)        │  (Click link)                    │
│                                       │                                  │
└─────────────────────────────────────────────────────────────────────────┘
              │                                       │
              ▼                                       ▼
    HTTP GET /page                          fetch /page?_rsc_partial=true
    Accept: text/html                       _rsc_prev=/oldpage
              │                                       │
              └───────────────┬───────────────────────┘
                              ▼
                    ┌──────────────────────┐
                    │  entry.rsc.tsx       │
                    │  (RSC Environment)   │
                    └──────────────────────┘
                              │
                    ┌─────────┴──────────┐
                    ▼                    ▼
            isPartial=false        isPartial=true
                    │                    │
            router.match()         router.matchPartial()
                    │                    │
        ┌───────────────────────┐ ┌──────────────────┐
        │ Full component tree   │ │ Only new segments│
        │ with all layouts      │ │ from divergence  │
        │ and page              │ │ point            │
        └───────────────────────┘ └──────────────────┘
                    │                    │
          ┌─────────┴────────┬──────────┘
          │                  │
          │        ┌─────────────────────────────┐
          │        │  RscPayload created:        │
          │        │  - root: component/segments │
          │        │  - metadata.segments: []    │
          │        │  - metadata.isPartial: bool │
          │        │  - metadata.startIndex: num │
          │        └─────────────────────────────┘
          │                  │
          │       renderToReadableStream()
          │                  │
          ▼                  ▼
    ┌──────────────────────────────────────┐
    │  Is Accept: text/html?               │
    │  (Content negotiation)               │
    └──────────────────────────────────────┘
          │                  │
      YES │                  │ NO
          ▼                  ▼
    ┌─────────────────┐  ┌──────────────────┐
    │ entry.ssr.tsx   │  │ Return RSC       │
    │ (SSR Env)       │  │ text/x-component │
    │                 │  │ to browser       │
    │ - Deserialize   │  └──────────────────┘
    │   RSC stream    │         │
    │ - Render to     │         ▼
    │   HTML          │   ┌─────────────────────────┐
    │ - Inject RSC    │   │  entry.browser.tsx      │
    │   as <script>   │   │  (Client Environment)   │
    └─────────────────┘   │                         │
          │               │ createFromFetch()       │
          │               │ mergeSegments()         │
          ▼               │ reconstructTree()       │
    ┌──────────────────┐  │ setPayload()            │
    │ text/html        │  │ → State update          │
    │ + embedded RSC   │  │ → Re-render             │
    └──────────────────┘  └─────────────────────────┘
          │                         │
          ▼                         ▼
    ┌──────────────────┐  ┌──────────────────┐
    │ Browser HTML     │  │ React updates    │
    │ parsing          │  │ the DOM           │
    │                  │  │                  │
    │ hydrateRoot()    │  │ Only changed     │
    │ mounts React     │  │ segments render  │
    │                  │  │                  │
    │ Ready to use     │  │ Layout state     │
    │                  │  │ preserved        │
    └──────────────────┘  └──────────────────┘
          │                         │
          └────────────┬────────────┘
                       ▼
            ┌──────────────────────────┐
            │   User Interactive App    │
            │   Ready for next action   │
            └──────────────────────────┘
```

## 2. Segment Lifecycle

```
┌────────────────────────────────────────────────────────────────────┐
│                    SEGMENT FLOW DIAGRAM                             │
└────────────────────────────────────────────────────────────────────┘

Route Definition:
┌──────────────────────────────────────────┐
│ router.layout("/", RootLayout)           │
│   router.layout("/dashboard", Dashboard) │
│     router.get("/dashboard", DashPage)   │
│   router.endLayout()                     │
│   router.get("/", HomePage)              │
│ router.endLayout()                       │
└──────────────────────────────────────────┘
         │
         ▼
Routing Tree:
┌──────────────────────────────────────────┐
│ / (layout, index 0)                      │
│  ├─ /dashboard (layout, index 1)         │
│  │  └─ /dashboard (page, index 2)        │
│  └─ / (page, index 1 or 2 depending)     │
└──────────────────────────────────────────┘
         │
         ▼
URL: /dashboard/analytics

Match Routes:
┌──────────────────────────────────────────┐
│ Matched: [/, /dashboard, /dashboard]     │
└──────────────────────────────────────────┘
         │
         ▼
Create Segments:
┌──────────────────────────────────────────┐
│ [                                        │
│   {                                      │
│     index: 0,                            │
│     pattern: "/",                        │
│     component: <RootLayout />,           │
│     isLayout: true                       │
│   },                                     │
│   {                                      │
│     index: 1,                            │
│     pattern: "/dashboard",               │
│     component: <DashboardLayout />,      │
│     isLayout: true                       │
│   },                                     │
│   {                                      │
│     index: 2,                            │
│     pattern: "/dashboard/analytics",     │
│     component: <AnalyticsPage />,        │
│     isLayout: false                      │
│   }                                      │
│ ]                                        │
└──────────────────────────────────────────┘
         │
         ▼
RscPayload.metadata.segments
         │
         ▼
Serialize to RSC Stream
         │
         ▼
Network Transfer
         │
         ▼
Browser Receives (for SPA navigation)
         │
         ▼
mergeSegments(currentSegments, newSegments, startIndex)
├─ Keep segments before startIndex (e.g., [0, 1])
├─ Add new segments from server (e.g., [2])
└─ Result: Complete segment array
         │
         ▼
reconstructTreeFromSegments(mergedSegments)
├─ Sort by index descending (innermost first)
├─ Build from page upward:
│  ├─ Start: <AnalyticsPage />
│  ├─ Wrap: <OutletProvider content={...}><DashboardLayout /></OutletProvider>
│  └─ Wrap: <OutletProvider content={...}><RootLayout /></OutletProvider>
└─ Result: Full component tree
         │
         ▼
React Renders Tree
         │
         ▼
Outlet Components Inject Content
         │
         ▼
Updated DOM
```

## 3. Divergence Detection Algorithm

```
┌─────────────────────────────────────────────────────────────────┐
│                  FINDING THE DIVERGENCE POINT                   │
└─────────────────────────────────────────────────────────────────┘

Previous Path: /dashboard/settings
Current Path:  /dashboard/analytics

Step 1: Find Previous Matches
┌──────────────────────────────────────┐
│ /dashboard/settings matches:         │
│ [                                    │
│   { route: RootRoute },              │
│   { route: DashboardRoute },         │
│   { route: SettingsPageRoute }       │
│ ]                                    │
└──────────────────────────────────────┘
         │
         ▼
Step 2: Find Current Matches
┌──────────────────────────────────────┐
│ /dashboard/analytics matches:        │
│ [                                    │
│   { route: RootRoute },              │
│   { route: DashboardRoute },         │
│   { route: AnalyticsPageRoute }      │ ← Different!
│ ]                                    │
└──────────────────────────────────────┘
         │
         ▼
Step 3: Compare Route Objects
┌──────────────────────────────────────┐
│ for (i = 0; i < 3; i++)              │
│   [0] RootRoute === RootRoute ✓      │
│       divergenceIndex = 1            │
│                                      │
│   [1] DashboardRoute === DashboardRoute ✓
│       divergenceIndex = 2            │
│                                      │
│   [2] SettingsPageRoute !== AnalyticsPageRoute ✗
│       BREAK! divergence found        │
│       divergenceIndex = 2 (final)    │
└──────────────────────────────────────┘
         │
         ▼
Step 4: Extract Segments
┌──────────────────────────────────────┐
│ Preserve: segments before index 2    │
│ [                                    │
│   { index: 0, RootLayout },          │
│   { index: 1, DashboardLayout }      │
│ ]                                    │
│                                      │
│ Render: segments from index 2 onward │
│ [                                    │
│   { index: 2, AnalyticsPage }        │
│ ]                                    │
└──────────────────────────────────────┘
         │
         ▼
Step 5: Return Result
┌──────────────────────────────────────┐
│ {                                    │
│   segments: [AnalyticsPage],         │
│   startIndex: 2,                     │
│   preservedLayouts: ["/", "/dash"]   │
│ }                                    │
└──────────────────────────────────────┘
```

## 4. Layout State Preservation

```
┌─────────────────────────────────────────────────────────────────┐
│          HOW OUTLET PRESERVES LAYOUT STATE                       │
└─────────────────────────────────────────────────────────────────┘

Initial State: /dashboard
┌─────────────────────────────────────┐
│ RootLayout                          │
│  ├─ header                          │
│  ├─ main                            │
│  │  └─ DashboardLayout              │ 🔐 State:
│  │     ├─ sidebar (expanded)        │    - sidebarOpen = true
│  │     │  └─ [menu items]           │    - selectedTab = 0
│  │     └─ main                      │
│  │        └─ <Outlet />             │
│  │           └─ DashboardPage       │
│  └─ footer                          │
└─────────────────────────────────────┘
         │
         ▼
User Clicks /dashboard/analytics Link
         │
         ▼
Browser:
  1. history.pushState(null, "", "/dashboard/analytics")
  2. Fetch with _rsc_partial=true
  3. Server finds divergence at index 2
  4. Server sends only AnalyticsPage segment
  5. Browser merges: keeps [RootLayout, DashboardLayout] + new [AnalyticsPage]
  6. reconstructTreeFromSegments() creates NEW component instances
         │
         ▼
React Rendering:
┌─────────────────────────────────────────────────────────┐
│ React compares old and new tree:                        │
│                                                         │
│ OLD:                    NEW:                            │
│ RootLayout              RootLayout                      │
│  └─ DashboardLayout     └─ DashboardLayout              │
│      └─ DashboardPage      └─ AnalyticsPage            │
│                                                         │
│ RootLayout ─────────────▶ SAME (same route object)    │
│ DashboardLayout ────────▶ SAME (same route object)     │
│ DashboardPage ──────────▶ DIFFERENT                    │
│                                                         │
│ Result: React reuses the DOM nodes for unchanged       │
│ components but updates their children!                 │
└─────────────────────────────────────────────────────────┘
         │
         ▼
Final State: /dashboard/analytics
┌─────────────────────────────────────┐
│ RootLayout                          │
│  ├─ header (same DOM)               │
│  ├─ main (same DOM)                 │
│  │  └─ DashboardLayout (same DOM!)  │ 🔐 State PRESERVED!
│  │     ├─ sidebar (still expanded)  │    - sidebarOpen = true
│  │     │  └─ [menu items]           │    - selectedTab = 0
│  │     └─ main (same DOM)           │    (no state lost!)
│  │        └─ <Outlet /> (updated)   │
│  │           └─ AnalyticsPage       │ (new instance)
│  └─ footer (same DOM)               │
└─────────────────────────────────────┘

Key Insight:
- DashboardLayout component RE-RENDERS (new function call)
- But its DOM node is REUSED (React reconciliation)
- CSS state, scroll position, focus, etc. all preserved
- Only the <Outlet /> content changes to show AnalyticsPage
```

## 5. Request Headers and Content Negotiation

```
┌─────────────────────────────────────────────────────────────────┐
│          CONTENT TYPE NEGOTIATION                                │
└─────────────────────────────────────────────────────────────────┘

Browser HTTP Request (User types URL)
┌──────────────────────────────────────────┐
│ GET /dashboard                           │
│ Accept: text/html,application/xhtml+xml, │
│         application/xml;q=0.9, */*;q=0.8 │
│ (Browser always sends Accept: text/html) │
└──────────────────────────────────────────┘
         │
         ▼
Server Logic in entry.rsc.tsx:
┌──────────────────────────────────────────┐
│ const isRscRequest =                     │
│   (!request.headers.get("accept")        │
│     ?.includes("text/html") &&           │
│    !url.searchParams.has("__html"))      │
│   || url.searchParams.has("__rsc");      │
│                                          │
│ Result: isRscRequest = false             │
│ (Has "text/html" in Accept header)       │
└──────────────────────────────────────────┘
         │
         ▼
Server Response:
┌──────────────────────────────────────────┐
│ Call entry.ssr.tsx for HTML rendering    │
│ Return Response with:                    │
│ Content-Type: text/html                  │
│ Body: HTML with embedded RSC stream      │
└──────────────────────────────────────────┘
         │
         ▼
Browser receives HTML and renders


JavaScript Fetch Request (SPA Navigation)
┌──────────────────────────────────────────┐
│ GET /dashboard/analytics?_rsc_partial=.. │
│ Accept: application/json                 │
│ (No Accept: text/html)                   │
└──────────────────────────────────────────┘
         │
         ▼
Server Logic in entry.rsc.tsx:
┌──────────────────────────────────────────┐
│ const isRscRequest =                     │
│   (!request.headers.get("accept")        │
│     ?.includes("text/html") &&           │
│    !url.searchParams.has("__html"))      │
│   || url.searchParams.has("__rsc");      │
│                                          │
│ Result: isRscRequest = true              │
│ (No "text/html" in Accept header)        │
└──────────────────────────────────────────┘
         │
         ▼
Server Response:
┌──────────────────────────────────────────┐
│ Skip entry.ssr.tsx                       │
│ Return Response with:                    │
│ Content-Type: text/x-component           │
│ Body: RSC stream only (no HTML)          │
└──────────────────────────────────────────┘
         │
         ▼
Browser deserializes RSC and updates
```

## 6. Three Execution Environments

```
┌──────────────────────────────────────────────────────────────────┐
│                   VITE BUILD ENVIRONMENTS                         │
└──────────────────────────────────────────────────────────────────┘

        Application Code
              │
    ┌─────────┼──────────┐
    │         │          │
    ▼         ▼          ▼

RSC Environment      SSR Environment      Client Environment
(Server)             (Server)             (Browser)
─────────────────    ─────────────────    ──────────────────

Condition:           Condition:           Condition:
react-server=true    react-server=false   browser=true

What loads:          What loads:          What loads:
- Server only code   - Both server &      - Client only code
- Server actions     client code          - Client hooks
- Database queries   - Client hooks       - Browser APIs
- etc.               - But no Server      - Event listeners
                       components         - etc.

Purpose:             Purpose:             Purpose:
Serialize VDOM       Convert RSC to       Hydrate & run
to RSC stream        HTML string          UI in browser

Entry:               Entry:               Entry:
entry.rsc.tsx        entry.ssr.tsx        entry.browser.tsx

Output:              Output:              Output:
RSC stream           HTML stream          Running app

Used For:            Used For:            Used For:
1. Initial server    1. Converting RSC    1. Initial hydration
   rendering         to HTML              2. Navigation
2. Server function   2. For document      3. User interaction
   calls             requests only
3. Partial updates


        Flow:
        RSC Env      SSR Env         Client Env
           │            │              │
           ├─ Routes ────┤              │
           ├─ Match ─────┤              │
           ├─ Render RSC ┤              │
           │            │              │
           ├─ Serialize  │              │
           │    ↓        │              │
           │  RSC Stream │              │
           │            ├─ Deserialize │
           │            ├─ Render HTML │
           │            ├─ Inject RSC  │
           │            │    ↓         │
           │            │  HTML+RSC    ├─ Receive HTML
           │            │              ├─ Parse HTML
           │            │              ├─ Extract RSC
           │            │              ├─ Hydrate React
           │            │              │
           │            │              └─ Running UI!

For SPA Navigation:
           RSC Env                      Client Env
           │                            │
           ├─ Match Partial             │
           ├─ Render segments           │
           ├─ Serialize RSC             │
           │    ↓                       │
           │  RSC Stream ───────────────┤─ Receive
           │              (only changed)├─ Deserialize
           │                            ├─ Merge segments
           │                            ├─ Reconstruct tree
           │                            ├─ Re-render
           │                            │
           │                            └─ Updated UI!
```

## 7. Complete Data Flow: Document Request vs SPA Navigation

```
┌──────────────────────────────────────────────────────────────────┐
│             SIDE-BY-SIDE COMPARISON                               │
└──────────────────────────────────────────────────────────────────┘

DOCUMENT REQUEST                    │  SPA NAVIGATION
(Address bar, F5, first load)       │  (Link click)
────────────────────────────────────┼────────────────────────────────

Browser: HTTP GET /dashboard        │  Browser: fetch /dashboard/
Accept: text/html                   │  analytics?_rsc_partial=true
                                    │  Accept: application/json
                    │               │                │
                    └───────┬───────┘                │
                            ▼                       │
                   entry.rsc.tsx handler            │
                            │                       ▼
                            │                   entry.rsc.tsx handler
                            │                       │
                ┌───────────┴───────────┐           │
                │                       │           │
        router.match()            router.matchPartial()
        (full tree)               (divergence point)
                │                       │
        Returns:                Returns:
        [component]             [segments, startIndex]
        segments: []
                │                       │
                │       ┌───────────────┘
                │       │
        renderToReadableStream()
        (same on both paths)
                │
            rscStream created
                │
        Check Accept header
        ┌───────┴──────────┐
        │                  │
    text/html           No text/html
        │                  │
        │         ┌────────┘
        │         │
    call ssr       │
    module    │   │
        │     │   │
    render    │   ▼
    HTML      │   Return rscStream
    inject    │   Status 200
    RSC   │   │   Content-Type:
        │ │   │   text/x-component
        │ │   │
        ▼ ▼   ▼
    Response HTML+RSC Stream
            │               │
            │               │
            ▼               ▼
        Browser             Browser
        HTML parses         fetch completes
        DOM renders         │
            │               ├─ createFromFetch()
            ├─ hydrate       ├─ deserialize RSC
            │   Root()       │
            └─ Ready         ├─ access metadata.segments
            to use           │
                            ├─ Is isPartial?
                            │  ├─ YES: mergeSegments()
                            │  └─ NO: replace all
                            │
                            ├─ reconstructTreeFromSegments()
                            │
                            ├─ setPayload()
                            │
                            └─ React re-renders
                               Updated UI!
```

## 8. Router Matching: Step by Step

```
┌─────────────────────────────────────────────────────────────────┐
│                    ROUTE MATCHING PROCESS                        │
└─────────────────────────────────────────────────────────────────┘

Route Definitions:
┌────────────────────────────────────┐
│ layout "/"                         │
│   layout "/dashboard"              │
│     get "/dashboard"               │
│     get "/dashboard/analytics"     │
│   endLayout                        │
│   get "/"                          │
│ endLayout                          │
└────────────────────────────────────┘

URL to match: /dashboard/analytics
             │
             ▼
findMatchingRoutes("/dashboard/analytics", GET, routes)
             │
             ├─ Check route "/" ─────────────────┐
             │  ├─ regex match? YES               │
             │  ├─ method? ALL (matches GET) ✓   │
             │  └─ isLayout? YES                 │
             │      → Check children...          │
             │                                   │
             │  Children:                        │
             │  ├─ Check "/dashboard" ────────┐  │
             │  │  ├─ regex match? YES         │  │
             │  │  ├─ method? ALL ✓            │  │
             │  │  ├─ isLayout? YES            │  │
             │  │  └─ Check children...        │  │
             │  │                              │  │
             │  │  Children:                   │  │
             │  │  ├─ Check "/dashboard" ───┐ │  │
             │  │  │  ├─ regex: YES           │ │  │
             │  │  │  ├─ method: GET ✓        │ │  │
             │  │  │  ├─ isLayout? NO (page)  │ │  │
             │  │  │  └─ NOT a match (need  │ │  │
             │  │  │     further path)        │ │  │
             │  │  │                          │ │  │
             │  │  ├─ Check "/dash/analytics" │ │  │
             │  │  │  ├─ regex: YES           │ │  │
             │  │  │  ├─ method: GET ✓        │ │  │
             │  │  │  ├─ isLayout? NO (page)  │ │  │
             │  │  │  └─ MATCH! ✓  ✓  ✓       │ │  │
             │  │  │                          │ │  │
             │  │  └─ Return [root, dash, page]
             │  │                          │  │
             │  └─ (matched, don't check others)
             │                                   │
             └─ Return result to caller ────────┘

Result Returned:
┌────────────────────────────────────┐
│ [                                  │
│   { route: RootRoute, params: {} } │
│   { route: DashRoute, params: {}   │
│   { route: PageRoute, params: {}   │
│ ]                                  │
└────────────────────────────────────┘

Process matched routes (reverse order):
             │
        loop i = 2 down to 0
             │
        i = 2: PageRoute handler
             │  ├─ handler.length = 1 (not middleware)
             │  ├─ Execute handler(context)
             │  └─ componentTree = <AnalyticsPage />
             │     segments.push({ index: 2, pattern, component, isLayout: false })
             │
        i = 1: DashRoute handler (layout)
             │  ├─ isLayout = true
             │  ├─ Execute handler(context)
             │  └─ Wrap: <OutletProvider content={componentTree}>
             │           <DashboardLayout />
             │         </OutletProvider>
             │     segments.push({ index: 1, pattern, component, isLayout: true })
             │
        i = 0: RootRoute handler (layout)
             │  ├─ isLayout = true
             │  ├─ Execute handler(context)
             │  └─ Wrap: <OutletProvider content={componentTree}>
             │           <RootLayout />
             │         </OutletProvider>
             │     segments.push({ index: 0, pattern, component, isLayout: true })
             │
             ▼
        Final componentTree:
        <OutletProvider>           root
          <RootLayout>             layout
            <OutletProvider>       dash
              <DashboardLayout>    layout
                <OutletProvider>   page
                  <AnalyticsPage /> page
                </OutletProvider>
              </DashboardLayout>
            </OutletProvider>
          </RootLayout>
        </OutletProvider>

        Final segments:
        [
          { index: 0, RootLayout, layout: true },
          { index: 1, DashboardLayout, layout: true },
          { index: 2, AnalyticsPage, layout: false }
        ]

Return: [componentTree, segments]
```

---

This should provide clear visual understanding of how the entire system works!
