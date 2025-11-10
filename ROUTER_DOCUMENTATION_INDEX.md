# Vite-RSC Router Documentation Index

This directory contains comprehensive documentation about how the vite-rsc router works. Choose the right document for your needs:

## Documentation Files

### 1. **VITE_RSC_ROUTER_GUIDE.md** (36 KB, 1182 lines)
**The Complete Technical Reference**

Start here for a deep dive into the entire system. This is the most comprehensive guide covering:

- Part 1: Core Architecture Overview (three Vite environments)
- Part 2: Document Requests (full page loads from address bar)
- Part 3: SPA Partial Requests (client-side navigation)
- Part 4: Segment System and Data Flow
- Part 5: Server Rendering vs Client Reconstruction
- Part 6: Outlet Pattern and Layout Preservation
- Part 7: Key Entry Points and Flow Summary
- Part 8: Request Handling Deep Dive
- Part 9: Storage and Async Context
- Part 10: Summary Tables
- Part 11: Advanced Concepts

**Best for:** Understanding the complete architecture, debugging, writing extensions

**Read time:** 30-45 minutes

---

### 2. **ROUTER_QUICK_REFERENCE.md** (14 KB, 524 lines)
**Quick Lookup and Implementation Guide**

A condensed, practical guide for common tasks. Organized by topic:

- Core Concept overview
- Request Types at a glance
- The Three Environments
- Routing Configuration examples
- The Segments System (what, why, how)
- Navigation Flow Details
- Key Files Map
- Divergence Detection algorithm
- Outlet Pattern explanation
- Query Parameters for development
- Content Negotiation headers
- Common Navigation Scenarios
- Debugging Tips
- Mental Model Summary

**Best for:** Quick lookups, implementation reference, debugging specific issues

**Read time:** 10-15 minutes

---

### 3. **ROUTER_DIAGRAMS.md** (35 KB, 689 lines)
**Visual Flowcharts and Diagrams**

ASCII diagrams and flowcharts showing:

1. Complete Request Lifecycle (document request vs SPA navigation)
2. Segment Lifecycle (from routing to tree reconstruction)
3. Divergence Detection Algorithm (step-by-step)
4. Layout State Preservation (how Outlet maintains state)
5. Request Headers and Content Negotiation
6. Three Execution Environments
7. Complete Data Flow comparison
8. Router Matching process (step by step)

**Best for:** Visual learners, understanding system flow, presentations

**Read time:** 15-20 minutes

---

## Quick Navigation Guide

### "I want to understand..."

| What | Where to Look | Read |
|------|---------------|------|
| How document requests work | VITE_RSC_ROUTER_GUIDE.md Part 2 | 10 min |
| How SPA navigation works | VITE_RSC_ROUTER_GUIDE.md Part 3 | 15 min |
| What segments are and why they matter | VITE_RSC_ROUTER_GUIDE.md Part 4 | 10 min |
| How layout state is preserved | VITE_RSC_ROUTER_GUIDE.md Part 6 or ROUTER_QUICK_REFERENCE.md | 5 min |
| The Outlet pattern | ROUTER_QUICK_REFERENCE.md "Outlet Pattern" section | 5 min |
| The divergence detection algorithm | ROUTER_DIAGRAMS.md section 3 | 10 min |
| How the three environments work | ROUTER_DIAGRAMS.md section 6 | 10 min |
| How to define routes | ROUTER_QUICK_REFERENCE.md "Routing Configuration" | 5 min |
| Complete flow diagrams | ROUTER_DIAGRAMS.md section 1 & 7 | 10 min |

### "I need to debug..."

| Problem | Check |
|---------|-------|
| Navigation not working | ROUTER_QUICK_REFERENCE.md "Debugging Tips" |
| Segments not merging | VITE_RSC_ROUTER_GUIDE.md Part 3 Step 5 |
| Layout state being lost | VITE_RSC_ROUTER_GUIDE.md Part 6 |
| Server returning wrong content type | VITE_RSC_ROUTER_GUIDE.md Part 8.2 |
| RSC stream not deserializing | ROUTER_DIAGRAMS.md section 1 |
| Partial request not happening | VITE_RSC_ROUTER_GUIDE.md Part 3 Step 2 |

### "I want to implement..."

| Task | Guide |
|------|-------|
| Add new routes | ROUTER_QUICK_REFERENCE.md "Routing Configuration" |
| Create layouts with Outlet | ROUTER_QUICK_REFERENCE.md "Outlet Pattern" |
| Add route middleware | VITE_RSC_ROUTER_GUIDE.md Part 8 |
| Handle server functions | VITE_RSC_ROUTER_GUIDE.md Part 8.3 |
| Custom navigation logic | VITE_RSC_ROUTER_GUIDE.md Part 2.3 or 3.3 |

---

## Key Concepts Summary

### Document Request (Full Page Load)
User navigates to URL → Server calls `router.match()` → Gets full component tree → Renders to HTML with embedded RSC → Browser hydrates

**Key file:** `entry.rsc.tsx` → `entry.ssr.tsx` → `entry.browser.tsx`

**When:** First load, F5 refresh, direct navigation

### SPA Partial Request (Navigation)
User clicks link → Browser intercepts → Fetches with `_rsc_partial=true` → Server calls `router.matchPartial()` → Gets only changed segments → Browser merges and reconstructs tree → UI updates

**Key file:** `entry.browser.tsx` → server → `entry.browser.tsx` (again)

**When:** Link click on same-origin page

### Segments
A flat array of components indexed by their position in the route hierarchy. Serializable, transport-agnostic representation of the component tree.

```typescript
[
  { index: 0, pattern: "/", component: RootLayout, isLayout: true },
  { index: 1, pattern: "/dashboard", component: DashboardLayout, isLayout: true },
  { index: 2, pattern: "/dashboard/page", component: PageComponent, isLayout: false }
]
```

### Divergence Detection
The algorithm that finds where two routes differ, enabling partial rendering by only re-rendering from that point onwards.

```
Old: /dashboard/settings → [/, /dashboard, /settings]
New: /dashboard/analytics → [/, /dashboard, /analytics]
                                           ↑ differ at index 2
Divergence point: index 2
```

### Outlet Pattern
Client components that inject nested content via React Context. Allows layouts to define where child content renders while preserving the layout's DOM state.

```typescript
<DashboardLayout>
  <Outlet />  // This renders the page, but the layout DOM stays the same
</DashboardLayout>
```

---

## File Structure Reference

### Entry Points
- **`src/framework/entry.rsc.tsx`** - RSC environment, handles all requests, route matching
- **`src/framework/entry.ssr.tsx`** - SSR environment, converts RSC to HTML
- **`src/framework/entry.browser.tsx`** - Client environment, hydration and navigation

### Router Implementation
- **`src/framework/router/router.tsx`** - `RscRouter` class with `match()` and `matchPartial()`
- **`src/framework/router/Outlet.tsx`** - `Outlet` and `OutletProvider` components
- **`src/framework/router/types.ts`** - Type definitions
- **`src/framework/router/matcher.ts`** - Segment matching utilities
- **`src/framework/router/segments.ts`** - Segment utilities

### Application Code
- **`src/routes.tsx`** - Route definitions using `RscRouter` API
- **`src/layouts/*.tsx`** - Layout components containing `<Outlet />`
- **`src/pages/*.tsx`** - Page components (leaf routes)
- **`src/vite.config.ts`** - Vite configuration with three environments

---

## Understanding the Three Environments

The system uses three separate Vite build environments:

### RSC Environment (`entry.rsc.tsx`)
- Executes on the **server**
- Has access to `react/server` condition (server components)
- Handles **every request** (document and SPA)
- Returns RSC stream
- Can call server functions

### SSR Environment (`entry.ssr.tsx`)
- Executes on the **server**
- Converts RSC stream to HTML string
- Only used for **document requests** (not SPA)
- Returns HTML with embedded RSC stream

### Client Environment (`entry.browser.tsx`)
- Executes in the **browser**
- Hydrates the initial HTML
- Intercepts navigation
- Fetches RSC for SPA navigation
- Updates the UI

---

## Request Flow Summary

### Document Request
```
Browser: GET /page (Accept: text/html)
  ↓
entry.rsc.tsx: router.match() → full tree
  ↓
entry.ssr.tsx: render tree to HTML, inject RSC
  ↓
Browser: parse HTML, hydrate React, read RSC
  ↓
Ready
```

### SPA Navigation
```
Browser: fetch /page?_rsc_partial=true (from JS)
  ↓
entry.rsc.tsx: router.matchPartial() → changed segments only
  ↓
Browser: merge segments, reconstruct tree, re-render
  ↓
Updated UI (layout state preserved)
```

---

## Reading Recommendations

### For Different Audiences

**Project Managers / Non-Technical:**
- Read: ROUTER_QUICK_REFERENCE.md "Core Concept" and "Mental Model Summary"
- Time: 2 minutes
- Takeaway: Understand the basic flow

**Frontend Developers (implementing routes):**
1. ROUTER_QUICK_REFERENCE.md "Routing Configuration"
2. ROUTER_QUICK_REFERENCE.md "Outlet Pattern"
3. ROUTER_DIAGRAMS.md section 1
- Time: 20 minutes
- Takeaway: How to define routes and create layouts

**Backend Developers (routing logic):**
1. VITE_RSC_ROUTER_GUIDE.md Parts 2-4
2. ROUTER_DIAGRAMS.md sections 3 & 8
3. VITE_RSC_ROUTER_GUIDE.md Part 8
- Time: 60 minutes
- Takeaway: How route matching and segment generation works

**System Architects (designing extensions):**
1. VITE_RSC_ROUTER_GUIDE.md (all parts)
2. ROUTER_DIAGRAMS.md (all sections)
3. Source code: `src/framework/router/*.tsx`
- Time: 120 minutes
- Takeaway: Complete system understanding for extending/modifying

**Debuggers (fixing issues):**
1. ROUTER_QUICK_REFERENCE.md "Debugging Tips"
2. VITE_RSC_ROUTER_GUIDE.md Part 8 (relevant section)
3. ROUTER_DIAGRAMS.md (relevant section)
- Time: 15-30 minutes depending on issue
- Takeaway: Locate the problem in the flow

---

## Key Insights

### Why This Architecture Works

1. **Dual Mode**: Supports both traditional page loads (SEO-friendly, reliable) and SPA navigation (fast, smooth)

2. **Efficient Updates**: Only sends changed components over the network during navigation, reducing bandwidth

3. **Layout Preservation**: The Outlet pattern allows layouts to maintain state even when their child content changes, creating a better UX

4. **Transport Agnostic**: Segments are just data, so they can be easily serialized/deserialized, cached, or transformed

5. **Type Safe**: TypeScript types for routes, segments, and context ensure safety while building

6. **Composable**: Express/Hono-style routing with middleware support allows complex routing logic

### The Genius of Segments

Instead of sending the full component tree structure, the router sends a flat array of segments. The client can then:
- Understand structure without knowing routing logic
- Efficiently merge with existing segments
- Reconstruct the tree locally

This decouples the transport format from the component structure, making the system very flexible.

### The Outlet Pattern

By using React Context, Outlet allows:
- Layouts to define content placeholders without being coupled to child routes
- Child content to be injected at the right place in the DOM
- Layout state to be preserved even when child content changes
- Progressive enhancement (works even without full JavaScript)

---

## Getting Started Checklist

- [ ] Read ROUTER_QUICK_REFERENCE.md "Core Concept" section
- [ ] Look at ROUTER_DIAGRAMS.md section 1 (request lifecycle)
- [ ] Review `src/routes.tsx` for examples
- [ ] Check `src/layouts/RootLayout.tsx` to see Outlet usage
- [ ] Read ROUTER_QUICK_REFERENCE.md "Routing Configuration"
- [ ] Read VITE_RSC_ROUTER_GUIDE.md Parts 2-3 for deep understanding
- [ ] Review source code: `src/framework/entry.rsc.tsx`, `entry.browser.tsx`
- [ ] Try navigating the example app and check console logs

---

## Debugging Console Logs

Both `entry.rsc.tsx` and `entry.browser.tsx` have extensive logging:

**Server logs (when running `npm run dev`):**
```
[Entry.RSC] ==================== REQUEST ====================
[Entry.RSC] URL: /dashboard?_rsc_partial=true
[Entry.RSC] Is partial: true
[Entry.RSC] >>> Attempting PARTIAL render
[Entry.RSC] ✓ Partial render successful
[Entry.RSC] Start index: 2
```

**Browser console logs:**
```
[Browser] ============ NAVIGATION ============
[Browser] From: /dashboard
[Browser] To: /dashboard/analytics
[Browser] → Requesting PARTIAL render
[Browser] ✓ Response received in 45ms
```

These logs are invaluable for understanding what's happening at each step.

---

## Document History

- **Created:** 2024-11-10
- **Version:** 1.0
- **Coverage:** Complete vite-rsc router system
- **Based on:** Source code review from branch `router-idea-2-monorepo`

---

## Related Files in Repository

- Documentation: `/VITE_RSC_ROUTER_GUIDE.md`, `/ROUTER_QUICK_REFERENCE.md`, `/ROUTER_DIAGRAMS.md`
- Source: `/apps/web/src/framework/`
- Configuration: `/apps/web/vite.config.ts`
- Routes: `/apps/web/src/routes.tsx`
- Examples: `/apps/web/src/layouts/`, `/apps/web/src/pages/`

---

**Start reading:** Choose a document from the list above based on your role and what you want to understand!
