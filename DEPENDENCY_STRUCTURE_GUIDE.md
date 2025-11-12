# Detailed Dependency & Structure Reference Guide

## Directory Tree with File Counts

```
vite-rsc/ (monorepo root)
├── apps/
│   └── web/ (Main application)
│       ├── package.json (depends on: rsc-router via workspace:*)
│       ├── src/
│       │   ├── layouts/
│       │   ├── pages/
│       │   ├── components/
│       │   ├── framework/
│       │   ├── assets/
│       │   └── *.tsx (components)
│       └── tsconfig.json
│
├── packages/
│   └── rsc-router/ (Core library - TEMPLATE for host-router)
│       ├── package.json (no build, exports src/)
│       ├── tsconfig.json (extends base)
│       ├── vitest.config.ts (unit tests, 80% coverage)
│       ├── playwright.config.ts (e2e tests)
│       ├── eslint.config.js (v9 flat config)
│       ├── .prettierrc
│       ├── src/
│       │   ├── index.ts (main entry - exports all)
│       │   ├── types.ts
│       │   ├── router.tsx
│       │   ├── create-router.ts
│       │   ├── segments.ts
│       │   ├── segment-system.tsx
│       │   ├── matcher.ts
│       │   ├── linear-matcher.ts
│       │   ├── route-definition.ts
│       │   ├── client.ts
│       │   ├── server.ts
│       │   ├── Link.tsx
│       │   ├── Outlet.tsx
│       │   ├── framework/
│       │   │   ├── index.ts
│       │   │   ├── entry.browser.tsx
│       │   │   ├── entry.rsc.tsx
│       │   │   ├── entry.ssr.tsx
│       │   │   ├── storage.ts
│       │   │   ├── types.ts
│       │   │   └── utils/
│       │   └── __tests__/ (34 test files)
│       │       ├── setup.ts
│       │       ├── sanity.test.ts
│       │       ├── router-match.test.tsx
│       │       ├── segment-reconciliation.test.tsx
│       │       ├── client-navigation.test.tsx
│       │       └── ... (31 more tests)
│       ├── tests/
│       │   └── e2e/ (11 e2e test files)
│       │       ├── navigation.spec.ts
│       │       ├── spa-navigation.spec.ts
│       │       ├── partial-rendering.spec.ts
│       │       └── ...
│       ├── e2e/
│       │   ├── fixtures/
│       │   │   └── test-app/ (test application)
│       │   ├── helpers.ts
│       │   └── README.md
│       ├── examples/
│       │   └── basic/ (example app)
│       └── README.md
│
├── pnpm-workspace.yaml (workspace definition)
├── package.json (root, turbo scripts)
├── turbo.json (build orchestration)
├── tsconfig.base.json (shared config)
└── node_modules/ (hoisted by pnpm)
```

---

## Dependency Flow Diagram

```
apps/web (private app)
    |
    ├─ depends on ──> rsc-router (workspace:*)
    |
    └─ devDependencies:
         - @vitejs/plugin-react
         - @vitejs/plugin-rsc
         - vite
         - typescript

rsc-router (library package)
    |
    ├─ peerDependencies:
    |   - react ^18 || ^19
    |   - react-dom ^18 || ^19
    |
    └─ devDependencies:
        ├─ typescript
        ├─ vitest (unit tests)
        ├─ @vitejs/plugin-react
        ├─ @vitejs/plugin-rsc
        ├─ playwright (e2e tests)
        ├─ eslint
        ├─ prettier
        └─ happy-dom (test environment)

Root (monorepo)
    |
    ├─ pnpm (package manager)
    ├─ turbo (build orchestration)
    └─ typescript (shared)
```

---

## Package.json Key Patterns

### Root Level Pattern
```json
{
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "turbo run dev",      // Runs dev in all workspaces
    "build": "turbo run build",  // Runs build in all workspaces
    "lint": "turbo run lint"     // Lints all workspaces
  }
}
```

### Library Package Pattern (rsc-router)
```json
{
  "main": "./src/index.ts",        // Direct TypeScript source
  "module": "./src/index.ts",      // No separate CJS/ESM builds
  "types": "./src/index.ts",       // TypeScript is the source
  "exports": { ".": "./src/index.ts" },
  "files": ["src"],                // Only src/ in distribution
  "scripts": {
    "type-check": "tsc --noEmit",  // Type checking only
    "test": "vitest run",          // Unit tests
    "test:e2e": "playwright test", // E2E tests
    "lint": "eslint src",
    "format": "prettier"
  }
}
```

### App Package Pattern (apps/web)
```json
{
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "rsc-router": "workspace:*"  // Workspace protocol
  }
}
```

---

## Build Pipeline & Task Dependencies (Turbo)

```
Execution Order (from turbo.json):

1. Global level:
   $ pnpm dev         ──> turbo run dev
   $ pnpm build       ──> turbo run build
   $ pnpm lint        ──> turbo run lint
   $ pnpm type-check  ──> turbo run type-check

2. Build task dependencies:
   └─ build
       └─ ^build (dependencies' builds first)
       └─ outputs: dist/**

3. Lint task dependencies:
   └─ lint
       └─ ^build (requires deps to be built first)

4. Type-check dependencies:
   └─ type-check
       └─ ^build (requires deps to be built first)

5. Dev task:
   └─ dev
       └─ cache: false (never cached)
       └─ persistent: true (runs continuously)

6. Preview task:
   └─ preview
       └─ build (requires build task first)
```

---

## TypeScript Configuration Hierarchy

```
tsconfig.base.json (root)
    ├── target: ES2020
    ├── module: ESNext
    ├── strict: true
    ├── jsx: react-jsx
    └── moduleResolution: bundler
         |
         └──> tsconfig.json (each package)
                 └─ extends: ../../tsconfig.base.json
                 ├─ outDir: ./dist
                 ├─ declaration: true
                 ├─ declarationMap: true
                 └─ noUnusedLocals: true
```

---

## Test Configuration Hierarchy

### Vitest (Unit Tests)
```
vitest.config.ts (per package)
    ├─ environment: happy-dom (virtual DOM)
    ├─ setupFiles: src/__tests__/setup.ts
    ├─ coverage:
    │   ├─ provider: v8
    │   └─ thresholds: 80% all metrics
    ├─ testMatch: src/**/*.{test,spec}.{ts,tsx}
    └─ resolve.alias:
        └─ 'rsc-router': '/src/index.ts'

src/__tests__/
    ├─ setup.ts (global test setup)
    ├─ 34 test files
    │   ├─ Core functionality tests
    │   ├─ Integration tests
    │   ├─ Segment system tests
    │   └─ Navigation tests
    └─ __fixtures__/ (test data)
```

### Playwright (E2E Tests)
```
playwright.config.ts (per package)
    ├─ testDir: ./tests/e2e
    ├─ workers: 1 (single worker, no parallelization)
    ├─ baseURL: http://localhost:5173
    ├─ webServer:
    │   ├─ command: pnpm dev
    │   ├─ cwd: ../../apps/web
    │   └─ reuseExistingServer: true
    └─ projects: [chromium]

tests/e2e/
    ├─ 11 test files
    │   ├─ navigation.spec.ts
    │   ├─ spa-navigation.spec.ts
    │   ├─ rsc-streaming.spec.ts
    │   └─ ...
    ├─ helpers.ts
    └─ fixtures/
        └─ test-app/ (test fixture app)
```

---

## File Distribution Strategy

### What Gets Published (rsc-router example)

```
npm package contents (defined by "files": ["src"]):

rsc-router/
├── package.json
├── src/
│   ├── index.ts (main entry point)
│   ├── types.ts
│   ├── router.tsx
│   ├── client.ts
│   ├── ... (all source files)
│   └── framework/
│       └── ... (framework sources)
│
├── NOT included:
│   ├── __tests__/ (excluded)
│   ├── e2e/ (excluded)
│   ├── dist/ (excluded)
│   ├── node_modules/ (excluded)
│   └── test-results/ (excluded)

At import time:
    consumers/ src/
        └─ import { Router } from 'rsc-router'
            └─ resolves to: packages/rsc-router/src/index.ts
            └─ build tool transpiles .ts/.tsx to .js
            └─ consumer's tsconfig applies
```

---

## Code Quality Configuration Stack

### ESLint (Modern Flat Config v9)

```
eslint.config.js
    ├─ Base Rules
    │   └─ js.configs.recommended
    │
    ├─ TypeScript Rules
    │   ├─ Plugin: @typescript-eslint
    │   ├─ Parser: @typescript-eslint/parser
    │   ├─ Rules:
    │   │   ├─ no-explicit-any: warn
    │   │   ├─ no-unused-vars: error (except _ prefix)
    │   │   └─ ... (TypeScript specific)
    │   └─ Settings: tsconfig.json reference
    │
    ├─ React Rules
    │   ├─ Plugin: eslint-plugin-react
    │   ├─ Rules:
    │   │   ├─ react-in-jsx-scope: off
    │   │   ├─ prop-types: off (using TS)
    │   │   └─ display-name: warn
    │   └─ Settings: React.version detect
    │
    ├─ React Hooks Rules
    │   ├─ Plugin: eslint-plugin-react-hooks
    │   └─ Rules: standard hooks rules
    │
    ├─ General Rules
    │   ├─ no-console: warn
    │   ├─ prefer-const: error
    │   └─ no-var: error
    │
    ├─ Test File Overrides
    │   ├─ Files: **/*.test.ts(x)
    │   ├─ no-explicit-any: off
    │   └─ no-console: off
    │
    └─ Prettier Config (last)
        └─ eslint-config-prettier (disables conflicting rules)
```

### Prettier

```
.prettierrc
    ├─ semi: true
    ├─ singleQuote: true
    ├─ trailingComma: es5
    ├─ printWidth: 80
    ├─ tabWidth: 2
    ├─ arrowParens: always
    └─ endOfLine: lf
```

---

## Source File Organization Pattern

### Index File Strategy (rsc-router/src/index.ts)

```typescript
// Types (re-exported)
export * from './types';
export * from './route-definition';

// Core functionality
export * from './router';
export * from './create-router';
export * from './segments';
export * from './matcher';
export * from './linear-matcher';

// Utilities (selective export)
export {
  generateSegmentId,
  parseSegmentId,
  // ... only specific utilities
} from './segment-system';

// Components
export { Link } from './Link';
export type { LinkProps } from './Link';
export { Outlet, OutletProvider, useOutlet } from './Outlet';

// Client utilities
export { SegmentStore, navigateToRoute } from './client';
```

Key patterns:
- Barrel files use `export *` or selective exports
- Type exports are separate (`export type { ... }`)
- Components can have both named and type exports
- Central index.ts controls public API
- Client/server utilities separated if needed

---

## Workspace Resolution Process

```
When building apps/web:

1. Vite encounters:
   import { Router } from 'rsc-router'

2. pnpm workspace resolution:
   rsc-router → workspace:* → packages/rsc-router/package.json

3. package.json points to:
   main: ./src/index.ts

4. Vite/build tool resolves:
   → packages/rsc-router/src/index.ts

5. Build tool transpiles:
   .ts/.tsx files → .js using Vite's React plugin

6. Result:
   apps/web can import from rsc-router as if it were npm package
   No publish/install cycle needed
```

---

## Summary: Key Patterns for host-router

1. **Package.json** - Point main/module/types to src/index.ts
2. **tsconfig.json** - Extend base, add strict options
3. **vitest.config.ts** - happy-dom, 80% coverage thresholds
4. **playwright.config.ts** - Point to apps/web dev server
5. **index.ts** - Export public API with barrel pattern
6. **src/__tests__/** - Colocate unit tests
7. **tests/e2e/** - E2E tests against real app
8. **.eslintrc.js** - Modern flat config with React/TS
9. **.prettierrc** - Consistent formatting rules
10. **Workspace reference** - Use `"host-router": "workspace:*"` in consumers
