# RSC Router - Roadmap & Next Steps

## Vision
Build a **code-first, type-safe RSC router** for serverless deployments (Cloudflare Workers, edge functions) that simplifies ecommerce development without file-based conventions.

## Current State ✅
- ✅ Core routing with nested routes
- ✅ Dynamic segments with type inference
- ✅ Layout composition (multiple layouts per route)
- ✅ Parallel routes (first-class support)
- ✅ Partial rendering optimization
- ✅ Lazy-loaded handlers
- ✅ Type-safe params extraction
- ✅ Demo shop example (comprehensive test case)

**Bug Fixed:** Nested route flattening now works correctly (products.detail stays prefixed)

---

## Phase 1: Core Mutations (IN PROGRESS) 🔥

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

### 1.3 RSC Actions (Server Actions) ⬅️ NEXT PRIORITY
**Status:** Not implemented
**Priority:** CRITICAL - Can't build real apps without mutations

**Design Questions:**
- How to define actions in handlers?
  ```typescript
  [$action('addToCart')]: async (ctx, formData) => { ... }
  ```
- How to route action requests (POST to special endpoint?)
- How to invoke from client components
- Return values vs redirects vs revalidation
- Access to route params and context
- Error handling
- **Trigger revalidation after action completes**
- **Run middleware before actions** (auth checks)

**Files to Modify:**
- `packages/rsc-router/src/types.ts` - Add action types
- `packages/rsc-router/src/router.ts` - Action routing/execution
- `packages/rsc-router/src/route-definition.ts` - action() helper
- Create client-side action invoker

**Dependencies:**
- ⚠️ Requires revalidation logic (trigger re-renders after mutations)
- ⚠️ Requires middleware (auth checks before actions)

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

### Week 1 (Current):
- [x] Revalidation logic complete (with soft/hard pattern)
- [x] Middleware 100% complete (error handling, short-circuit, URL filtering)
- [ ] RSC Actions working end-to-end
- [ ] Build a working "add to cart" flow

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

Last Updated: 2025-11-14
