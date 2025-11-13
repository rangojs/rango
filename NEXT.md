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

## Phase 1: Core Mutations (THIS WEEK) 🔥

### 1. Revalidation Logic (START HERE)
**Status:** Type defined, partially implemented
**Priority:** CRITICAL - Foundation for actions and caching

**Current State:**
```typescript
// Already defined in types:
[$revalidate('routeName')]: (ctx) => boolean

// Partially implemented in matchPartial - param change detection exists
```

**What's Missing:**
- Full implementation of custom revalidation functions
- Cache invalidation hooks
- Integration with partial rendering
- Granular segment revalidation (layout vs route vs parallel)
- Revalidation after mutations (will be needed for actions)

**Files to Modify:**
- `packages/rsc-router/src/router.ts` - Complete revalidation implementation
  - Read revalidation functions from handlers
  - Call them during matchPartial
  - Respect custom revalidation logic
- Test with shop example (product detail should only revalidate when slug changes)

**Success Criteria:**
- ✅ Custom revalidation functions work
- ✅ Can prevent unnecessary re-renders
- ✅ Partial rendering respects revalidation rules

---

### 2. Middleware Implementation - NEXT
**Status:** Type defined, partially implemented
**Priority:** CRITICAL - Needed before actions (auth, validation, logging)

**Current State:**
```typescript
// Already defined:
[$middleware('routeName', 'name')]: [(ctx, next) => { ... }]

// Partially implemented in buildSegments
```

**What's Missing:**
- Full middleware execution pipeline
- Middleware chaining (run all middleware in order)
- Short-circuit on errors/auth failures
- Context passing between middleware
- Error handling and recovery
- Middleware for both routes AND actions

**Files to Modify:**
- `packages/rsc-router/src/router.ts` - Complete middleware execution
  - Execute middleware array in order
  - Pass context between middleware
  - Handle middleware errors
  - Support async middleware
- Test with auth middleware in shop example

**Success Criteria:**
- ✅ Middleware chains execute in order
- ✅ Can short-circuit (prevent route from rendering)
- ✅ Context flows through middleware
- ✅ Global (`*`) and per-route middleware work

---

### 3. RSC Actions (Server Actions) - AFTER MIDDLEWARE
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
- [ ] Revalidation logic complete
- [ ] Middleware fully working
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

Last Updated: 2025-11-13
