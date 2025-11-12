# host-router Package Setup Checklist

Use this checklist when creating the `packages/host-router` package based on the `rsc-router` template.

## Phase 1: Directory Structure

- [ ] Create `packages/host-router/` directory
- [ ] Create `packages/host-router/src/` directory
- [ ] Create `packages/host-router/src/__tests__/` directory
- [ ] Create `packages/host-router/tests/` directory
- [ ] Create `packages/host-router/tests/e2e/` directory
- [ ] Create `packages/host-router/e2e/` directory
- [ ] Create `packages/host-router/e2e/fixtures/` directory
- [ ] Create `packages/host-router/e2e/fixtures/test-app/` directory (test application)
- [ ] Create `packages/host-router/examples/` directory (optional)
- [ ] Create `packages/host-router/examples/basic/` directory (optional)

## Phase 2: Configuration Files

### Core Package Configuration
- [ ] Create `packages/host-router/package.json`
  - [ ] Set name to "host-router"
  - [ ] Set version to "0.0.1"
  - [ ] Set type to "module"
  - [ ] Point main/module/types to "./src/index.ts"
  - [ ] Set exports.".": "./src/index.ts"
  - [ ] Set files: ["src"]
  - [ ] Add scripts (see template below)
  - [ ] Add peerDependencies (React 18/19)
  - [ ] Add devDependencies (from rsc-router template)

### TypeScript Configuration
- [ ] Create `packages/host-router/tsconfig.json`
  - [ ] Extends "../../tsconfig.base.json"
  - [ ] Add strict compiler options
  - [ ] Add declaration and declarationMap

### Code Quality
- [ ] Create `packages/host-router/eslint.config.js`
  - [ ] Copy and adapt from rsc-router/eslint.config.js
  - [ ] Adjust rules as needed for host-router
- [ ] Create `packages/host-router/.prettierrc`
  - [ ] Copy from rsc-router/.prettierrc

### Build & Test Configurations
- [ ] Create `packages/host-router/vitest.config.ts`
  - [ ] Configure happy-dom environment
  - [ ] Set 80% coverage thresholds
  - [ ] Point setupFiles to src/__tests__/setup.ts
- [ ] Create `packages/host-router/playwright.config.ts`
  - [ ] Point testDir to tests/e2e
  - [ ] Configure webServer to point to apps/web
  - [ ] Set baseURL to http://localhost:5173

### Ignore Files
- [ ] Create `packages/host-router/.gitignore`
  - [ ] node_modules/
  - [ ] dist/
  - [ ] coverage/
  - [ ] .turbo/
  - [ ] test-results/

## Phase 3: Source Code

### Main Entry Point
- [ ] Create `packages/host-router/src/index.ts`
  - [ ] Export all public types
  - [ ] Export all core functionality
  - [ ] Export React components (if applicable)
  - [ ] Export client utilities

### Core Types
- [ ] Create `packages/host-router/src/types.ts`
  - [ ] Define public API types
  - [ ] Ensure proper type exports

### Core Functionality (minimum)
- [ ] Create `packages/host-router/src/core.ts` (or module-specific files)
  - [ ] Implement core functionality
  - [ ] Use TypeScript strict mode
  - [ ] Add JSDoc comments for public APIs

### React Components (if applicable)
- [ ] Create `packages/host-router/src/components.tsx`
  - [ ] Use 'use client' directive if needed
  - [ ] Export React components

### Utilities
- [ ] Create `packages/host-router/src/utils.ts`
  - [ ] Add helper functions
  - [ ] Keep utilities focused and reusable

### Framework Integration (if needed)
- [ ] Create `packages/host-router/src/framework/` directory (optional)
  - [ ] Create framework-specific entry points
  - [ ] RSC/SSR/browser entry points if needed

## Phase 4: Tests

### Unit Test Setup
- [ ] Create `packages/host-router/src/__tests__/setup.ts`
  - [ ] Copy from rsc-router and adapt
  - [ ] Set up global test environment

### Unit Tests
- [ ] Create `packages/host-router/src/__tests__/*.test.ts(x)`
  - [ ] One test file per source module
  - [ ] Follow naming pattern: module.test.ts
  - [ ] Aim for 80%+ coverage
  - [ ] Test edge cases and error scenarios

Example test structure:
```
src/__tests__/
├── setup.ts
├── types.test.ts
├── core.test.ts
├── components.test.tsx
├── utils.test.ts
└── __fixtures__/ (test data)
```

### E2E Test Helpers
- [ ] Create `packages/host-router/tests/e2e/helpers.ts`
  - [ ] Create utility functions for E2E tests
  - [ ] Page object models if applicable

### E2E Tests
- [ ] Create `packages/host-router/tests/e2e/*.spec.ts`
  - [ ] Critical path tests
  - [ ] Integration tests
  - [ ] Follow naming pattern: feature.spec.ts

Example E2E test structure:
```
tests/e2e/
├── helpers.ts
├── basic.spec.ts
├── integration.spec.ts
└── error-handling.spec.ts
```

### E2E Test Fixture
- [ ] Create `packages/host-router/e2e/fixtures/test-app/package.json`
  - [ ] Minimal test app package
  - [ ] Imports host-router
- [ ] Create test app source files as needed

## Phase 5: Documentation

- [ ] Create `packages/host-router/README.md`
  - [ ] Package overview
  - [ ] Installation instructions
  - [ ] Basic usage examples
  - [ ] API documentation
  - [ ] Testing instructions

- [ ] Create `packages/host-router/e2e/README.md` (if complex)
  - [ ] E2E test setup instructions
  - [ ] How to run E2E tests
  - [ ] Debugging E2E tests

## Phase 6: Integration with Monorepo

### Update Root Files
- [ ] Verify `pnpm-workspace.yaml` includes "packages/*"
  - [ ] Already configured - no changes needed

- [ ] Verify `turbo.json` has proper task definitions
  - [ ] Already configured - no changes needed

### Update Consumer Apps/Packages
- [ ] Add host-router dependency to `apps/web/package.json`
  ```json
  {
    "dependencies": {
      "host-router": "workspace:*"
    }
  }
  ```

- [ ] Update imports in consuming app:
  ```typescript
  import { HostRouter, ... } from 'host-router';
  ```

## Phase 7: Verification & Testing

- [ ] Run `pnpm install` to link workspace dependencies
- [ ] Run `pnpm type-check` to verify TypeScript
  - [ ] Expected: no errors
- [ ] Run `pnpm lint` to verify code quality
  - [ ] Expected: no ESLint errors
- [ ] Run `pnpm test` to run unit tests
  - [ ] Expected: all tests pass
  - [ ] Expected: 80%+ coverage
- [ ] Run `pnpm build` to verify package builds
  - [ ] Expected: works (no actual build, just type-check)
- [ ] Run `pnpm test:e2e` to run E2E tests
  - [ ] Expected: all tests pass
- [ ] Test imports in consuming app
  - [ ] Import should resolve correctly
  - [ ] No type errors

## Phase 8: CI/CD Setup (if applicable)

- [ ] Add host-router to CI test matrix
- [ ] Add host-router to coverage reports
- [ ] Add host-router to linting pipeline

## Template: package.json

```json
{
  "name": "host-router",
  "version": "0.0.1",
  "license": "MIT",
  "type": "module",
  "main": "./src/index.ts",
  "module": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "files": ["src"],
  "scripts": {
    "type-check": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:headed": "playwright test --headed",
    "test:e2e:debug": "playwright test --debug",
    "test:e2e:report": "playwright show-report",
    "test:all": "pnpm test && pnpm test:e2e",
    "lint": "eslint src --ext .ts,.tsx",
    "lint:fix": "eslint src --ext .ts,.tsx --fix",
    "format": "prettier --write \"src/**/*.{ts,tsx,json,md}\"",
    "format:check": "prettier --check \"src/**/*.{ts,tsx,json,md}\"",
    "quality": "pnpm type-check && pnpm lint && pnpm format:check && pnpm test:all"
  },
  "peerDependencies": {
    "react": "^18.0.0 || ^19.0.0",
    "react-dom": "^18.0.0 || ^19.0.0"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.1",
    "@playwright/test": "^1.56.1",
    "@types/react": "^19.2.2",
    "@types/react-dom": "^19.2.2",
    "@typescript-eslint/eslint-plugin": "^8.18.1",
    "@typescript-eslint/parser": "^8.18.1",
    "@vitejs/plugin-react": "^4.3.4",
    "@vitest/coverage-v8": "^2.1.8",
    "@vitest/ui": "^2.1.8",
    "eslint": "^9.17.0",
    "eslint-config-prettier": "^9.1.0",
    "eslint-plugin-react": "^7.37.3",
    "eslint-plugin-react-hooks": "^5.1.0",
    "happy-dom": "^15.11.7",
    "playwright": "^1.56.1",
    "prettier": "^3.4.2",
    "typescript": "^5.7.3",
    "vite": "^7.1.10",
    "vitest": "^2.1.8"
  }
}
```

## Key Files from rsc-router to Copy/Adapt

1. `packages/rsc-router/package.json` - Use as template
2. `packages/rsc-router/tsconfig.json` - Copy directly
3. `packages/rsc-router/eslint.config.js` - Copy and review
4. `packages/rsc-router/.prettierrc` - Copy directly
5. `packages/rsc-router/vitest.config.ts` - Copy and adapt
6. `packages/rsc-router/playwright.config.ts` - Copy and adapt
7. `packages/rsc-router/src/__tests__/setup.ts` - Copy and adapt

## Notes

- No build step needed (TypeScript files consumed directly)
- Use `workspace:*` protocol for pnpm workspace references
- Colocate tests with source code in `__tests__/` directories
- Strict TypeScript configuration enabled
- 80% coverage threshold for unit tests
- ESLint v9 flat config format (modern)
- Always run `pnpm quality` before committing

