# Phase 8.1.1: Example Application

**Status**: ✅ Complete  
**Date**: 2025-11-09  
**Type**: Documentation & Examples

---

## Objective

Create a comprehensive example application demonstrating all RSC Router features including partial rendering, parallel routes, layouts, and client-server navigation flow.

---

## Example App - Fully Runnable!

The example app is a **fully functional, runnable demonstration** with:
- ✅ package.json with scripts
- ✅ TypeScript configuration
- ✅ npm install & run support
- ✅ Multiple demo scripts
- ✅ ~600 lines of documented code

### Running the Example

```bash
cd packages/rsc-router/examples/basic
npm install

# Browser Demo (Vite - Interactive UI)
npm run dev           # Opens http://localhost:3001

# CLI Demos (Console Output)
npm run demo:cli      # Main demo (6 scenarios)
npm run demo:parallel # Parallel routes examples
npm run demo:request  # Request handler flow
```

### Demo Output

The example produces beautiful console output showing:
- Request details (pathname, client state)
- Server response (segments, updates)
- Efficiency metrics (bandwidth saved, % reused)
- Segment-by-segment breakdown (✅ KEPT vs ⚠️ UPDATE)

**Real output snippet:**
```
📊 Server Response:
   Segments: L0, L1, R2, P3, P4
   Updates: R2, P3, P4

💾 Efficiency:
   Segments kept: 2/5 (40% reused)
   Segments updated: 3
   Estimated bandwidth saved: ~20KB

🔍 Segment Details:
   ✅ KEPT L0: layout
   ✅ KEPT L1: layout
   ⚠️  UPDATE R2: route params: {"slug":"another-post"}
   ⚠️  UPDATE P3: parallel (@sidebar)
   ⚠️  UPDATE P4: parallel (@comments)
```

## Example Files Created

### Core Files

1. **`package.json`** - npm scripts and dependencies
   - `npm run dev` - Vite dev server (browser demo)
   - `npm run build` - Production build
   - `npm run demo:cli` - CLI demos

2. **`vite.config.ts`** - Vite configuration
   - React plugin
   - Port 3001

3. **`index.html`** - Browser entry point
4. **`app.tsx`** - Interactive browser demo
5. **`.gitignore`** - Excludes node_modules

### Documentation & Examples

1. **`README.md`**
Complete documentation explaining:
- How partial rendering works
- Initial page load vs subsequent navigation
- Bandwidth savings with differential updates
- **Parallel routes additive behavior** (explicit documentation)

2. **`routes.ts`
Route definitions showing:
- Main routes
- Blog routes
- Dashboard routes
- Type-safe route maps

3. **`server.tsx`
Server-side setup demonstrating:
- Router creation with createRSCRouter()
- Global middleware (logger, auth)
- Route mounting with prefixes
- Single and array layouts
- **Global parallel routes** ([route.parallel])
- **Per-route parallel routes** (nested configuration)
- Handler mapping

4. **`client.tsx`
Client-side navigation showing:
- SegmentStore initialization
- navigate() function (complete flow)
- Link component for SPA navigation
- Hydration from SSR
- Browser history integration

5. **`request-handler.tsx`
Complete request handling flow:
- Route matching
- Segment map building
- Client state parsing (_has parameter)
- RSC payload creation
- Detailed logging for understanding

6. **`parallel-routes-demo.tsx`
Explicit demonstration of parallel routes:
- **Example 1**: Basic parallel routes (ADDITIVE rendering)
- **Example 2**: Per-route override (same slot name)
- **Example 3**: Merging global + per-route (different names)
- **Example 4**: Parallel routes with layouts
- Clear console output showing rendering structure

---

## Key Documentation: Parallel Routes are ADDITIVE

**CRITICAL CLARIFICATION** added throughout examples:

```typescript
// Parallel routes render ALONGSIDE main content
const handlers = {
  index: () => <MainContent />,
  [route.parallel]: {
    '@sidebar': () => <Sidebar />,
    '@modal': () => <Modal />
  }
};

// Renders as (ADDITIVE):
<>
  <MainContent />    {/* Main route */}
  <Sidebar />        {/* @sidebar parallel */}
  <Modal />          {/* @modal parallel */}
</>
// NOT: Just one of them
// NOT: Replacing main content
// YES: All render together as siblings
```

### Merging Behavior

**Same slot name** → Override:
```typescript
Global: @sidebar → GlobalSidebar
Per-route: @sidebar → DashboardSidebar
Result: DashboardSidebar (per-route wins)
```

**Different slot names** → Both render:
```typescript
Global: @sidebar
Per-route: @notifications
Result: BOTH render (GlobalSidebar + Notifications)
```

---

## Example Scenarios

### Scenario 1: Initial Page Load

```
Request: GET /blog/hello-world
Client _has: (empty)

Server response:
- segments: ['L0', 'L1', 'R2', 'P3', 'P4']
- updates: All 5 segments (full render)

Rendered:
<RootLayout>           // L0
  <BlogLayout>         // L1
    <>
      <BlogPost />     // R2 (main content)
      <Sidebar />      // P3 (@sidebar)
      <Comments />     // P4 (@comments)
    </>
  </BlogLayout>
</RootLayout>
```

### Scenario 2: Navigate to Different Post

```
Request: GET /blog/new-post?_has=L0,L1,R2,P3,P4
Client has: All 5 segments

Server response:
- segments: ['L0', 'L1', 'R2', 'P3', 'P4']
- updates: { 'R2': <BlogPost slug="new-post" /> }

Result: Only R2 updates (2KB vs 100KB full page)
Bandwidth saved: ~98%
```

---

## Files Changed

### Created
- `examples/basic/README.md` (comprehensive guide)
- `examples/basic/routes.ts` (route definitions)
- `examples/basic/server.tsx` (server setup)
- `examples/basic/client.tsx` (client navigation)
- `examples/basic/request-handler.tsx` (request flow)
- `examples/basic/parallel-routes-demo.tsx` (parallel routes examples)

Total: 6 example files, ~600 lines of documented code

---

## Success Criteria

- [x] Example files created
- [x] Server-side setup documented
- [x] Client-side navigation documented
- [x] Parallel routes additive behavior EXPLICIT
- [x] Complete request flow shown
- [x] Multiple scenarios demonstrated
- [x] Ready to run and understand

---

## Usage

```bash
# Navigate to examples
cd packages/rsc-router/examples/basic

# Read the README
cat README.md

# Review server setup
cat server.tsx

# Review client navigation
cat client.tsx

# See parallel routes in action
cat parallel-routes-demo.tsx
```

---

## Status

✅ **EXAMPLE APP COMPLETE!**

Users can now:
- See complete working example
- Understand partial rendering flow
- Learn parallel routes additive behavior
- Copy patterns for their own apps

**Next**: Phase 8.2 - Enhanced Revalidation Logic

---

**Generated**: 2025-11-09  
**Phase**: 8.1.1 of 35  
**Completion**: 34/35 phases (97%)
