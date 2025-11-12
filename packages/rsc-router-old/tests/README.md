# E2E Test Suite for RSC Router

This directory contains Playwright-based E2E tests that verify the RSC Router's segment-based differential rendering implementation.

## Overview

The test suite validates:

1. **Document Load vs SPA Navigation** - Ensures initial loads use full document requests while subsequent navigations use partial RSC updates
2. **Segment Reconciliation** - Verifies layouts are preserved when appropriate and replaced when necessary
3. **Navigation Scenarios** - Tests various navigation patterns (deep→shallow, shallow→deep, cross-layout, etc.)

## Test Structure

```
tests/
├── e2e/
│   ├── utils/
│   │   └── rsc-helpers.ts          # Shared utilities for RSC testing
│   ├── navigation.spec.ts          # Core navigation tests
│   ├── segment-reconciliation.spec.ts  # Layout preservation tests
│   └── navigation-scenarios.spec.ts    # Complex navigation patterns
└── README.md
```

## Running Tests

### Prerequisites

1. Ensure all dependencies are installed:
   ```bash
   pnpm install
   ```

2. The Playwright browsers should already be installed, but if needed:
   ```bash
   npx playwright install chromium
   ```

### Test Commands

```bash
# Run all E2E tests in headless mode
pnpm test:e2e

# Run tests with UI mode (interactive)
pnpm test:e2e:ui

# Run tests in headed mode (see browser)
pnpm test:e2e:headed

# Debug tests (opens inspector)
pnpm test:e2e:debug

# View last test report
pnpm test:e2e:report
```

### Running Specific Tests

```bash
# Run only navigation tests
npx playwright test navigation.spec.ts

# Run only segment reconciliation tests
npx playwright test segment-reconciliation.spec.ts

# Run a specific test by name
npx playwright test -g "should perform partial navigation"
```

## What the Tests Verify

### 1. Navigation Tests (`navigation.spec.ts`)

**Document Load vs SPA Navigation:**
- ✅ Initial page load sends full document request (no `_has` parameter)
- ✅ SPA navigation sends partial request with `_has` parameter
- ✅ No full page reload during internal navigation
- ✅ Different source pages send different `_has` parameters

**Segment ID Format:**
- ✅ Segment IDs follow `[LRP]\d+` format (e.g., `L0`, `R2`, `P3`)
- ✅ Requests include both Layout (`L`) and Route (`R`) segments

**Accept Headers:**
- ✅ Initial load sends `text/html` Accept header
- ✅ Partial navigation sends `text/x-component` Accept header

### 2. Segment Reconciliation Tests (`segment-reconciliation.spec.ts`)

**Layout Preservation:**
- ✅ Layout preserved when navigating within same layout group
- ✅ Root layout preserved across all navigations
- ✅ State within layout preserved during navigation

**Layout Replacement:**
- ✅ Layout replaced when navigating to different layout group
- ✅ Old layout components properly unmounted

**Nested Layouts:**
- ✅ Parent layouts preserved when only child changes

**Form State:**
- ✅ Form inputs and other state maintained in layouts

### 3. Navigation Scenarios (`navigation-scenarios.spec.ts`)

**Deep ↔ Shallow Navigation:**
- ✅ `/articles/123` → `/articles` preserves ArticlesLayout
- ✅ `/articles` → `/articles/456` preserves ArticlesLayout

**Same Depth Navigation:**
- ✅ `/dashboard` → `/articles` (different subtrees)
- ✅ `/articles/100` → `/articles/200` (same layout)

**Cross-Layout Navigation:**
- ✅ `/dashboard` → `/articles` replaces layouts correctly
- ✅ `/dashboard/analytics` → `/articles` handles nested→different

**Root-Only Pages:**
- ✅ Navigation to `/about` (only root layout) works correctly
- ✅ Root layout preserved when navigating to root-only pages

**Browser Navigation:**
- ✅ Back button uses partial navigation
- ✅ Forward button uses partial navigation

**Edge Cases:**
- ✅ 404 pages handled gracefully
- ✅ Rapid consecutive navigations work correctly

## Test Utilities

The `rsc-helpers.ts` file provides utilities for:

- **`captureNavigationRequests()`** - Captures all navigation requests during a callback
- **`parseHasParameter()`** - Extracts segment IDs from `_has` parameter
- **`isValidSegmentId()`** - Validates segment ID format
- **`markElement()` / `elementWasPreserved()`** - Track element preservation across renders
- **`waitForConsoleLog()`** - Wait for specific console output
- **`getPartialRequests()`** - Filter for partial RSC requests

## Debugging Tests

### Visual Inspection

Run tests in headed mode to see the browser:
```bash
pnpm test:e2e:headed
```

### Interactive Debugging

Use UI mode for the best debugging experience:
```bash
pnpm test:e2e:ui
```

This opens an interactive interface where you can:
- Step through tests
- View network requests
- Inspect the DOM
- See console logs
- View screenshots

### Console Logs

Tests capture console logs from the application. You can add `console.log()` statements in your router code and they'll be visible during test runs.

### Network Inspection

The test utilities capture all navigation requests, including:
- Request URL
- `_has` parameter value
- Accept headers
- Whether it's a document or partial request

## Expected Behavior Summary

| Scenario | `_has` Parameter | Full Reload? | Layouts |
|----------|-----------------|--------------|---------|
| Initial page load | ❌ No | ✅ Yes | All rendered |
| SPA navigation | ✅ Yes | ❌ No | Differential |
| Same layout nav | ✅ Yes | ❌ No | Preserved |
| Cross-layout nav | ✅ Yes | ❌ No | Replaced |
| Browser back/forward | ✅ Yes* | ❌ No | From cache |

*May use cache depending on browser

## Troubleshooting

### Tests Timing Out

If tests timeout, check:
1. Is the dev server running on port 5173?
2. Are the routes properly configured in `routes.tsx`?
3. Do layouts have `data-layout` attributes?

### Layout Preservation Tests Failing

Ensure all layout components have the `data-layout` attribute:
- `RootLayout.tsx` → `data-layout="root"`
- `DashboardLayout.tsx` → `data-layout="dashboard"`
- `ArticlesLayout.tsx` → `data-layout="articles"`

### Network Request Tests Failing

Check that:
1. Router is sending `_has` parameter on partial navigations
2. Server is reading `_has` from query params
3. Response has correct `Content-Type: text/x-component`

## Adding New Tests

When adding new tests:

1. **Use the test utilities** - Don't re-implement request tracking
2. **Follow the pattern** - Look at existing tests for structure
3. **Test one thing** - Keep tests focused and atomic
4. **Add descriptive names** - Test names should clearly state what they verify
5. **Clean up state** - Each test should be independent

Example:
```typescript
test('should preserve layout when navigating within same group', async ({ page }) => {
  // Navigate to initial page
  await page.goto('/articles');
  await page.waitForLoadState('networkidle');

  // Mark layout to track preservation
  await markElement(page, '[data-layout="articles"]', 'test');

  // Perform navigation
  await page.click('a[href="/articles/123"]');
  await page.waitForURL('/articles/123');

  // Verify layout was preserved
  const preserved = await elementWasPreserved(
    page,
    '[data-layout="articles"]',
    'test'
  );
  expect(preserved).toBe(true);
});
```

## CI Integration

To run tests in CI:

```bash
# Run tests in CI mode (with retries, no parallelization)
CI=1 pnpm test:e2e
```

The tests are configured to:
- Retry failed tests 2 times in CI
- Run sequentially (not in parallel)
- Generate HTML reports
- Take screenshots on failure

## Resources

- [Playwright Documentation](https://playwright.dev)
- [RSC Router Documentation](../packages/rsc-router/README.md)
- [Test Utilities Source](./e2e/utils/rsc-helpers.ts)
