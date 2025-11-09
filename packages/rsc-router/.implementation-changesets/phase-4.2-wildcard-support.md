# Phase 4.2: Implement Linear Matcher - Wildcard Support

**Status**: ✅ Completed
**Date**: 2025-11-09
**Time Spent**: ~25 minutes
**Approach**: Test-Driven Development (TDD)

---

## Objective

Add wildcard and optional segment support to LinearMatcher, completing the pattern matching capabilities.

---

## TDD Process

### Red Phase ✅
- Wrote 16 comprehensive tests for wildcards and optional segments
- Tests initially failed (features not implemented)

### Green Phase ✅
- Implemented wildcard matching (`*`, `:path*`)
- Implemented optional segment matching (`:id?`)
- Added special marker post-processing
- All 155 tests passing (139 previous + 16 new)

### Refactor Phase ✅
- Fixed empty wildcard capture
- Fixed optional with trailing slash
- Verified quality

---

## Changes Made

### 1. Files Created

#### `packages/rsc-router/src/__tests__/linear-matcher-wildcards.test.ts`
**Purpose**: Test suite for wildcard and optional segments
**Tests**: 16 tests across 6 describe blocks

**Test Coverage**:
1. **Wildcard routes (*)** (5 tests)
   - Catch-all at end (`/files/*`)
   - Root wildcard (`*`)
   - After static segments
   - Path validation before wildcard
   - Empty wildcard match

2. **Optional segments (:param?)** (5 tests)
   - With segment present
   - With segment absent
   - Optional in middle of path
   - Multiple optional segments
   - Optional with file extension

3. **Named wildcards** (2 tests)
   - `:path*` syntax
   - After static path

4. **Complex patterns** (2 tests)
   - Static + dynamic + wildcard
   - Dynamic + optional + static

5. **Edge cases** (2 tests)
   - Wildcard matching slashes
   - Wildcard with special characters

---

### 2. Files Modified

#### `packages/rsc-router/src/linear-matcher.ts`

**Wildcard Support Added**:
```typescript
// In compile() method:

// Unnamed wildcard
if (segment === '*') {
  paramNames.push('*');
  return '(.*)';  // Matches everything including slashes
}

// Named wildcard (:path*)
if (segment.endsWith('*') && segment.includes(':')) {
  const paramName = segment.slice(1, -1); // Remove : and *
  paramNames.push(paramName);
  return '(.*)';  // Matches everything
}
```

**Optional Segment Support**:
```typescript
// Mark optional params with special token
if (isOptional) {
  regexPart += '§OPTIONAL§([^/.]+)';
}

// Post-process to make / and param both optional
regexPattern = regexPattern.replace(
  /\/§OPTIONAL§\(([^)]+)\)/g,
  '(?:/($1)|/)?'
);
// Pattern: /users/:id?
// Regex: /users(?:/([^/.]+)|/)?
// Matches: /users, /users/, /users/123
```

**Empty Value Capture**:
```typescript
// Changed from:
if (paramName && paramValue) {  // Skips empty strings

// To:
if (paramName && paramValue !== undefined) {  // Captures empty strings
  params[paramName] = paramValue;
}
```

---

## Test Results

### Test Execution
```bash
pnpm test
```

**Output**:
```
✓ src/__tests__/linear-matcher.test.ts (26 tests) 6ms
✓ src/__tests__/linear-matcher-wildcards.test.ts (16 tests) 5ms
... all other tests ...

Test Files  10 passed (10)
Tests  155 passed (155)
Duration  894ms
```

**Status**: ✅ 100% passing (155/155 tests)

### Type Safety
```bash
pnpm type-check
```

**linear-matcher.ts**: ✅ No TypeScript errors

### Linting
**linear-matcher.ts**: ✅ Clean
**Test file**: Minor warnings (performance API usage - acceptable)

---

## API Specification

### Wildcard Routes

#### Catch-All Wildcard
```typescript
const matcher = new LinearMatcher('/files/*');

matcher.match('/files/a/b/c');
// { matched: true, params: { '*': 'a/b/c' } }

matcher.match('/files/');
// { matched: true, params: { '*': '' } }
```

#### Root Wildcard
```typescript
const matcher = new LinearMatcher('*');

matcher.match('/any/path/here');
// { matched: true, params: { '*': '/any/path/here' } }
```

#### Named Wildcard
```typescript
const matcher = new LinearMatcher('/docs/:path*');

matcher.match('/docs/api/reference/hooks');
// { matched: true, params: { path: 'api/reference/hooks' } }
```

### Optional Segments

#### Simple Optional
```typescript
const matcher = new LinearMatcher('/users/:id?');

// With param
matcher.match('/users/123');
// { matched: true, params: { id: '123' } }

// Without param
matcher.match('/users');
// { matched: true, params: {} }

// With trailing slash
matcher.match('/users/');
// { matched: true, params: {} }
```

#### Optional in Middle
```typescript
const matcher = new LinearMatcher('/users/:id?/edit');

matcher.match('/users/123/edit');
// { matched: true, params: { id: '123' } }

matcher.match('/users/edit');
// { matched: true, params: {} }
```

#### Multiple Optional
```typescript
const matcher = new LinearMatcher('/files/:year?/:month?/:day?');

matcher.match('/files/2025/11/09');
// { matched: true, params: { year: '2025', month: '11', day: '09' } }

matcher.match('/files/2025/11');
// { matched: true, params: { year: '2025', month: '11' } }

matcher.match('/files/2025');
// { matched: true, params: { year: '2025' } }

matcher.match('/files');
// { matched: true, params: {} }
```

### Complex Patterns

```typescript
const matcher = new LinearMatcher('/api/:version/files/*');

matcher.match('/api/v1/files/images/logo.png');
// { matched: true, params: { version: 'v1', '*': 'images/logo.png' } }

const matcher2 = new LinearMatcher('/blog/:category?/:slug/comments');

matcher2.match('/blog/tech/react/comments');
// { matched: true, params: { category: 'tech', slug: 'react' } }

matcher2.match('/blog/react/comments');
// { matched: true, params: { slug: 'react' } }
```

---

## Pattern Support Summary

| Pattern Type | Example | Matches |
|--------------|---------|---------|
| Wildcard | `/files/*` | `/files/a`, `/files/a/b/c` |
| Root wildcard | `*` | `/any/path` |
| Named wildcard | `/:path*` | `/a/b/c` → `{path: 'a/b/c'}` |
| Optional | `/:id?` | `/`, `/123` |
| Optional + static | `/:id?/edit` | `/edit`, `/123/edit` |
| Multi-optional | `/:a?/:b?/:c?` | `/`, `/1`, `/1/2`, `/1/2/3` |
| Complex | `/api/:v/files/*` | `/api/v1/files/a/b` |

---

## Implementation Highlights

### Wildcard Detection
```typescript
// Unnamed wildcard
if (segment === '*') {
  paramNames.push('*');
  return '(.*)';  // Greedy, matches everything
}

// Named wildcard
if (segment.endsWith('*') && segment.includes(':')) {
  const paramName = segment.slice(1, -1);
  paramNames.push(paramName);
  return '(.*)';
}
```

### Optional Segment Regex
```typescript
// Pattern: /users/:id?
// Step 1: Mark optional → /users/§OPTIONAL§([^/.]+)
// Step 2: Post-process → /users(?:/([^/.]+)|/)?

// This regex matches:
// - /users (optional group not matched)
// - /users/ (matches the |/ alternative)
// - /users/123 (matches /([^/.]+) with param)
```

**Regex breakdown**:
- `(?:...)` - Non-capturing group
- `/([^/.]+)` - Slash + param
- `|/` - OR just slash
- `?` - Whole thing optional

### Empty Value Handling
```typescript
if (paramName && paramValue !== undefined) {
  params[paramName] = paramValue;  // Captures empty strings
}
```

**Why `!== undefined`**:
- Wildcards can capture empty string: `params['*'] = ''`
- Must differentiate between empty and missing

---

## Regex Patterns Generated

| Pattern | Generated Regex |
|---------|-----------------|
| `/files/*` | `^/files/(.*)$` |
| `*` | `^(.*)$` |
| `/users/:id?` | `^/users(?:/([^/.]+)\|/)?$` |
| `/:a?/:b?` | `^(?:/([^/.]+)\|/)?(?:/([^/.]+)\|/)?$` |
| `/api/:v/files/*` | `^/api/([^/.]+)/files/(.*)$` |
| `/docs/:path*` | `^/docs/(.*)$` |

---

## Performance

All tests include performance benchmarks:

**Lazy Instantiation**: ✅ < 5ms
**1000 Cached Matches**: ✅ < 100ms
**Wildcard Matching**: ✅ No performance regression

---

## Success Criteria

- [x] Wildcard routes implemented (`*`)
- [x] Named wildcards implemented (`:path*`)
- [x] Optional segments implemented (`:id?`)
- [x] Multiple optional segments work
- [x] Optional in middle of path works
- [x] Empty wildcard captures
- [x] Trailing slash handling
- [x] Complex pattern combinations
- [x] 16 comprehensive tests
- [x] All 155 tests passing (100%)
- [x] No TypeScript errors
- [x] Performance maintained
- [x] Documentation complete

---

## Files Structure After This Phase

```
packages/rsc-router/src/
├── linear-matcher.ts                          # Updated: wildcards + optional
├── create-router.ts                           # Existing
├── route-definition.ts                        # Existing
├── __tests__/
│   ├── linear-matcher-wildcards.test.ts       # NEW: 16 tests
│   ├── linear-matcher.test.ts                 # Existing: 26 tests
│   ├── route-builder-map.test.tsx             # Existing: 17 tests
│   ├── route-builder-middleware.test.tsx      # Existing: 15 tests
│   ├── route-mounting.test.tsx                # Existing: 13 tests
│   ├── create-router.test.tsx                 # Existing: 18 tests
│   ├── route-symbols.test.tsx                 # Existing: 15 tests
│   ├── route-nested.test.ts                   # Existing: 14 tests
│   ├── route-definition.test.ts               # Existing: 18 tests
│   ├── sanity.test.ts                         # Existing: 3 tests
│   └── setup.ts                               # Existing
└── index.ts                                   # Existing
```

---

## Next Steps

**Phase 5.1**: Implement Middleware Execution Pipeline
- Integrate LinearMatcher with router.match()
- Execute middleware chain
- Return matched handlers
- Make the router FULLY FUNCTIONAL!

---

## Notes

- Complete pattern matching now available
- All route types from design doc supported
- Performance targets maintained
- Ready for middleware execution (Phase 5.1)
- Ready for segment rendering (Phase 7+)
- All quality checks passing
- LinearMatcher is feature-complete! ✅
