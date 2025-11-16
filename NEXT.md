# RSC Router - Roadmap & Next Steps

## Vision
Build a **code-first, type-safe RSC router** for serverless deployments (Cloudflare Workers, edge functions) that simplifies ecommerce development without file-based conventions.

---

## 🎯 NEXT PRIORITIES (Phase 2)

**Phase 1 is COMPLETE!** All core mutation features are implemented and working:
- ✅ Revalidation (soft/hard decision pattern)
- ✅ Middleware (chaining, context, error handling)
- ✅ Server Actions (with returnValue, streaming, useActionState)

**Up Next - Phase 2: Caching & Performance**

### Immediate Next Steps:

1. **Caching Strategy** (NEXT - High Priority)
   - Route response caching for GET requests
   - Cache headers (stale-while-revalidate, max-age)
   - Cache invalidation after mutations
   - Per-route cache configuration
   - Integration with edge/CDN caching

2. **Root Document API** (DX Improvement)
   - Remove boilerplate `[layout("*", "root")]` from every handler
   - Single document definition at router level
   - Cleaner handler code

3. **Cloudflare Workers Adapter** (Deployment)
   - Platform-specific adapter for CF Workers
   - D1/KV/Durable Objects integration
   - Edge-optimized bundling

See detailed roadmap below ↓

## Current State ✅
- ✅ Core routing with nested routes (up to 5 levels deep)
- ✅ Dynamic segments with type inference (up to 10 param levels)
- ✅ Layout composition (multiple layouts per route)
- ✅ Parallel routes (first-class support with typed params)
- ✅ Partial rendering optimization
- ✅ Lazy-loaded handlers
- ✅ Type-safe params extraction
- ✅ **Array-based handler API** - clean nesting, route-scoped helpers, full type inference
- ✅ **Segment-specific revalidation** - revalidateRoute, revalidateLayout, revalidateParallel
- ✅ Demo shop example (comprehensive test case)

**Latest:** Array-based API with route-scoped helpers provides full type inference for inline handlers!

---

## Phase 1: Core Mutations ✅ COMPLETE 🎉

### 1.1 Revalidation Logic ✅ COMPLETE
**Status:** ✅ Fully implemented, tested, and enhanced
**Priority:** CRITICAL - Foundation for actions and caching
**Completed:** 2025-11-14

**What Was Implemented:**
- ✅ Type-safe revalidation handlers with `GenericParams`
- ✅ Recursive route flattening (supports nested routes up to 5 levels)
- ✅ Soft/hard decision pattern:
  - `boolean` return = hard decision (short-circuits)
  - `{ defaultShouldRevalidate: boolean }` = soft decision (continues)
- ✅ Custom revalidation functions with OR logic
- ✅ Integration with partial rendering
- ✅ Granular segment revalidation
- ✅ `RevalidateParams<TParams>` helper type for inline typing
- ✅ Demo examples in `/admin` route
- ✅ Documentation updated in RSC_ROUTER_API_DESIGN.md

**Files Modified:**
- `packages/rsc-router/src/types.ts` - Type definitions with soft/hard pattern
- `packages/rsc-router/src/router.ts` - Execution logic (lines 564-620)
- `packages/rsc-router/src/index.ts` - Exported GenericParams, RevalidateParams
- `examples/vite-rsc-demo/src/handlers/admin.tsx` - NEW demo with soft/hard examples
- `RSC_ROUTER_API_DESIGN.md` - Updated documentation

**Success Criteria:**
- ✅ Custom revalidation functions work
- ✅ Can prevent unnecessary re-renders
- ✅ Partial rendering respects revalidation rules
- ✅ Global and route-specific revalidation
- ✅ Soft decisions allow downstream overrides
- ✅ Zero TypeScript errors, zero `any` in handlers

---

### 1.2 Middleware Implementation ✅ 100% COMPLETE
**Status:** Fully implemented with error handling & short-circuit
**Priority:** CRITICAL - Needed before actions (auth, validation, logging)
**Completed:** 2025-11-14

**What's Implemented:**
- ✅ Middleware extraction from handlers (`$middleware.*` pattern)
- ✅ Full middleware execution pipeline with error handling
- ✅ Middleware chaining with `next()` function
- ✅ Context passing (`ctx.set()`, `ctx.get()`, `ctx.var`)
- ✅ Async middleware support
- ✅ Global (`*`) and route-specific middleware
- ✅ Execution order: global first, then route-specific
- ✅ Type-safe with `MiddlewareFn<GenericParams, TEnv>`
- ✅ Short-circuit: middleware/handlers can return Response
- ✅ `redirect(url)` helper for soft redirects (SPA navigation)
- ✅ Error handling with try/catch in pipeline
- ✅ System param filtering (handlers don't see `_rsc*` params)
- ✅ `ctx._originalRequest` for advanced use cases
- ✅ Custom error classes with cause property
- ✅ Production error sanitization (`import.meta.env.PROD`)
- ✅ Stack trace consumption (prevent memory leaks)

**Files Modified:**
- `packages/rsc-router/src/router.ts` - Execution, error handling, param filtering
- `packages/rsc-router/src/types.ts` - MiddlewareFn, HandlerContext types
- `packages/rsc-router/src/errors.ts` - NEW: Custom error classes + sanitizeError()
- `packages/rsc-router/src/route-definition.ts` - NEW: redirect() helper
- `packages/rsc-router/src/index.ts` - Export errors and redirect
- `examples/vite-rsc-demo/src/handlers/protected.tsx` - NEW: Demo with all features

**Success Criteria:**
- ✅ Middleware chains execute in order
- ✅ Can short-circuit (middleware/handlers return Response)
- ✅ Context flows through middleware
- ✅ Global (`*`) and per-route middleware work
- ✅ Error handling doesn't leak sensitive info in production
- ✅ Handlers see clean URLs without system params

---

### 1.3 RSC Actions (Server Actions) ✅ COMPLETE
**Status:** ✅ Fully implemented with action-aware revalidation
**Priority:** CRITICAL - Can't build real apps without mutations
**Completed:** 2025-11-14

**What Was Implemented:**
- ✅ React Server Actions with 'use server' directive
- ✅ Action detection via `rsc-action` header
- ✅ Action loading via `import.meta.viteRsc.loadServerAction()`
- ✅ Argument encoding/decoding with temporaryReferences
- ✅ Automatic revalidation after action execution
- ✅ Integration with partial rendering
- ✅ Action-aware revalidation context (method, actionId, actionUrl, actionResult, formData, routeName)
- ✅ Smart defaults for action revalidation (route-specific = TRUE, global layouts = FALSE)
- ✅ Segment-aware revalidation (segmentType, layoutName, slotName)
- ✅ Progressive enhancement (works without JS)
- ✅ Action return values (returnValue support)
- ✅ Client-side hydration architecture
- ✅ useActionState integration
- ✅ Promise streaming with Suspense boundaries
- ✅ Error handling with sanitization in production
- ✅ HMR resilience (automatic refetch on missing segments)

**Files Modified:**
- `entry.rsc.tsx` - Action detection, loading, execution, revalidation
- `entry.browser.tsx` - setServerCallback registration, argument encoding, POST requests
- `packages/rsc-router/src/router.ts` - matchPartial with action context
- `packages/rsc-router/src/types.ts` - RevalidateParams with action fields
- `examples/vite-rsc-demo/src/actions/shop.actions.ts` - Demo actions (addToCart, etc.)
- `examples/vite-rsc-demo/src/actions/streaming.actions.ts` - Promise streaming demo
- `examples/vite-rsc-demo/src/handlers/shop.tsx` - Full action integration demo
- `examples/vite-rsc-demo/src/components/AddToCartForm.tsx` - useActionState demo
- `examples/vite-rsc-demo/src/components/StreamingActionForm.tsx` - Suspense demo
- `RSC_ROUTER_API_DESIGN.md` - Complete Server Actions documentation

**Success Criteria:**
- ✅ Actions execute server-side with 'use server'
- ✅ Automatic revalidation after actions
- ✅ Action-aware revalidation with full context
- ✅ Segment-aware control (layout vs route vs parallel)
- ✅ Action return values work (useActionState)
- ✅ Promise streaming works (Suspense)
- ✅ Progressive enhancement (no-JS fallback)
- ✅ Error handling with production sanitization
- ✅ Cart count updates automatically after addToCart
- ✅ HMR doesn't break actions
- ✅ Comprehensive demo in shop.tsx

---

## Phase 2: Caching & Performance (NEXT WEEK)

### 4. Caching Strategy
**Status:** Not implemented
**Priority:** IMPORTANT - Performance for production

**Needs:**
- Route response caching (GET requests)
- Cache headers (stale-while-revalidate)
- Cache invalidation after mutations
- Per-route cache configuration
- Integration with edge/CDN caching

**Design:**
```typescript
[$cache('products.detail')]: {
  ttl: 3600,
  revalidate: 'stale-while-revalidate'
}
```

---

## Phase 3: DX Improvements (NEXT WEEK)

### 5. Root Document API
**Status:** Designed, not implemented
**Priority:** MEDIUM - Removes boilerplate

**Design:**
```typescript
createRSCRouter<AppContext>({
  document: <RootLayout />  // Applied globally, not per-handler
})
```

**Benefits:**
- Remove `[layout("*", "root")]` from every handler
- Separate framework concerns (HTML doc) from route concerns
- Cleaner handler code

**Files to Modify:**
- `packages/rsc-router/src/router.ts` - Accept document option
- Segment building to prepend document
- Update all example handlers

---

### 6. Middleware - Full Documentation & Examples
**Status:** Will be implemented in Phase 1
**Priority:** LOW - Just needs examples after Phase 1.2

**Note:** Middleware implementation will be done in Phase 1.2. This section is for adding comprehensive examples and documentation.

**OLD CONTENT (MOVED TO PHASE 1.2):**
```typescript
[$middleware('routeName', 'name')]: [(ctx, next) => { ... }]
```

**Needs:**
- Full implementation of middleware execution
- Middleware chaining
- Short-circuit on auth failures
- Context passing between middleware

---

## Phase 4: Deployment & Adapters (LATER)

### 7. Cloudflare Workers Adapter
**Status:** Not started
**Priority:** HIGH (for your use case)

**Target API:**
```typescript
import { createCloudflareHandler } from 'rsc-router/cloudflare'

export default createCloudflareHandler(router, {
  context: (env, ctx) => ({
    db: env.DB,
    kv: env.KV
  })
})
```

### 8. Unified Entry Point
**Status:** Future consideration
**Priority:** LOW (nice to have)

**Target:**
```typescript
app.fetch(request: Request, context: AppContext): Promise<Response>
```

For platform-agnostic deployment.

---

## Backlog / Future Considerations

### Not Prioritized Yet:
- ✅ **RouteKeys type utility** - FIXED (recursive flattening now handles nested routes)
- ❓ Router-level layouts (`.layouts()` method) - DEFERRED (handlers work fine)
- ❓ Lazy route flattening - DEFERRED (no performance issue yet)
- ❓ Error boundaries
- ❓ Loading states
- ❓ Streaming patterns
- ❓ Route groups/prefixes
- ❓ Sitemap generation
- ❓ Type-safe redirects

---

## Decision Log

### ✅ Decisions Made:
1. **Code-first over file-based** - Core value prop
2. **Keep route flattening eager** - No performance issue yet
3. **No router-level layouts yet** - Wait for real pain points
4. **Target serverless first** - Cloudflare Workers, edge functions
5. **Explicit over magic** - See full routing tree in handlers

### ⏸️ Deferred:
1. Router-level layouts - Handlers are self-contained enough
2. Lazy flattening - Not a bottleneck
3. Complex error handling - Ship core features first

---

## Success Metrics

### Week 1 (Current): ✅ COMPLETE
- [x] Revalidation logic complete (with soft/hard pattern)
- [x] Middleware 100% complete (error handling, short-circuit, URL filtering)
- [x] RSC Actions working end-to-end
- [x] Build a working "add to cart" flow

### Month 1:
- [ ] Caching strategy implemented
- [ ] Root document API
- [ ] Middleware fully working
- [ ] Build complete ecommerce demo

### Month 3:
- [ ] Cloudflare Workers adapter
- [ ] Documentation site
- [ ] 2-3 real projects built with it
- [ ] Public release

---

## Notes & Context

**Why This Exists:**
- Scratch own itch (serverless + ecommerce)
- Learn RSC internals
- Improve DX, simplify deployment
- Fill gap: No code-first, type-safe RSC router exists

**Target Users:**
- Developers who prefer code over file conventions
- Serverless/edge deployments (Cloudflare Workers)
- Ecommerce use cases
- Those wanting explicit control without Next.js overhead

**Not Trying To Be:**
- Next.js competitor (too broad)
- Another file-based router
- Client-side router

---

## Questions to Answer

1. **Actions:** What's the invocation API from client components?
2. **Revalidation:** Granular (per-segment) or full route?
3. **Caching:** Edge cache vs app cache - how to control?
4. **Document:** Should it participate in partial rendering?
5. **Context:** How to inject per-request context (DB, auth)?

---

Last Updated: 2025-11-14 (Phase 1 Complete! 🎉)
