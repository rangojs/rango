# PR Review Points - Inline Route Definitions

## Status: All items addressed ✓

---

## 1. Type Issues

### A. ✓ `AssertNoRouteKeyConflicts` is defined but never used
**Status:** FIXED - Removed unused type

---

### B. ✓ Inconsistent error messages in conflict detection
**Status:** FIXED - Aligned both hints to "Use unique key names for each route definition."

---

### C. ✓ `InlineRouteHelpers` has weak typing for several helpers
**Status:** DOCUMENTED - Added explanation that `any` is a trade-off for simpler usage. Full typing would require significant refactoring. The main type safety is in route names.

---

## 2. Runtime Issues

### A. ✓ Duplicate key overwrites silently at runtime
**Status:** FIXED - Added console.warn when keys conflict at runtime

---

### B. ✓ `route-map-builder.ts` has inconsistent prefix format
**Status:** FIXED - Added JSDoc documenting expected format (no leading slash) and added normalization to strip accidental leading slashes

---

## 3. Documentation/Comment Issues

### A. ✓ Outdated comment in `href.ts`
**Status:** FIXED - Updated examples to show new behavior

---

### B. ✓ `MergeRoutes` example still shows `PrefixedRoutes`
**Status:** FIXED - Updated to show both manual approach and preferred router approach

---

## 4. Code Quality Issues

### A. ✓ Handler detection heuristic is fragile
**Status:** FIXED - Replaced `handler.length > 0` detection with return-type-based detection.
- `router.ts`: Stores handler as-is, no arity detection
- `manifest.ts`: Calls handler with helpers, detects based on return type:
  - Promise → lazy handler path (await, check for default/function, call with helpers)
  - Array → inline handler path (wrap with layout)

---

### B. ✓ Double casting through `unknown`
**Status:** DOCUMENTED - Added comment explaining why the cast is needed (type signatures differ but runtime-compatible)

---

### C. ✓ Magic number `.flat(3)`
**Status:** DOCUMENTED - Added comment explaining depth handles layout → routes → nested use() arrays

---

## 5. Example Code Issues

### A. ✓ Inline routes use `href()` with URL paths, not route keys
**Status:** NOT A BUG - The client-side `href()` from `@ivogt/rsc-router/client` accepts URL paths and validates them against registered patterns. This is correct usage.

---

## 6. Improvements

### A. ✓ Add runtime key conflict validation
**Status:** FIXED - Added in createRouteBuilder

---

### B. Export `PrefixRoutePatterns` from main entry points
**Status:** Already exported from server.ts

---

### C. ✓ Add JSDoc to `ConflictingKeys` type
**Status:** FIXED - Added examples showing conflict vs no-conflict cases

---

## Summary

| Issue | Status |
|-------|--------|
| Unused `AssertNoRouteKeyConflicts` type | ✓ Removed |
| Inconsistent error hint messages | ✓ Fixed |
| `any` types in `InlineRouteHelpers` | ✓ Documented trade-off |
| Silent key overwrite at runtime | ✓ Added warning |
| Inconsistent prefix format handling | ✓ Normalized + documented |
| Outdated `href.ts` examples | ✓ Updated |
| Fragile `handler.length` heuristic | ✓ Fixed (return-type detection) |
| Double `unknown` cast | ✓ Documented |
| Magic `.flat(3)` | ✓ Documented |
| Wrong `href()` usage in example | ✓ Not a bug |
| JSDoc for `ConflictingKeys` | ✓ Added |
